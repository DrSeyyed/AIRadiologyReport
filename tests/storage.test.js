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
			objects.set(
				remote,
				typeof local === 'string'
					? readFileSync(local)
					: Buffer.concat(await Array.fromAsync(local))
			);
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

function extraArchiveAudio(context, count) {
	for (let index = 0; index < count; index++) {
		const path = join(context.directory, `extra-${index}.ogg`);
		writeFileSync(path, `synthetic extra audio ${index}`);
		appendRecording(context.db, context.studyId, path);
	}
}

function archiveGate() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function backupCompleted(db, startedAt = now + 1) {
	db.prepare(
		"INSERT INTO storage_jobs(kind,status,created_at,started_at,finished_at,attempts) VALUES('full','succeeded',?,?,?,1)"
	).run(startedAt, startedAt, startedAt + 1);
}

test('audio archives reuse four independent sessions and bound concurrent upload plus verification pairs', async (t) => {
	const context = fixture(t);
	extraArchiveAudio(context, 11);
	const gate = archiveGate();
	let sessions = 0;
	let closed = 0;
	let started = 0;
	let active = 0;
	let peak = 0;
	const transport = async (connection, action) => {
		sessions++;
		let busy = false;
		const client = {
			...context.client,
			async put(local, remote) {
				assert.equal(busy, false);
				busy = true;
				peak = Math.max(peak, ++active);
				if (++started === 4) gate.resolve();
				await gate.promise;
				await context.client.put(local, remote);
			},
			createReadStream(remote) {
				assert.equal(busy, true);
				return Readable.from(
					(async function* () {
						try {
							yield context.objects.get(remote);
						} finally {
							busy = false;
							active--;
						}
					})()
				);
			}
		};
		try {
			return await action(client);
		} finally {
			closed++;
		}
	};
	assert.deepEqual(
		await archiveAudio(context.db, context.connection, {
			...context.options,
			transport,
			limit: 9
		}),
		{ copied: 9, evicted: 0 }
	);
	assert.equal(peak, 4);
	assert.equal(active, 0);
	assert.equal(sessions, 4);
	assert.equal(closed, 4);
	assert.equal(storageStatus(context.db).backlog, 3);
	assert.equal(
		String(
			await readStoredAudio(context.db, context.audio, {
				transport: context.transport
			})
		),
		'synthetic audio'
	);
});

for (const afterEof of [false, true]) {
	test(`audio upload watchdog aborts after 30 seconds idle ${afterEof ? 'waiting for remote acknowledgement' : 'before stream consumption'}`, async (t) => {
		const context = fixture(t);
		t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
		const ready = archiveGate();
		const snapshots = [];
		let upload;
		context.client.put = async (stream) => {
			upload = stream;
			if (afterEof) for await (const chunk of stream) assert.ok(chunk.length);
			return new Promise((resolve, reject) => {
				stream.once('error', reject);
				ready.resolve();
			});
		};
		const running = archiveAudio(context.db, context.connection, {
			...context.options,
			onProgress(progress) {
				snapshots.push(progress);
			}
		});
		let settled = false;
		running.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			}
		);
		const rejected = assert.rejects(running, /stalled for 30 seconds/);
		await ready.promise;
		t.mock.timers.tick(29_999);
		assert.equal(settled, false);
		assert.ok(snapshots.some((progress) => progress.uploading === 1));
		t.mock.timers.tick(1);
		await rejected;
		assert.equal(upload.destroyed, true);
		assert.equal(snapshots.at(-1).uploading, 0);
		const snapshotCount = snapshots.length;
		t.mock.timers.tick(60_000);
		assert.equal(snapshots.length, snapshotCount);
		assert.equal(existsSync(upload.path), false);
		assert.ok(existsSync(context.audio));
		assert.equal(context.objects.size, 0);
		assert.equal(context.db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 0);
	});
}

test('upload watchdog tracks consumed data and allows total transfer time greater than 30 seconds', async (t) => {
	const context = fixture(t);
	writeFileSync(context.audio, Buffer.alloc(300_000, 3));
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let elapsed = 0;
	context.client.put = async (stream, remote) => {
		const chunks = [];
		for await (const chunk of stream) {
			chunks.push(chunk);
			t.mock.timers.tick(20_000);
			elapsed += 20_000;
			await new Promise(setImmediate);
		}
		context.objects.set(remote, Buffer.concat(chunks));
	};
	assert.deepEqual(await archiveAudio(context.db, context.connection, context.options), {
		copied: 1,
		evicted: 0
	});
	assert.ok(elapsed > 30_000);
	assert.equal(context.db.prepare('SELECT bytes FROM storage_audio').get().bytes, 300_000);
});

