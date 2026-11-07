import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { insertStudy } from '../src/lib/server/studies.js';
import { appendRecording, configureRecording, getRecording } from '../src/lib/server/recordings.js';
import {
	DEFAULT_STORAGE_SETTINGS,
	normalizeStorageSettings,
	getStorageSettings,
	getStorageConnection,
	saveStorageSettings,
	storageDestination
} from '../src/lib/server/storage-settings.js';
import {
	archiveAudio,
	withAudioFile,
	withRecordingAudio,
	readStoredAudio
} from '../src/lib/server/storage-audio.js';
import {
	processStorageJob,
	clearStorageJobLog,
	queueStorageReset,
	cancelStorageJob,
	pauseAndCancelStorageJobs,
	queueStorageJob,
	scheduleStorageJobs,
	storageStatus
} from '../src/lib/server/storage-worker.js';

import { resetStorageData } from '../src/lib/server/storage-reset.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const now = 1800000000;
function fixture(t) {
	const key = process.env.STORAGE_ENCRYPTION_KEY;
	process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
	const db = new Database(':memory:');
	initializeSchema(db, schema);
	db.exec(
		"INSERT INTO modalities VALUES(1,'MR','MRI'); INSERT INTO exam_types VALUES(1,'BRAIN','Brain'); INSERT INTO users(id,full_name,role) VALUES(1,'Synthetic resident','resident'),(2,'Synthetic attending','attending'); INSERT INTO report_templates(modality_id,exam_type_id,text) VALUES(1,1,'Synthetic template')"
	);
	const studyId = insertStudy(db, {
		patient_code: 'storage-test',
		patient_firstname: 'Synthetic',
		patient_lastname: 'Fixture',
		exam_date_jalali: '1405-01-01',
		exam_time: '10:00',
		corresponding_resident_id: 1,
		corresponding_attending_id: 2
	});
	const directory = mkdtempSync(join(tmpdir(), 'radiology-storage-test-'));
	const audio = join(directory, 'audio.ogg');
	writeFileSync(audio, 'synthetic audio');
	const recording = appendRecording(db, studyId, audio);
	configureRecording(db, studyId, recording.id, {
		modality_id: 1,
		exam_type_id: 1,
		corresponding_resident_id: 1
	});
	db.prepare("UPDATE study_recordings SET created_at='2000-01-01 00:00:00' WHERE id=?").run(
		recording.id
	);
	const settings = {
		...DEFAULT_STORAGE_SETTINGS,
		enabled: true,
		archiveEnabled: true,
		backupsEnabled: true,
		host: 'storage.invalid',
		username: 'synthetic',
		root: '/radiology',
		fingerprint: `SHA256:${'a'.repeat(43)}`
	};
	saveStorageSettings(db, settings, 'synthetic-password');
	const objects = new Map();
	const client = {
		async mkdir() {},
		async put(local, remote) {
			objects.set(remote, readFileSync(local));
		},
		async get(remote, local) {
			if (!objects.has(remote)) throw new Error('Synthetic unavailable object');
			await writeFile(local, objects.get(remote));
		},
		async delete(remote) {
			objects.delete(remote);
		},
		async lstat(path) {
			return objects.has(path)
				? { isFile: true, isSymbolicLink: false }
				: { isDirectory: true, isSymbolicLink: false };
		},
		createReadStream(path) {
			return Readable.from([objects.get(path) ?? Buffer.alloc(0)]);
		}
	};
	const transport = async (connection, action) => action(client);
	const options = { now, roots: [directory], transport };
	t.after(() => {
		db.close();
		rmSync(directory, { recursive: true, force: true });
		if (key === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
		else process.env.STORAGE_ENCRYPTION_KEY = key;
	});
	return {
		db,
		directory,
		audio,
		recording,
		studyId,
		settings,
		connection: getStorageConnection(db),
		objects,
		client,
		transport,
		options
	};
}

function backupCompleted(db, startedAt = now + 1) {
	db.prepare(
		"INSERT INTO storage_jobs(kind,status,created_at,started_at,finished_at,attempts) VALUES('full','succeeded',?,?,?,1)"
	).run(startedAt, startedAt, startedAt + 1);
}

test('storage settings are disabled by default, validated and credentials encrypted without password echoes', (t) => {
	const { db, settings } = fixture(t);
	assert.equal(DEFAULT_STORAGE_SETTINGS.enabled, false);
	assert.equal(getStorageConnection(db).password, 'synthetic-password');
	assert.ok(!JSON.stringify(getStorageSettings(db)).includes('password'));
	assert.ok(
		!db
			.prepare("SELECT value FROM application_settings WHERE key='storage_password'")
			.get()
			.value.includes('synthetic-password')
	);
	saveStorageSettings(db, { ...settings, localRetentionDays: 45 });
	assert.equal(getStorageConnection(db).password, 'synthetic-password');
	for (const input of [
		{ localRetentionDays: 0 },
		{ fileBackupHour: 24 },
		{ hourlyRetention: 0 },
		{ enabled: 'true' },
		{ root: '/' },
		{ root: '/a/../b' },
		{ host: 'https://storage.invalid' },
		{ fingerprint: 'wrong' },
		{ password: 'not-a-public-setting' }
	]) {
		assert.throws(() => normalizeStorageSettings({ ...settings, ...input }));
	}
	assert.equal(
		normalizeStorageSettings({ ...settings, fingerprint: `${settings.fingerprint}=` }).fingerprint,
		settings.fingerprint
	);
});

test('schema is repeatable and schedules/password can change but an in-use destination cannot', (t) => {
	const { db, settings } = fixture(t);
	initializeSchema(db, schema);
	backupCompleted(db);
	assert.throws(() => saveStorageSettings(db, { ...settings, root: '/different' }), /in use/);
	saveStorageSettings(db, { ...settings, dailyRetention: 60 }, 'rotated-synthetic');
	assert.equal(getStorageConnection(db).password, 'rotated-synthetic');
	db.prepare("INSERT INTO storage_jobs(kind,status,created_at) VALUES('archive','running',?)").run(
		now
	);
	assert.throws(() => saveStorageSettings(db, settings), /running/);
});

test('audio archive is encrypted, verified and independent backup is required before local eviction', async (t) => {
	const { db, audio, connection, objects, options, transport } = fixture(t);
	assert.deepEqual(await archiveAudio(db, connection, options), { copied: 1, evicted: 0 });
	assert.ok(existsSync(audio));
	assert.equal(objects.size, 1);
	assert.ok(![...objects.values()][0].includes(Buffer.from('synthetic audio')));
	assert.equal(
		db.prepare('SELECT destination FROM storage_audio').get().destination,
		storageDestination(connection)
	);
	backupCompleted(db, now);
	assert.deepEqual(await archiveAudio(db, connection, { ...options, now: now + 1 }), {
		copied: 0,
		evicted: 0
	});
	assert.ok(existsSync(audio));
	backupCompleted(db);
	assert.deepEqual(await archiveAudio(db, connection, { ...options, now: now + 2 }), {
		copied: 0,
		evicted: 1
	});
	assert.equal(existsSync(audio), false);
	assert.equal(String(await readStoredAudio(db, audio, { transport })), 'synthetic audio');
	let temporary;
	await assert.rejects(
		withAudioFile(
			db,
			audio,
			async (local) => {
				temporary = local;
				assert.ok(existsSync(local));
				throw new Error('Synthetic callback failure');
			},
			{ transport }
		),
		/callback failure/
	);
	assert.equal(existsSync(temporary), false);
});

test('failed archive upload, corrupt remote object and changed local source never evict original audio', async (t) => {
	const context = fixture(t);
	const { db, audio, connection, client, options, objects } = context;
	const put = client.put;
	client.put = async () => {
		throw new Error('Synthetic transfer failure');
	};
	await assert.rejects(archiveAudio(db, connection, options));
	assert.ok(existsSync(audio));
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 0);
	client.put = put;
	await archiveAudio(db, connection, options);
	backupCompleted(db);
	const remote = [...objects.keys()][0];
	objects.set(remote, Buffer.from('corrupted'));
	await assert.rejects(
		archiveAudio(db, connection, { ...options, now: now + 2 }),
		/verification failed/
	);
	assert.ok(existsSync(audio));
	writeFileSync(audio, 'changed locally');
	await assert.rejects(archiveAudio(db, connection, { ...options, now: now + 2 }), /changed/);
	assert.ok(existsSync(audio));
});