test('a stalled upload cannot hang indefinitely while deleting its incomplete remote object', async (t) => {
	const context = fixture(t);
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const ready = archiveGate();
	const cleaning = archiveGate();
	context.client.put = (stream) =>
		new Promise((resolve, reject) => {
			stream.once('error', reject);
			ready.resolve();
		});
	context.client.delete = () => {
		cleaning.resolve();
		return new Promise(() => {});
	};
	const rejected = assert.rejects(
		archiveAudio(context.db, context.connection, context.options),
		/stalled/
	);
	await ready.promise;
	t.mock.timers.tick(30_000);
	await cleaning.promise;
	t.mock.timers.tick(5_000);
	await rejected;
	assert.ok(existsSync(context.audio));
});

test('running archive progress is sanitized, displayed as archive and frozen after cancellation', async (t) => {
	const context = fixture(t);
	saveStorageSettings(context.db, { ...context.settings, backupsEnabled: false });
	await processStorageJob(context.db, {
		now,
		runArchive: async (db, connection, { onProgress }) => {
			const progress = {
				copied: 97,
				evicted: 0,
				preparing: 0,
				uploading: 2,
				verifying: 1,
				lastActivityAt: now - 5
			};
			onProgress({ ...progress, secret: 'synthetic-private-field' });
			const before = db.prepare("SELECT id,result FROM storage_jobs WHERE status='running'").get();
			assert.ok(!before.result.includes('synthetic-private-field'));
			const job = storageStatus(db, now).jobs.find((job) => job.id === before.id);
			assert.equal(job.kind, 'archive');
			assert.match(job.progress, /Copied: 97/);
			assert.match(job.progress, /uploading: 2; verifying: 1/);
			assert.match(job.progress, /5s ago/);
			onProgress({ ...progress, uploading: 5 });
			assert.equal(
				db.prepare('SELECT result FROM storage_jobs WHERE id=?').get(before.id).result,
				before.result
			);
			cancelStorageJob(db, before.id, { now });
			onProgress({ ...progress, copied: 98 });
			assert.equal(
				db.prepare('SELECT result FROM storage_jobs WHERE id=?').get(before.id).result,
				before.result
			);
			return { copied: 98, evicted: 0 };
		}
	});
	assert.equal(storageStatus(context.db).jobs[0].status, 'cancelled');
});

test('archive concurrency and batch sizes reject unbounded or invalid controls before connecting', async (t) => {
	const context = fixture(t);
	for (const invalid of [
		{ concurrency: 0 },
		{ concurrency: 5 },
		{ concurrency: 1.5 },
		{ limit: 0 },
		{ limit: 101 }
	])
		await assert.rejects(
			archiveAudio(context.db, context.connection, {
				...context.options,
				...invalid,
				transport: async () => assert.fail('invalid controls must not open a connection')
			}),
			/batch limits/
		);
});

test('parallel eviction still requires verified remote copies and supports subsequent archived playback', async (t) => {
	const context = fixture(t);
	extraArchiveAudio(context, 3);
	context.db.prepare("UPDATE study_recordings SET created_at='2000-01-01 00:00:00'").run();
	const transport = async (connection, action) => action({ ...context.client });
	const options = { ...context.options, transport };
	assert.deepEqual(await archiveAudio(context.db, context.connection, options), {
		copied: 4,
		evicted: 0
	});
	backupCompleted(context.db);
	assert.deepEqual(
		await archiveAudio(context.db, context.connection, { ...options, now: now + 2 }),
		{
			copied: 0,
			evicted: 4
		}
	);
	for (const { path } of context.db.prepare('SELECT path FROM storage_audio').all()) {
		assert.equal(existsSync(path), false);
		assert.ok((await readStoredAudio(context.db, path, { transport })).length > 0);
	}
});