test('processing audio stays local and archived retrieval rejects tampering and deleted references', async (t) => {
	const { db, audio, recording, connection, options, objects, transport } = fixture(t);
	await archiveAudio(db, connection, options);
	backupCompleted(db);
	db.prepare('UPDATE study_recordings SET processing=1 WHERE id=?').run(recording.id);
	await archiveAudio(db, connection, { ...options, now: now + 2 });
	assert.ok(existsSync(audio));
	db.prepare('UPDATE study_recordings SET processing=0 WHERE id=?').run(recording.id);
	await archiveAudio(db, connection, { ...options, now: now + 2 });
	const remote = [...objects.keys()][0];
	const valid = objects.get(remote);
	objects.set(remote, Buffer.from('tampered'));
	await assert.rejects(readStoredAudio(db, audio, { transport }), /verification/);
	objects.set(remote, valid);
	db.prepare('DELETE FROM study_recordings WHERE id=?').run(recording.id);
	await assert.rejects(readStoredAudio(db, audio, { transport }), /not found/);
	objects.set('/radiology/backups/object', Buffer.from('independent recovery fixture'));
	await archiveAudio(db, connection, options);
	assert.equal(objects.has(remote), false);
	assert.equal(objects.has('/radiology/backups/object'), true);
});

test('local-first retrieval and hydration preserve recording metadata and clean downloaded parts', async (t) => {
	const { db, audio, recording, studyId, connection, options, transport } = fixture(t);
	assert.equal(
		String(
			await readStoredAudio(db, audio, {
				transport: () => {
					throw new Error('Network must not be used');
				}
			})
		),
		'synthetic audio'
	);
	await archiveAudio(db, connection, options);
	unlinkSync(audio);
	let temporary;
	await withRecordingAudio(
		db,
		getRecording(db, studyId, recording.id),
		async (hydrated) => {
			temporary = hydrated.audio_parts[0].audio_report_path;
			assert.notEqual(temporary, audio);
			assert.equal(hydrated.audio_report_path, temporary);
			assert.equal(readFileSync(temporary, 'utf8'), 'synthetic audio');
			assert.equal(hydrated.id, recording.id);
		},
		{ transport }
	);
	assert.equal(existsSync(temporary), false);
	assert.equal(getRecording(db, studyId, recording.id).audio_report_path, audio);
});

test('archive sources outside configured roots and lost ownership are rejected without local deletion', async (t) => {
	const { db, audio, connection, options } = fixture(t);
	await assert.rejects(
		archiveAudio(db, connection, { ...options, roots: [join(options.roots[0], 'other')] }),
		/outside/
	);
	await assert.rejects(archiveAudio(db, connection, { ...options, owned: () => false }), /lease/);
	assert.ok(existsSync(audio));
});

test('persistent scheduling deduplicates work, honours pause and derives UTC periods', (t) => {
	const { db, settings } = fixture(t);
	scheduleStorageJobs(db, now);
	scheduleStorageJobs(db, now);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 3);
	assert.equal(
		queueStorageJob(db, 'full'),
		db.prepare("SELECT id FROM storage_jobs WHERE kind='full'").get().id
	);
	saveStorageSettings(db, { ...settings, enabled: false });
	scheduleStorageJobs(db, now + 86400);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 3);
	assert.throws(() => queueStorageJob(db, 'archive'), /Enable/);
	assert.ok(queueStorageJob(db, 'test'));
	const status = storageStatus(db, now);
	assert.ok(status.nextDatabase > now);
	assert.equal(new Date(status.nextFull * 1000).getUTCHours(), settings.fileBackupHour);
	assert.ok(!JSON.stringify(status).includes('synthetic-password'));
});

test('storage worker owns a durable lease, retries failures and resumes interrupted jobs', async (t) => {
	const { db, settings } = fixture(t);
	saveStorageSettings(db, { ...settings, archiveEnabled: false });
	let backups = 0;
	const options = {
		now,
		runBackup: async () => {
			backups++;
			return { id: 'synthetic-snapshot' };
		},
		prune: async () => ({ kept: 1 })
	};
	db.prepare('INSERT INTO storage_worker_lock VALUES(1,?,?)').run('another-owner', now + 10);
	assert.equal(await processStorageJob(db, options), false);
	assert.equal(backups, 0);
	db.prepare('DELETE FROM storage_worker_lock').run();
	await processStorageJob(db, {
		...options,
		runBackup: async () => {
			throw new Error('Do not expose synthetic-secret');
		}
	});
	const failed = db.prepare("SELECT * FROM storage_jobs WHERE kind='full'").get();
	assert.equal(failed.status, 'failed');
	assert.equal(failed.attempts, 1);
	assert.ok(!failed.error.includes('synthetic-secret'));
	assert.ok(failed.retry_at > now);
	queueStorageJob(db, 'full', { now, retryNow: true });
	assert.equal(
		db.prepare('SELECT retry_at FROM storage_jobs WHERE id=?').get(failed.id).retry_at,
		now
	);
	await processStorageJob(db, { ...options, now: failed.retry_at });
	await processStorageJob(db, { ...options, now: failed.retry_at + 1 });
	assert.equal(backups, 2);
	assert.equal(
		db.prepare("SELECT status FROM storage_jobs WHERE kind='full'").get().status,
		'succeeded'
	);
	db.prepare("UPDATE storage_jobs SET status='running' WHERE kind='database'").run();
	await processStorageJob(db, { ...options, now: failed.retry_at + 1 });
	assert.equal(
		db.prepare("SELECT status FROM storage_jobs WHERE kind='database'").get().status,
		'succeeded'
	);
	assert.equal(db.prepare('SELECT * FROM storage_worker_lock').get(), undefined);
});

test('restore preparation is explicitly selected, durable and deduplicated even with services paused', (t) => {
	const { db, settings } = fixture(t);
	saveStorageSettings(db, { ...settings, enabled: false });
	for (const backupId of [null, '', '../outside', '1800000000-' + '-'.repeat(36)])
		assert.throws(() => queueStorageJob(db, 'restore', { backupId }), /valid recovery/);
	const backupId = `${now}-${randomUUID()}`;
	const id = queueStorageJob(db, 'restore', { now, backupId });
	assert.equal(queueStorageJob(db, 'restore', { now, backupId }), id);
	assert.throws(
		() => queueStorageJob(db, 'restore', { backupId: `${now}-${randomUUID()}` }),
		/existing restore/
	);
	assert.equal(
		db.prepare('SELECT backup_id FROM storage_restore_requests WHERE job_id=?').get(id).backup_id,
		backupId
	);
	scheduleStorageJobs(db, now);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 1);
});