test('default audio archive batches process up to 100 files, retaining compatibility with shared-client transports', async (t) => {
	const context = fixture(t);
	extraArchiveAudio(context, 100);
	let active = 0;
	let peak = 0;
	const put = context.client.put;
	context.client.put = async (...args) => {
		peak = Math.max(peak, ++active);
		await new Promise(setImmediate);
		await put(...args);
	};
	context.client.createReadStream = (remote) =>
		Readable.from(
			(async function* () {
				try {
					yield context.objects.get(remote);
				} finally {
					active--;
				}
			})()
		);
	assert.deepEqual(await archiveAudio(context.db, context.connection, context.options), {
		copied: 100,
		evicted: 0
	});
	assert.equal(peak, 1);
	assert.equal(active, 0);
	assert.equal(storageStatus(context.db).backlog, 1);
	assert.deepEqual(await archiveAudio(context.db, context.connection, context.options), {
		copied: 1,
		evicted: 0
	});
	assert.equal(storageStatus(context.db).backlog, 0);
});

for (const mode of ['upload failure', 'transport timeout', 'cancellation']) {
	test(`parallel audio ${mode} drains sessions and callbacks before removing encrypted spools`, async (t) => {
		const context = fixture(t);
		extraArchiveAudio(context, 7);
		const started = archiveGate();
		const release = archiveGate();
		const fault = archiveGate();
		let uploads = 0;
		let sessions = 0;
		let closed = 0;
		let callbacks = 0;
		let owned = true;
		const spools = [];
		const transport = async (connection, action) => {
			const id = ++sessions;
			const client = {
				...context.client,
				async put(local, remote) {
					spools.push(local.path);
					if (++uploads === 4) started.resolve();
					await started.promise;
					if (mode === 'upload failure' && id === 2)
						throw new Error('Synthetic parallel upload failure');
					await release.promise;
					assert.ok(existsSync(local.path), 'spool must survive until the transfer settles');
					await context.client.put(local, remote);
				}
			};
			callbacks++;
			const running = Promise.resolve()
				.then(() => action(client))
				.finally(() => {
					callbacks--;
				});
			running.catch(() => {});
			try {
				if (mode === 'transport timeout' && id === 2) {
					await started.promise;
					throw new Error('Synthetic transport timeout');
				}
				return await running;
			} finally {
				closed++;
				if (id === 2) fault.resolve();
			}
		};
		const running = archiveAudio(context.db, context.connection, {
			...context.options,
			transport,
			owned: () => owned
		});
		let settled = false;
		running.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			}
		);
		const rejected = assert.rejects(running, /failure|timeout|lease/);
		await started.promise;
		if (mode === 'cancellation') owned = false;
		else await fault.promise;
		await new Promise(setImmediate);
		assert.equal(settled, false);
		assert.ok(spools.every((path) => existsSync(path)));
		release.resolve();
		await rejected;
		assert.equal(closed, 4);
		assert.equal(callbacks, 0);
		assert.equal(uploads, 4);
		assert.equal(context.objects.size, 0);
		assert.equal(context.db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 0);
		assert.ok(spools.every((path) => !existsSync(path)));
		assert.ok(existsSync(context.audio));
	});
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

test('archive backlog continues within the same minute without starving newly due recovery backups', async (t) => {
	const context = fixture(t);
	extraArchiveAudio(context, 2);
	saveStorageSettings(context.db, { ...context.settings, backupsEnabled: false });
	const calls = [];
	const options = {
		now,
		runArchive: async (db, connection, options) => {
			calls.push('archive');
			return archiveAudio(db, connection, { ...context.options, ...options, limit: 1 });
		},
		runBackup: async (db, connection, { kind }) => {
			calls.push(kind);
			return {};
		},
		prune: async () => {}
	};
	assert.equal(await processStorageJob(context.db, options), true);
	assert.equal(
		context.db
			.prepare("SELECT COUNT(*) n FROM storage_jobs WHERE kind='archive' AND status='pending'")
			.get().n,
		1
	);
	saveStorageSettings(context.db, context.settings);
	for (let index = 0; index < 4; index++)
		assert.equal(await processStorageJob(context.db, options), true);
	assert.deepEqual(calls, ['archive', 'full', 'database', 'archive', 'archive']);
	assert.equal(storageStatus(context.db).backlog, 0);
	assert.equal(await processStorageJob(context.db, options), false);
});

test('an archive pass making no progress does not create a continuous retry loop', async (t) => {
	const context = fixture(t);
	saveStorageSettings(context.db, { ...context.settings, backupsEnabled: false });
	const options = { now, runArchive: async () => ({ copied: 0, evicted: 0 }) };
	assert.equal(await processStorageJob(context.db, options), true);
	assert.equal(storageStatus(context.db).backlog, 1);
	assert.equal(await processStorageJob(context.db, options), false);
	assert.equal(context.db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 1);
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