test('paused worker prepares a restore without backup pruning or live mutations and retains safe status', async (t) => {
	const { db, settings, audio } = fixture(t);
	saveStorageSettings(db, { ...settings, enabled: false });
	const backupId = `${now}-${randomUUID()}`;
	const restoreId = randomUUID();
	const id = queueStorageJob(db, 'restore', { now, backupId });
	let preparations = 0;
	assert.equal(
		await processStorageJob(db, {
			now,
			prepareRestore: async (connection, options) => {
				preparations++;
				assert.equal(connection.host, settings.host);
				assert.equal(options.backupId, backupId);
				assert.equal(options.owned(), true);
				return { id: backupId, restoreId, files: 3, privateValue: 'must-not-appear' };
			},
			runBackup: async () => assert.fail('Restore must not create backups'),
			prune: async () => assert.fail('Restore must not prune recovery points')
		}),
		true
	);
	assert.equal(preparations, 1);
	assert.equal(
		db.prepare('SELECT status FROM storage_jobs WHERE id=?').get(id).status,
		'succeeded'
	);
	assert.ok(existsSync(audio));
	assert.equal(getStorageSettings(db).enabled, false);
	const status = storageStatus(db, now);
	assert.equal(status.jobs[0].restoreDirectory, `restore-staging/${restoreId}`);
	assert.equal(status.preparedRestores[0].directory, `restore-staging/${restoreId}`);
	assert.ok(!JSON.stringify(status).includes('must-not-appear'));
	for (let index = 0; index < 31; index++)
		db.prepare("INSERT INTO storage_jobs(kind,status,created_at) VALUES('test','succeeded',?)").run(
			now + index
		);
	assert.equal(
		storageStatus(db, now).preparedRestores[0].directory,
		`restore-staging/${restoreId}`
	);
});

test('failed restore preparation sanitizes errors and can be manually retried without changing its target', async (t) => {
	const { db, settings } = fixture(t);
	saveStorageSettings(db, { ...settings, enabled: false });
	const backupId = `${now}-${randomUUID()}`;
	const id = queueStorageJob(db, 'restore', { now, backupId });
	await processStorageJob(db, {
		now,
		prepareRestore: async () => {
			throw new Error('synthetic-private-failure');
		}
	});
	const failed = db.prepare('SELECT * FROM storage_jobs WHERE id=?').get(id);
	assert.equal(failed.status, 'failed');
	assert.ok(!failed.error.includes('synthetic-private-failure'));
	assert.deepEqual(storageStatus(db, now).preparedRestores, []);
	queueStorageJob(db, 'restore', { now: now + 1, backupId, retryNow: true });
	await processStorageJob(db, {
		now: now + 1,
		prepareRestore: async () => ({ id: backupId, restoreId: randomUUID() })
	});
	assert.equal(
		db.prepare('SELECT status FROM storage_jobs WHERE id=?').get(id).status,
		'succeeded'
	);
});

test('restore result cannot publish arbitrary paths or succeed after losing worker ownership', async (t) => {
	const { db, settings } = fixture(t);
	saveStorageSettings(db, { ...settings, enabled: false });
	const backupId = `${now}-${randomUUID()}`;
	const id = queueStorageJob(db, 'restore', { now, backupId });
	await processStorageJob(db, {
		now,
		prepareRestore: async () => ({ id: backupId, restoreId: '../outside' })
	});
	assert.equal(db.prepare('SELECT status FROM storage_jobs WHERE id=?').get(id).status, 'failed');
	queueStorageJob(db, 'restore', { now: now + 1, backupId, retryNow: true });
	await processStorageJob(db, {
		now: now + 1,
		prepareRestore: async () => {
			db.prepare('DELETE FROM storage_worker_lock').run();
			return { id: backupId, restoreId: randomUUID() };
		}
	});
	assert.notEqual(
		db.prepare('SELECT status FROM storage_jobs WHERE id=?').get(id).status,
		'succeeded'
	);
	assert.deepEqual(storageStatus(db, now).preparedRestores, []);
	db.prepare("UPDATE storage_jobs SET status='succeeded',result=? WHERE id=?").run(
		JSON.stringify({ restoreId: '../outside', directory: 'private-path' }),
		id
	);
	assert.deepEqual(storageStatus(db, now).preparedRestores, []);
	assert.equal(storageStatus(db, now).jobs[0].restoreDirectory, null);
});

test('cancelled waiting jobs stay terminal across scheduling, retries and schema reinitialization', async (t) => {
	const { db, settings } = fixture(t);
	saveStorageSettings(db, { ...settings, enabled: false });
	const id = queueStorageJob(db, 'test', { now });
	assert.equal(cancelStorageJob(db, id, { now }), true);
	assert.equal(cancelStorageJob(db, id, { now }), false);
	assert.equal(cancelStorageJob(db, 999999, { now }), false);
	for (const invalid of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])
		assert.throws(() => cancelStorageJob(db, invalid));
	initializeSchema(db, schema);
	assert.equal(storageStatus(db, now).jobs[0].status, 'cancelled');
	assert.equal(storageStatus(db, now).jobs[0].canCancel, false);
	assert.equal(
		await processStorageJob(db, {
			now: now + 86400,
			testConnection: async () => assert.fail('Cancelled job must not run')
		}),
		false
	);
	assert.notEqual(queueStorageJob(db, 'test', { now: now + 1, retryNow: true }), id);
});

test('pause and cancel all preserves credentials and data while cancelling every active kind', async (t) => {
	const { db, audio, settings } = fixture(t);
	const before = db
		.prepare("SELECT value FROM application_settings WHERE key='storage_password'")
		.get().value;
	const ids = ['test', 'archive', 'database', 'full'].map((kind) =>
		queueStorageJob(db, kind, { now })
	);
	ids.push(queueStorageJob(db, 'restore', { now, backupId: `${now}-${randomUUID()}` }));
	db.prepare("UPDATE storage_jobs SET status='failed',attempts=3 WHERE id=?").run(ids[0]);
	backupCompleted(db);
	assert.equal(pauseAndCancelStorageJobs(db, { now }), 5);
	assert.equal(getStorageSettings(db).enabled, false);
	assert.equal(getStorageSettings(db).archiveEnabled, settings.archiveEnabled);
	assert.equal(getStorageSettings(db).backupsEnabled, settings.backupsEnabled);
	assert.equal(
		db.prepare("SELECT value FROM application_settings WHERE key='storage_password'").get().value,
		before
	);
	assert.ok(existsSync(audio));
	assert.equal(storageStatus(db, now).jobs.filter((job) => job.status === 'cancelled').length, 5);
	assert.equal(pauseAndCancelStorageJobs(db, { now }), 0);
	assert.equal(await processStorageJob(db, { now: now + 86400 }), false);
	assert.equal(storageStatus(db, now).jobs.filter((job) => job.status === 'succeeded').length, 1);
	saveStorageSettings(
		db,
		{ ...getStorageSettings(db), enabled: false },
		'synthetic-updated-password'
	);
	assert.equal(getStorageConnection(db).password, 'synthetic-updated-password');
});

test('running cancellation retains the lease and settings guard until cooperative cleanup finishes', async (t) => {
	const { db, settings, audio } = fixture(t);
	saveStorageSettings(db, { ...settings, backupsEnabled: false });
	const id = queueStorageJob(db, 'archive', { now });
	await processStorageJob(db, {
		now,
		runArchive: async (_db, _connection, { owned }) => {
			assert.equal(owned(), true);
			pauseAndCancelStorageJobs(db, { now });
			assert.equal(owned(), false);
			assert.ok(db.prepare('SELECT * FROM storage_worker_lock').get());
			assert.equal(storageStatus(db, now).jobs.find((job) => job.id === id).status, 'cancelling');
			assert.throws(
				() => saveStorageSettings(db, { ...settings, enabled: false }, 'new-password'),
				/running/
			);
			assert.throws(() => queueStorageJob(db, 'archive', { now }), /Enable/);
			return { archived: 0 };
		}
	});
	assert.equal(storageStatus(db, now).jobs.find((job) => job.id === id).status, 'cancelled');
	assert.equal(db.prepare('SELECT * FROM storage_worker_lock').get(), undefined);
	assert.ok(existsSync(audio));
	saveStorageSettings(db, getStorageSettings(db), 'new-password');
	assert.equal(getStorageConnection(db).password, 'new-password');
});

test('running connection-test cancellation cannot publish success or retry and completed jobs cannot be cancelled', async (t) => {
	const { db, settings } = fixture(t);
	saveStorageSettings(db, { ...settings, enabled: false });
	const id = queueStorageJob(db, 'test', { now });
	await processStorageJob(db, {
		now,
		testConnection: async () => {
			cancelStorageJob(db, id, { now });
			assert.throws(() => queueStorageJob(db, 'test'), /cancellation/);
			return { verified: true };
		}
	});
	assert.equal(storageStatus(db, now).jobs[0].status, 'cancelled');
	assert.equal(await processStorageJob(db, { now: now + 3600 }), false);
	const current = Math.floor(Date.now() / 1000);
	const completed = queueStorageJob(db, 'test', { now: current });
	await processStorageJob(db, {
		now: current,
		testConnection: async () => ({ verified: true })
	});
	assert.equal(cancelStorageJob(db, completed), false);
	assert.equal(storageStatus(db, now).jobs[0].status, 'succeeded');
});

test('interrupted cancellations settle after lease expiry even while automatic jobs are paused', async (t) => {
	const { db, settings } = fixture(t);
	const id = queueStorageJob(db, 'archive', { now });
	db.prepare("UPDATE storage_jobs SET status='running',attempts=1 WHERE id=?").run(id);
	db.prepare('INSERT INTO storage_worker_lock VALUES(1,?,?)').run('expired-worker', now - 1);
	pauseAndCancelStorageJobs(db, { now });
	assert.equal(getStorageSettings(db).enabled, false);
	assert.equal(await processStorageJob(db, { now }), false);
	assert.equal(storageStatus(db, now).jobs[0].status, 'cancelled');
	assert.equal(db.prepare('SELECT * FROM storage_worker_lock').get(), undefined);
	assert.equal(
		db.prepare('SELECT finished_at FROM storage_jobs WHERE id=?').get(id).finished_at,
		now
	);
	saveStorageSettings(db, { ...settings, enabled: false });
});

async function importedWith(sourceUrl, overrides) {
	const source = readFileSync(sourceUrl, 'utf8').replace(
		/from (['"])([^'"]+)\1/g,
		(statement, quote, specifier) => {
			const target =
				overrides[specifier] ??
				(specifier.startsWith('.')
					? new URL(specifier, sourceUrl).href
					: import.meta.resolve(specifier));
			return `from ${JSON.stringify(target)}`;
		}
	);
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('archived playback keeps HTTP byte ranges and generation uses hydrated audio without changing stored paths', async (t) => {
	const { db, audio, recording, studyId, connection, options, transport, directory } = fixture(t);
	await archiveAudio(db, connection, options);
	unlinkSync(audio);
	const key = randomUUID();
	globalThis[key] = {
		db,
		readStoredAudio: (db, path) => readStoredAudio(db, path, { transport }),
		withRecordingAudio: (db, recording, action) =>
			withRecordingAudio(db, recording, action, { transport })
	};
	t.after(() => delete globalThis[key]);
	const audioModule = `data:text/javascript,${encodeURIComponent(`export const readStoredAudio=(...args)=>globalThis[${JSON.stringify(key)}].readStoredAudio(...args); export const withRecordingAudio=(...args)=>globalThis[${JSON.stringify(key)}].withRecordingAudio(...args);`)}`;
	const processing = await importedWith(
		new URL('../src/lib/server/recording-processing.js', import.meta.url),
		{ './storage-audio.js': audioModule }
	);
	const http = await importedWith(new URL('../src/lib/server/recording-http.js', import.meta.url), {
		'$lib/server/db': `data:text/javascript,${encodeURIComponent(`export const getDb=()=>globalThis[${JSON.stringify(key)}].db;`)}`,
		'./storage-audio.js': audioModule
	});
	const response = await http.audio({
		params: { id: String(studyId), recordingId: String(recording.id) },
		locals: { user: { id: 2, role: 'attending' } },
		request: new Request('http://localhost/audio', { headers: { range: 'bytes=2-5' } })
	});
	assert.equal(response.status, 206);
	assert.equal(response.headers.get('cache-control'), 'private, no-store');
	assert.equal(await response.text(), 'nthe');
	let hydratedPath;
	const result = await processing.processRecording(
		db,
		studyId,
		recording.id,
		async (context) => {
			hydratedPath = context.audio_parts[0].audio_report_path;
			assert.equal(readFileSync(hydratedPath, 'utf8'), 'synthetic audio');
			return 'Synthetic report.';
		},
		directory
	);
	assert.equal(result.text, 'Synthetic report.');
	assert.equal(existsSync(hydratedPath), false);
	const saved = getRecording(db, studyId, recording.id);
	assert.equal(saved.audio_report_path, audio);
	assert.equal(saved.processing, 0);
	const reportPath = saved.text_report_path;
	globalThis[key].withRecordingAudio = async () => {
		throw new Error('Synthetic storage outage');
	};
	await assert.rejects(
		processing.processRecording(db, studyId, recording.id, async () => 'Must not run', directory),
		/outage/
	);
	assert.equal(getRecording(db, studyId, recording.id).text_report_path, reportPath);
	assert.equal(readFileSync(reportPath, 'utf8'), 'Synthetic report.');
	assert.equal(getRecording(db, studyId, recording.id).processing, 0);
});

function resetFixture(t) {
	const context = fixture(t);
	const { client, objects, connection } = context;
	const folders = new Set(['/', connection.root]);
	client.mkdir = async (path) => {
		for (let current = path; current !== '/'; current = posix.dirname(current))
			folders.add(current);
	};
	client.lstat = async (path) => {
		if (objects.has(path))
			return {
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
				size: objects.get(path).length
			};
		if (folders.has(path)) return { isDirectory: true, isFile: false, isSymbolicLink: false };
		throw Object.assign(new Error('Not found'), { code: 2 });
	};
	client.list = async (path) => [
		...[...objects.keys()]
			.filter((key) => posix.dirname(key) === path)
			.map((key) => ({ name: posix.basename(key), type: '-' })),
		...[...folders]
			.filter((key) => key !== path && posix.dirname(key) === path)
			.map((key) => ({ name: posix.basename(key), type: 'd' }))
	];
	client.rmdir = async (path, recursive) => {
		assert.equal(recursive, false);
		assert.equal((await client.list(path)).length, 0);
		folders.delete(path);
	};
	const resetOptions = { roots: [context.directory], transport: context.transport };
	const run = (at = now) =>
		processStorageJob(context.db, {
			now: at,
			resetStorage: (db, connection, options) =>
				resetStorageData(db, connection, { ...options, ...resetOptions })
		});
	return { ...context, folders, resetOptions, run };
}

test('clearing finished log preserves backup safety metadata and active jobs, including their future results', (t) => {
	const { db, settings } = fixture(t);
	backupCompleted(db);
	const active = queueStorageJob(db, 'archive', { now });
	const failed = queueStorageJob(db, 'test', { now });
	db.prepare("UPDATE storage_jobs SET status='failed',attempts=8 WHERE id=?").run(failed);
	assert.equal(clearStorageJobLog(db), 2);
	assert.equal(clearStorageJobLog(db), 0);
	assert.deepEqual(
		storageStatus(db, now).jobs.map((job) => job.id),
		[active]
	);
	assert.equal(storageStatus(db, now).last.find((row) => row.kind === 'full').at, now + 1);
	assert.throws(() => saveStorageSettings(db, { ...settings, root: '/different' }), /in use/);
	db.prepare("UPDATE storage_jobs SET status='succeeded' WHERE id=?").run(active);
	assert.equal(storageStatus(db, now).jobs[0].status, 'succeeded');
});

test('background job types rotate fairly instead of starving full and database backups behind archives', async (t) => {
	const { db } = fixture(t);
	const current = Math.floor(Date.now() / 1000);
	const calls = [];
	const options = {
		runArchive: async () => {
			calls.push('archive');
			return {};
		},
		runBackup: async (db, connection, { kind }) => {
			calls.push(kind);
			return {};
		},
		prune: async () => ({})
	};
	for (let tick = 0; tick < 6; tick++) {
		const at = current + tick * 61;
		for (const kind of ['archive', 'database', 'full']) queueStorageJob(db, kind, { now: at });
		await processStorageJob(db, { ...options, now: at });
	}
	assert.deepEqual(calls, ['full', 'database', 'archive', 'full', 'database', 'archive']);
});

test('reset rehydrates and verifies archive-only audio before app-only cleanup, preserving live data and credentials', async (t) => {
	const context = resetFixture(t);
	const { db, connection, options, audio, objects, client, folders, run, settings } = context;
	await archiveAudio(db, connection, options);
	unlinkSync(audio);
	db.prepare('UPDATE storage_audio SET evicted_at=?').run(now);
	const password = db
		.prepare("SELECT value FROM application_settings WHERE key='storage_password'")
		.get().value;
	await client.mkdir('/radiology/backups/objects');
	objects.set(`/radiology/backups/objects/${'a'.repeat(64)}.enc`, Buffer.from('old backup'));
	objects.set('/radiology/unrelated.txt', Buffer.from('leave alone'));
	const id = queueStorageReset(db, { now });
	assert.equal(storageStatus(db, now).resetActive, true);
	assert.equal(storageStatus(db, now).jobs[0].kind, 'reset');
	assert.throws(() => queueStorageReset(db, { now }), /wait|Pause/i);
	assert.throws(() => queueStorageJob(db, 'test', { now }), /reset/);
	assert.throws(() => saveStorageSettings(db, settings), /reset/);
	assert.equal(getStorageSettings(db).enabled, false);
	await run();
	assert.equal(readFileSync(audio, 'utf8'), 'synthetic audio');
	assert.equal(objects.size, 1);
	assert.equal(objects.get('/radiology/unrelated.txt').toString(), 'leave alone');
	assert.deepEqual([...folders], ['/', '/radiology']);
	assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storage_audio').get().count, 0);
	assert.equal(db.prepare('SELECT COUNT(*) AS count FROM study_recordings').get().count, 1);
	assert.equal(
		db.prepare("SELECT value FROM application_settings WHERE key='storage_password'").get().value,
		password
	);
	assert.equal(storageStatus(db, now).jobs[0].id, id);
	assert.equal(storageStatus(db, now).jobs[0].status, 'succeeded');
	assert.equal(storageStatus(db, now).resetActive, false);
	assert.equal(getStorageSettings(db).enabled, false);
});

test('reset never deletes remote data or archive tracking when recovered ciphertext is corrupt', async (t) => {
	const { db, connection, options, audio, objects, run } = resetFixture(t);
	await archiveAudio(db, connection, options);
	unlinkSync(audio);
	const remote = [...objects.keys()][0];
	objects.set(remote, Buffer.from('corrupted ciphertext'));
	queueStorageReset(db, { now });
	await run();
	assert.equal(existsSync(audio), false);
	assert.equal(objects.size, 1);
	assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storage_audio').get().count, 1);
	assert.equal(storageStatus(db, now).jobs[0].status, 'failed');
	assert.equal(db.prepare('SELECT phase FROM storage_reset_requests').get().phase, 'recovering');
});

test('reset refuses changed local audio instead of overwriting it or deleting its remote copy', async (t) => {
	const { db, connection, options, audio, objects, run } = resetFixture(t);
	await archiveAudio(db, connection, options);
	writeFileSync(audio, 'new local audio');
	queueStorageReset(db, { now });
	await run();
	assert.equal(readFileSync(audio, 'utf8'), 'new local audio');
	assert.equal(objects.size, 1);
	assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storage_audio').get().count, 1);
	assert.equal(storageStatus(db, now).jobs[0].status, 'failed');
});

test('reset stops for insufficient disk space before deleting storage data', async (t) => {
	const { db, connection, options, audio, objects, resetOptions } = resetFixture(t);
	await archiveAudio(db, connection, options);
	unlinkSync(audio);
	db.prepare('UPDATE storage_audio SET bytes=?').run(Number.MAX_SAFE_INTEGER);
	const id = queueStorageReset(db, { now });
	await assert.rejects(
		resetStorageData(db, connection, { ...resetOptions, jobId: id }),
		/disk space/
	);
	assert.equal(objects.size, 1);
	assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storage_audio').get().count, 1);
});

test('reset refuses unexpected remote files before deleting anything or forgetting archives', async (t) => {
	const { db, connection, options, objects, run } = resetFixture(t);
	await archiveAudio(db, connection, options);
	objects.set('/radiology/audio/not-an-app-object.txt', Buffer.from('unrelated'));
	queueStorageReset(db, { now });
	await run();
	assert.equal(objects.size, 2);
	assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storage_audio').get().count, 1);
	assert.equal(storageStatus(db, now).jobs[0].status, 'failed');
});

test('reset cancellation during recovery preserves remote objects and archive metadata', async (t) => {
	const { db, connection, options, audio, objects, client, run } = resetFixture(t);
	await archiveAudio(db, connection, options);
	unlinkSync(audio);
	const id = queueStorageReset(db, { now });
	const download = client.get;
	client.get = async (...args) => {
		await download(...args);
		cancelStorageJob(db, id, { now });
	};
	await run();
	assert.equal(storageStatus(db, now).jobs[0].status, 'cancelled');
	assert.equal(objects.size, 1);
	assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storage_audio').get().count, 1);
	assert.equal(getStorageSettings(db).enabled, false);
});

test('reset rejects remote symlink directories and unsafe local paths without remote deletion', async (t) => {
	const { db, connection, options, objects, client, run, directory } = resetFixture(t);
	await archiveAudio(db, connection, options);
	const id = queueStorageReset(db, { now });
	const attributes = client.lstat;
	client.lstat = async (path) =>
		path === '/radiology/audio' ? { isDirectory: true, isSymbolicLink: true } : attributes(path);
	await run();
	assert.equal(objects.size, 1);
	assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storage_audio').get().count, 1);
	client.lstat = attributes;
	db.prepare('UPDATE storage_audio SET path=?').run(
		join(directory, '..', `outside-${randomUUID()}.ogg`)
	);
	const retry = db.prepare('SELECT retry_at FROM storage_jobs WHERE id=?').get(id).retry_at;
	await run(retry);
	assert.equal(objects.size, 1);
	assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storage_audio').get().count, 1);
	assert.equal(
		db.prepare('SELECT phase FROM storage_reset_requests WHERE job_id=?').get(id).phase,
		'recovering'
	);
});

test('reset resumes cleanup safely after an interrupted deletion without needing archive metadata again', async (t) => {
	const { db, connection, options, audio, objects, client, run } = resetFixture(t);
	await archiveAudio(db, connection, options);
	unlinkSync(audio);
	const id = queueStorageReset(db, { now });
	const remove = client.delete;
	let interrupted = false;
	client.delete = async (path, ...args) => {
		await remove(path, ...args);
		if (!interrupted) {
			interrupted = true;
			throw new Error('Connection interrupted after delete');
		}
	};
	await run();
	assert.equal(readFileSync(audio, 'utf8'), 'synthetic audio');
	assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storage_audio').get().count, 0);
	assert.equal(
		db.prepare('SELECT phase FROM storage_reset_requests WHERE job_id=?').get(id).phase,
		'cleaning'
	);
	const retry = db.prepare('SELECT retry_at FROM storage_jobs WHERE id=?').get(id).retry_at;
	await run(retry);
	assert.equal(objects.size, 0);
	assert.equal(storageStatus(db, retry).jobs[0].status, 'succeeded');
	assert.equal(readFileSync(audio, 'utf8'), 'synthetic audio');
});
