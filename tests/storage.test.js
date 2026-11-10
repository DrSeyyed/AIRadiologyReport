import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
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
	storageDestination,
	storageParallelConnections,
	storageTimeoutMs
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
import { withStorage } from '../src/lib/server/storage-transport.js';
import { abortStorageSession } from '../src/lib/server/storage-session.js';

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
	const directory = mkdtempSync(join(process.cwd(), '.storage-test-'));
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

for (const selected of [undefined, 1, 8, 16]) {
	test(`audio archives respect ${selected ?? 'default 4'} configured connections for upload and verification`, async (t) => {
		const concurrency = selected ?? 4;
		const context = fixture(t);
		if (selected !== undefined) context.connection.parallelConnections = selected;
		extraArchiveAudio(context, 19);
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
					if (++started === concurrency) gate.resolve();
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
				limit: 17
			}),
			{ copied: 17, evicted: 0 }
		);
		assert.equal(peak, concurrency);
		assert.equal(active, 0);
		assert.equal(sessions, concurrency);
		assert.equal(closed, concurrency);
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
}

for (const [afterEof, configuredSeconds] of [
	[false, undefined],
	[true, undefined],
	[false, 2],
	[true, 45]
]) {
	const seconds = configuredSeconds ?? 30;
	test(`audio upload watchdog aborts after ${seconds} seconds idle ${afterEof ? 'waiting for remote acknowledgement' : 'before stream consumption'}`, async (t) => {
		const context = fixture(t);
		if (configuredSeconds !== undefined)
			context.connection.uploadTimeoutSeconds = configuredSeconds;
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
		const rejected = assert.rejects(running, new RegExp(`stalled for ${seconds} seconds`));
		await ready.promise;
		t.mock.timers.tick(seconds * 1000 - 1);
		assert.equal(settled, false);
		if (seconds >= 5) assert.ok(snapshots.some((progress) => progress.uploading === 1));
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

test('an ignored SFTP promise after 95 archived files cannot keep the pass running', async (t) => {
	const context = fixture(t);
	extraArchiveAudio(context, 95);
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const ready = archiveGate();
	const put = context.client.put;
	let uploads = 0;
	let disconnected = 0;
	let stalled;
	context.client.client = {
		destroy() {
			disconnected++;
		}
	};
	context.client.put = async (...args) => {
		if (++uploads !== 96) return put(...args);
		stalled = args[0];
		stalled.on('error', () => {});
		ready.resolve();
		return new Promise(() => {});
	};
	const rejected = assert.rejects(
		archiveAudio(context.db, context.connection, {
			...context.options,
			concurrency: 1
		}),
		/stalled for 30 seconds/
	);
	await ready.promise;
	assert.equal(context.db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 95);
	t.mock.timers.tick(30_000);
	await rejected;
	assert.equal(disconnected, 1);
	assert.equal(context.db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 95);
	assert.ok(existsSync(context.audio));
	for (let index = 0; index < 95; index++)
		assert.ok(existsSync(join(context.directory, `extra-${index}.ogg`)));
	assert.equal(existsSync(stalled.path), false);
});

test('late verification completion on an aborted session cannot register an archive', async (t) => {
	const context = fixture(t);
	const read = context.client.createReadStream;
	context.client.createReadStream = (...args) => {
		abortStorageSession(context.client);
		return read(...args);
	};
	await assert.rejects(archiveAudio(context.db, context.connection, context.options), /stopped/);
	assert.equal(context.db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 0);
	assert.ok(existsSync(context.audio));
});

for (const method of ['mkdir', 'lstat']) {
	test(`an unresponsive archive ${method} request cannot hold the pass indefinitely`, async (t) => {
		const context = fixture(t);
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const ready = archiveGate();
		let disconnected = 0;
		context.client.client = {
			destroy() {
				disconnected++;
			}
		};
		context.client[method] = () => {
			ready.resolve();
			return new Promise(() => {});
		};
		const rejected = assert.rejects(
			archiveAudio(context.db, context.connection, context.options),
			/timed out/
		);
		await ready.promise;
		t.mock.timers.tick(20_000);
		await rejected;
		assert.equal(disconnected, 1);
		assert.ok(existsSync(context.audio));
		assert.equal(context.db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 0);
	});
}

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

test('slow verification updates read-back bytes and activity instead of appearing idle', async (t) => {
	const context = fixture(t);
	t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: now * 1000 });
	const started = archiveGate();
	const first = archiveGate();
	const second = archiveGate();
	const finish = archiveGate();
	const progress = [];
	let total;
	context.client.createReadStream = (remote) => {
		const bytes = context.objects.get(remote);
		total = bytes.length;
		started.resolve();
		return Readable.from(
			(async function* () {
				await first.promise;
				yield bytes.subarray(0, 8);
				await second.promise;
				yield bytes.subarray(8);
				await finish.promise;
			})()
		);
	};
	const running = archiveAudio(context.db, context.connection, {
		...context.options,
		onProgress: (snapshot) => progress.push(snapshot)
	});
	await started.promise;
	await new Promise(setImmediate);
	t.mock.timers.tick(15_000);
	first.resolve();
	await new Promise(setImmediate);
	t.mock.timers.tick(2_000);
	assert.equal(progress.at(-1).verificationBytes, 8);
	assert.equal(progress.at(-1).verifying, 1);
	assert.equal(progress.at(-1).lastActivityAt, now + 15);
	t.mock.timers.tick(15_000);
	second.resolve();
	await new Promise(setImmediate);
	t.mock.timers.tick(2_000);
	assert.equal(progress.at(-1).verificationBytes, total);
	assert.equal(progress.at(-1).lastActivityAt, now + 32);
	assert.equal(progress.at(-1).verifying, 1);
	finish.resolve();
	assert.deepEqual(await running, { copied: 1, evicted: 0 });
});

test('running archive progress is sanitized, displayed as archive and frozen after cancellation', async (t) => {
	const context = fixture(t);
	saveStorageSettings(context.db, {
		...context.settings,
		backupsEnabled: false,
		parallelConnections: 16
	});
	await processStorageJob(context.db, {
		now,
		runArchive: async (db, connection, { onProgress }) => {
			const progress = {
				copied: 97,
				evicted: 0,
				preparing: 0,
				uploading: 2,
				verifying: 14,
				verificationBytes: 2 * 1024 * 1024,
				lastActivityAt: now - 5
			};
			onProgress({ ...progress, secret: 'synthetic-private-field' });
			const before = db.prepare("SELECT id,result FROM storage_jobs WHERE status='running'").get();
			assert.ok(!before.result.includes('synthetic-private-field'));
			const job = storageStatus(db, now).jobs.find((job) => job.id === before.id);
			assert.equal(job.kind, 'archive');
			assert.match(job.progress, /Copied: 97/);
			assert.match(job.progress, /uploading: 2; verifying: 14/);
			assert.match(job.progress, /Checksum verification: 2.00 MiB/);
			assert.match(job.progress, /Last transfer\/file activity: 5s ago/);
			onProgress({ ...progress, verificationBytes: 'synthetic-private-path' });
			assert.equal(
				db.prepare('SELECT result FROM storage_jobs WHERE id=?').get(before.id).result,
				before.result
			);
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
		{ concurrency: 17 },
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

test('sync intervals default for missing settings, validate and survive a database restart', async (t) => {
	const { db, settings, directory } = fixture(t);
	assert.equal(DEFAULT_STORAGE_SETTINGS.syncIntervalMinutes, 1);
	assert.equal(normalizeStorageSettings({}).syncIntervalMinutes, 1);
	const legacy = { ...settings };
	delete legacy.syncIntervalMinutes;
	db.prepare("UPDATE application_settings SET value=? WHERE key='storage_settings'").run(
		JSON.stringify(legacy)
	);
	assert.equal(getStorageSettings(db).syncIntervalMinutes, 1);
	for (const value of [0, -1, 1441, 1.5, '5', null, NaN, Infinity])
		assert.throws(() => normalizeStorageSettings({ ...settings, syncIntervalMinutes: value }));
	const destination = storageDestination(settings);
	for (const syncIntervalMinutes of [1, 7, 1440]) {
		saveStorageSettings(db, { ...settings, syncIntervalMinutes });
		assert.equal(getStorageConnection(db).syncIntervalMinutes, syncIntervalMinutes);
		assert.equal(storageDestination(getStorageSettings(db)), destination);
	}
	const at = Math.floor(now / 86400) * 86400;
	scheduleStorageJobs(db, at);
	db.prepare("UPDATE storage_jobs SET status='succeeded',started_at=?,finished_at=?").run(at, at);
	const count = db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n;
	const filename = join(directory, 'restart.sqlite');
	await db.backup(filename);
	const restarted = new Database(filename);
	try {
		assert.equal(getStorageSettings(restarted).syncIntervalMinutes, 1440);
		scheduleStorageJobs(restarted, at + 15);
		assert.equal(restarted.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, count);
	} finally {
		restarted.close();
	}
});

for (const minutes of [1, 7, 1440]) {
	test(`automatic sync uses durable ${minutes}-minute windows and skips missed checks`, (t) => {
		const { db, settings } = fixture(t);
		saveStorageSettings(db, { ...settings, backupsEnabled: false, syncIntervalMinutes: minutes });
		const seconds = minutes * 60;
		const at = Math.floor(now / seconds) * seconds;
		scheduleStorageJobs(db, at);
		assert.equal(
			db.prepare('SELECT schedule_key FROM storage_jobs').get().schedule_key,
			`archive:${at / 60}`
		);
		db.prepare("UPDATE storage_jobs SET status='succeeded',started_at=?,finished_at=?").run(at, at);
		scheduleStorageJobs(db, at + seconds - 1);
		assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 1);
		scheduleStorageJobs(db, at + seconds);
		assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 2);
		db.prepare(
			"UPDATE storage_jobs SET status='succeeded',started_at=?,finished_at=? WHERE status='pending'"
		).run(at + seconds, at + seconds);
		scheduleStorageJobs(db, at + seconds * 10);
		assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 3);
	});
}

test('long sync intervals preserve retry backoff, immediate manual work and pause safety', async (t) => {
	const { db, settings } = fixture(t);
	saveStorageSettings(db, { ...settings, backupsEnabled: false, syncIntervalMinutes: 1440 });
	const at = Math.floor(now / 86400) * 86400;
	const options = {
		now: at,
		runArchive: async () => {
			throw new Error('offline');
		}
	};
	assert.equal(await processStorageJob(db, options), true);
	const failed = db.prepare("SELECT * FROM storage_jobs WHERE kind='archive'").get();
	assert.equal(failed.status, 'failed');
	assert.equal(failed.retry_at, at + 60);
	assert.equal(await processStorageJob(db, { ...options, now: at + 15 }), false);
	scheduleStorageJobs(db, at + 86400);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 1);
	assert.equal(db.prepare('SELECT retry_at FROM storage_jobs').get().retry_at, at + 60);
	assert.equal(queueStorageJob(db, 'archive', { now: at + 15, retryNow: true }), failed.id);
	assert.equal(
		await processStorageJob(db, { now: at + 15, runArchive: async () => ({ syncPending: 0 }) }),
		true
	);
	const manual = queueStorageJob(db, 'archive', { now: at + 30 });
	assert.notEqual(manual, failed.id);
	assert.equal(
		await processStorageJob(db, { now: at + 30, runArchive: async () => ({ syncPending: 0 }) }),
		true
	);
	pauseAndCancelStorageJobs(db, { now: at + 40 });
	assert.equal(getStorageSettings(db).syncIntervalMinutes, 1440);
	assert.equal(
		await processStorageJob(db, { now: at + 86400, runArchive: async () => assert.fail('paused') }),
		false
	);
});

test('full backup hours default twice daily, migrate legacy schedules once and persist canonically', (t) => {
	const { db, settings } = fixture(t);
	assert.deepEqual(DEFAULT_STORAGE_SETTINGS.fullBackupHours, [0, 12]);
	assert.deepEqual(normalizeStorageSettings({}).fullBackupHours, [0, 12]);
	assert.equal(normalizeStorageSettings({}).integrityAuditDays, 7);
	db.prepare("DELETE FROM application_settings WHERE key='storage_settings'").run();
	assert.deepEqual(getStorageSettings(db).fullBackupHours, [0, 12]);
	const legacy = { ...settings, fileBackupHour: 19, databaseIntervalHours: 6 };
	delete legacy.fullBackupHours;
	delete legacy.integrityAuditDays;
	db.prepare("INSERT INTO application_settings(key,value) VALUES('storage_settings',?)").run(
		JSON.stringify(legacy)
	);
	assert.deepEqual(getStorageSettings(db).fullBackupHours, [19]);
	assert.equal(getStorageSettings(db).integrityAuditDays, 7);
	saveStorageSettings(db, getStorageSettings(db));
	const saved = JSON.parse(
		db.prepare("SELECT value FROM application_settings WHERE key='storage_settings'").get().value
	);
	assert.deepEqual(saved.fullBackupHours, [19]);
	saved.fileBackupHour = 5;
	db.prepare("UPDATE application_settings SET value=? WHERE key='storage_settings'").run(
		JSON.stringify(saved)
	);
	assert.deepEqual(getStorageSettings(db).fullBackupHours, [19]);
	const hours = [23, 0, 12];
	saveStorageSettings(db, { ...settings, fullBackupHours: hours, integrityAuditDays: 365 });
	assert.deepEqual(hours, [23, 0, 12]);
	assert.deepEqual(getStorageSettings(db).fullBackupHours, [0, 12, 23]);
	assert.equal(getStorageSettings(db).integrityAuditDays, 365);
	assert.deepEqual(
		normalizeStorageSettings({ fullBackupHours: Array.from({ length: 24 }, (_, hour) => hour) })
			.fullBackupHours,
		Array.from({ length: 24 }, (_, hour) => hour)
	);
	for (const fullBackupHours of [
		[],
		[0, 0],
		[-1],
		[24],
		[1.5],
		['12'],
		null,
		'0,12',
		[NaN],
		Array(2),
		Array.from({ length: 25 }, (_, i) => i)
	])
		assert.throws(() => normalizeStorageSettings({ ...settings, fullBackupHours }));
	for (const integrityAuditDays of [0, 366, 1.5, '7', null])
		assert.throws(() => normalizeStorageSettings({ ...settings, integrityAuditDays }));
});

test('inactivity timeout settings default for legacy rows, validate and persist without changing destination', (t) => {
	const { db, settings } = fixture(t);
	const legacy = { ...settings };
	delete legacy.uploadTimeoutSeconds;
	delete legacy.verificationTimeoutSeconds;
	db.prepare("UPDATE application_settings SET value=? WHERE key='storage_settings'").run(
		JSON.stringify(legacy)
	);
	assert.equal(getStorageSettings(db).uploadTimeoutSeconds, 30);
	assert.equal(getStorageSettings(db).verificationTimeoutSeconds, 20);
	assert.equal(storageTimeoutMs({}, 'uploadTimeoutSeconds'), 30_000);
	assert.equal(storageTimeoutMs({}, 'verificationTimeoutSeconds'), 20_000);
	for (const field of ['uploadTimeoutSeconds', 'verificationTimeoutSeconds']) {
		for (const invalid of [0, -1, 601, 1.5, '20', null, NaN]) {
			assert.throws(() => normalizeStorageSettings({ ...settings, [field]: invalid }));
			assert.throws(() => storageTimeoutMs({ [field]: invalid }, field));
		}
		assert.equal(storageTimeoutMs({ [field]: 600 }, field), 600_000);
	}
	const original = storageDestination(getStorageConnection(db));
	saveStorageSettings(db, {
		...settings,
		uploadTimeoutSeconds: 90,
		verificationTimeoutSeconds: 60
	});
	const saved = getStorageConnection(db);
	assert.equal(saved.uploadTimeoutSeconds, 90);
	assert.equal(saved.verificationTimeoutSeconds, 60);
	assert.equal(saved.password, 'synthetic-password');
	assert.equal(storageDestination(saved), original);
	db.prepare("INSERT INTO storage_jobs(kind,status,created_at) VALUES('archive','running',?)").run(
		now
	);
	assert.throws(() => saveStorageSettings(db, { ...settings, uploadTimeoutSeconds: 1 }), /running/);
});

test('parallel connections default for legacy settings, validate and persist without changing destination', (t) => {
	const { db, settings } = fixture(t);
	const legacy = { ...settings };
	delete legacy.parallelConnections;
	db.prepare("UPDATE application_settings SET value=? WHERE key='storage_settings'").run(
		JSON.stringify(legacy)
	);
	assert.equal(getStorageSettings(db).parallelConnections, 4);
	assert.equal(storageParallelConnections({}), 4);
	for (const invalid of [0, -1, 17, 1.5, '4', null, NaN, Infinity]) {
		assert.throws(() => normalizeStorageSettings({ ...settings, parallelConnections: invalid }));
		assert.throws(() => storageParallelConnections({ parallelConnections: invalid }));
	}
	const destination = storageDestination(getStorageConnection(db));
	for (const parallelConnections of [1, 16]) {
		saveStorageSettings(db, { ...settings, parallelConnections });
		const saved = getStorageConnection(db);
		assert.equal(saved.parallelConnections, parallelConnections);
		assert.equal(storageDestination(saved), destination);
		assert.equal(saved.password, 'synthetic-password');
	}
	db.prepare("INSERT INTO storage_jobs(kind,status,created_at) VALUES('archive','running',?)").run(
		now
	);
	assert.throws(() => saveStorageSettings(db, { ...settings, parallelConnections: 1 }), /running/);
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

for (const table of ['storage_file_objects', 'storage_file_catalog']) {
	test(`report-only synchronization locks the destination with ${table} tracking alone`, (t) => {
		const { db, settings } = fixture(t);
		const destination = storageDestination(settings);
		const other =
			table === 'storage_file_objects' ? 'storage_file_catalog' : 'storage_file_objects';
		db.exec(`DROP TABLE ${other}`);
		if (table === 'storage_file_objects')
			db.prepare(
				`INSERT INTO storage_file_objects(destination,object_key,sha256,remote_sha256,bytes,encrypted_bytes,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?)`
			).run(
				destination,
				'synthetic-report-object',
				'a'.repeat(64),
				'b'.repeat(64),
				10,
				38,
				now,
				now
			);
		else
			db.prepare(
				'INSERT INTO storage_file_catalog(path,original,destination,object_key,synced_at) VALUES(?,?,?,?,?)'
			).run(
				'reports/synthetic.docx',
				'uploads/reports/synthetic.docx',
				destination,
				'synthetic-report-object',
				now
			);
		assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 0);
		assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 0);
		for (const change of [
			{ root: '/different' },
			{ host: 'different.invalid' },
			{ port: 2222 },
			{ username: 'different' },
			{ fingerprint: `SHA256:${'b'.repeat(43)}` }
		])
			assert.throws(() => saveStorageSettings(db, { ...settings, ...change }), /in use/);
		saveStorageSettings(
			db,
			{ ...settings, fullBackupHours: [6, 18], integrityAuditDays: 14 },
			'rotated-synthetic'
		);
		assert.deepEqual(getStorageSettings(db).fullBackupHours, [6, 18]);
		assert.equal(getStorageConnection(db).password, 'rotated-synthetic');
		assert.equal(storageDestination(getStorageSettings(db)), destination);
	});
}

test('legacy databases without file synchronization tables still allow unused destination changes', (t) => {
	const { db, settings } = fixture(t);
	db.exec('DROP TABLE storage_file_catalog; DROP TABLE storage_file_objects');
	saveStorageSettings(db, { ...settings, root: '/unused-new-destination' });
	assert.equal(getStorageSettings(db).root, '/unused-new-destination');
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

test('manually deleted backup evidence cannot permit local audio eviction until a new full backup succeeds', async (t) => {
	const { db, audio, connection, options } = fixture(t);
	await archiveAudio(db, connection, options);
	const backupId = '1800000100-22222222-2222-2222-2222-222222222222';
	db.prepare(
		"INSERT INTO storage_jobs(kind,status,created_at,started_at,result) VALUES('full','succeeded',?,?,?)"
	).run(now + 1, now + 1, JSON.stringify({ id: backupId }));
	db.prepare('INSERT INTO storage_deleted_recovery_points(backup_id,deleted_at) VALUES(?,?)').run(
		backupId,
		now + 2
	);
	assert.deepEqual(await archiveAudio(db, connection, { ...options, now: now + 3 }), {
		copied: 0,
		evicted: 0
	});
	assert.ok(existsSync(audio));
	backupCompleted(db, now + 4);
	assert.deepEqual(await archiveAudio(db, connection, { ...options, now: now + 5 }), {
		copied: 0,
		evicted: 1
	});
	assert.equal(existsSync(audio), false);
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
	for (let index = 0; index < 3; index++)
		assert.equal(await processStorageJob(context.db, options), true);
	assert.deepEqual(calls, ['archive', 'full', 'archive', 'archive']);
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
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 2);
	assert.equal(
		queueStorageJob(db, 'full'),
		db.prepare("SELECT id FROM storage_jobs WHERE kind='full'").get().id
	);
	saveStorageSettings(db, { ...settings, enabled: false });
	scheduleStorageJobs(db, now + 86400);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 2);
	assert.throws(() => queueStorageJob(db, 'archive'), /Enable/);
	assert.ok(queueStorageJob(db, 'test'));
	const status = storageStatus(db, now);
	assert.equal(status.nextDatabase, undefined);
	assert.ok(status.nextFull > now);
	assert.ok(settings.fullBackupHours.includes(new Date(status.nextFull * 1000).getUTCHours()));
	assert.ok(!JSON.stringify(status).includes('synthetic-password'));
});

test('full schedules use the latest UTC slot, skip missed slots and stay stable between ticks', (t) => {
	const { db, settings } = fixture(t);
	saveStorageSettings(db, {
		...settings,
		archiveEnabled: false,
		fullBackupHours: [18, 6],
		syncIntervalMinutes: 1440,
		fileBackupHour: 3,
		databaseIntervalHours: 1
	});
	const utc = (value) => Date.parse(value) / 1000;
	for (const [at, due, next] of [
		['2026-12-31T05:59:59Z', '2026-12-30T18:00:00Z', '2026-12-31T06:00:00Z'],
		['2026-12-31T06:00:00Z', '2026-12-31T06:00:00Z', '2026-12-31T18:00:00Z'],
		['2026-12-31T17:59:59Z', '2026-12-31T06:00:00Z', '2026-12-31T18:00:00Z'],
		['2026-12-31T18:00:00Z', '2026-12-31T18:00:00Z', '2027-01-01T06:00:00Z'],
		['2027-01-01T00:00:00Z', '2026-12-31T18:00:00Z', '2027-01-01T06:00:00Z'],
		['2027-01-05T15:00:00Z', '2027-01-05T06:00:00Z', '2027-01-05T18:00:00Z']
	]) {
		scheduleStorageJobs(db, utc(at));
		const latest = db
			.prepare(
				"SELECT id,schedule_key FROM storage_jobs WHERE kind='full' ORDER BY id DESC LIMIT 1"
			)
			.get();
		assert.equal(latest.schedule_key, `full:${utc(due)}`);
		assert.equal(storageStatus(db, utc(at)).nextFull, utc(next));
		db.prepare(
			"UPDATE storage_jobs SET status='succeeded',started_at=?,finished_at=? WHERE status='pending'"
		).run(utc(at), utc(at));
		scheduleStorageJobs(db, utc(at));
		assert.equal(
			db.prepare("SELECT MAX(id) AS id FROM storage_jobs WHERE kind='full'").get().id,
			latest.id
		);
	}
	assert.equal(db.prepare("SELECT COUNT(*) n FROM storage_jobs WHERE kind='full'").get().n, 4);
	assert.equal(db.prepare("SELECT COUNT(*) n FROM storage_jobs WHERE kind='database'").get().n, 0);
});

test('full slot retries and cancellation retain one durable identity until the next UTC slot', (t) => {
	const { db } = fixture(t);
	const at = Date.parse('2026-12-31T01:00:00Z') / 1000;
	scheduleStorageJobs(db, at);
	const id = db.prepare("SELECT id FROM storage_jobs WHERE kind='full'").get().id;
	db.prepare("UPDATE storage_jobs SET status='failed',attempts=1,retry_at=? WHERE id=?").run(
		at + 600,
		id
	);
	scheduleStorageJobs(db, at + 15);
	assert.equal(
		db.prepare('SELECT retry_at FROM storage_jobs WHERE id=?').get(id).retry_at,
		at + 600
	);
	assert.equal(queueStorageJob(db, 'full', { now: at + 15, retryNow: true }), id);
	assert.equal(
		db.prepare('SELECT retry_at FROM storage_jobs WHERE id=?').get(id).retry_at,
		at + 15
	);
	assert.equal(cancelStorageJob(db, id, { now: at + 20 }), true);
	scheduleStorageJobs(db, at + 30);
	assert.equal(db.prepare("SELECT COUNT(*) n FROM storage_jobs WHERE kind='full'").get().n, 1);
	assert.equal(storageStatus(db, at + 30).jobs.find((job) => job.id === id).status, 'cancelled');
	scheduleStorageJobs(db, at + 11 * 3600);
	assert.equal(db.prepare("SELECT COUNT(*) n FROM storage_jobs WHERE kind='full'").get().n, 2);
	assert.notEqual(
		db.prepare("SELECT id FROM storage_jobs WHERE kind='full' AND status='pending'").get().id,
		id
	);
});

test('file synchronization is available for backups without audio eviction, with immediate non-audio continuation', async (t) => {
	const { db, settings } = fixture(t);
	saveStorageSettings(db, { ...settings, archiveEnabled: false, syncIntervalMinutes: 10 });
	db.prepare('DELETE FROM recording_audio_parts').run();
	db.prepare('UPDATE study_recordings SET audio_report_path=NULL').run();
	assert.equal(storageStatus(db).backlog, 0);
	const fullId = queueStorageJob(db, 'full', { now });
	db.prepare("UPDATE storage_jobs SET status='failed',attempts=1,retry_at=? WHERE id=?").run(
		now + 3600,
		fullId
	);
	scheduleStorageJobs(db, now);
	const archiveId = queueStorageJob(db, 'archive', { now });
	let calls = 0;
	const options = {
		now,
		runArchive: async (_db, connection) => {
			assert.equal(connection.archiveEnabled, false);
			calls++;
			return { copied: 0, evicted: 0, syncPending: calls === 1 ? 2 : 0 };
		}
	};
	assert.equal(await processStorageJob(db, options), true);
	assert.equal(
		db.prepare('SELECT status FROM storage_jobs WHERE id=?').get(archiveId).status,
		'succeeded'
	);
	assert.equal(
		db
			.prepare("SELECT COUNT(*) n FROM storage_jobs WHERE kind='archive' AND status='pending'")
			.get().n,
		1
	);
	assert.equal(await processStorageJob(db, options), true);
	assert.equal(await processStorageJob(db, options), false);
	assert.equal(await processStorageJob(db, { ...options, now: now + 60 }), false);
	assert.equal(await processStorageJob(db, { ...options, now: now + 600 }), true);
	assert.equal(calls, 3);
	saveStorageSettings(db, { ...settings, archiveEnabled: false, backupsEnabled: false });
	assert.throws(() => queueStorageJob(db, 'archive'), /Enable/);
	assert.throws(() => queueStorageJob(db, 'full'), /Enable/);
	assert.throws(() => queueStorageJob(db, 'database'), /Invalid/);
	const count = db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n;
	scheduleStorageJobs(db, now + 120);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, count);
});

test('legacy database jobs retire without interrupting a running owner or hiding recovery history', async (t) => {
	const { db, settings } = fixture(t);
	saveStorageSettings(db, { ...settings, enabled: false });
	db.prepare(
		"INSERT INTO storage_jobs(kind,status,attempts,created_at) VALUES('database','pending',0,1),('database','failed',2,1),('database','running',1,1),('database','succeeded',1,1)"
	).run();
	const backupId = `${now}-${randomUUID()}`;
	db.prepare('UPDATE storage_jobs SET result=? WHERE id=4').run(
		JSON.stringify({ id: backupId, files: 1, bytes: 2, uploadedObjects: 1, reusedObjects: 0 })
	);
	db.prepare('INSERT INTO storage_worker_lock VALUES(1,?,?)').run('active-legacy-owner', now + 60);
	scheduleStorageJobs(db, now);
	assert.deepEqual(db.prepare('SELECT status,attempts FROM storage_jobs ORDER BY id').all(), [
		{ status: 'failed', attempts: 8 },
		{ status: 'failed', attempts: 8 },
		{ status: 'running', attempts: 1 },
		{ status: 'succeeded', attempts: 1 }
	]);
	assert.equal(await processStorageJob(db, { now }), false);
	assert.equal(db.prepare('SELECT status FROM storage_jobs WHERE id=3').get().status, 'running');
	const history = storageStatus(db).jobs.find((job) => job.id === 4);
	assert.equal(history.backupId, backupId);
	assert.match(history.progress, /objects uploaded and verified/);
	assert.ok(queueStorageJob(db, 'restore', { now, backupId }));
	cancelStorageJob(db, 5, { now });
	db.prepare('DELETE FROM storage_worker_lock').run();
	db.prepare("UPDATE application_settings SET value=? WHERE key='storage_settings'").run(
		JSON.stringify(settings)
	);
	await processStorageJob(db, {
		now,
		runBackup: async (_db, _connection, { kind }) => {
			assert.equal(kind, 'full');
			return {};
		},
		prune: async () => {}
	});
	assert.equal(db.prepare('SELECT status,attempts FROM storage_jobs WHERE id=3').get().attempts, 8);
	assert.match(db.prepare('SELECT error FROM storage_jobs WHERE id=3').get().error, /retired/);
});

for (const kind of ['full']) {
	test(`${kind} worker persists safe live progress and displays a completed backup summary`, async (t) => {
		const { db, settings } = fixture(t);
		saveStorageSettings(db, { ...settings, archiveEnabled: false });
		db.prepare(
			"INSERT INTO storage_jobs(kind,status,created_at,started_at,finished_at) VALUES(?,'succeeded',?,?,?)"
		).run(kind === 'full' ? 'database' : 'full', now, now, now);
		const jobId = queueStorageJob(db, kind, { now });
		db.prepare('UPDATE storage_jobs SET result=? WHERE id=?').run(
			JSON.stringify({ oldAttempt: true }),
			jobId
		);
		const progress = {
			phase: 'collecting',
			files: 2,
			totalFiles: 4,
			bundles: 2,
			uploadedObjects: 1,
			reusedObjects: 0,
			uploading: 1,
			verifying: 0,
			uploadedBytes: 1024 * 1024,
			downloadedBytes: 2 * 1024 * 1024,
			verificationBytes: 3 * 1024 * 1024,
			lastActivityAt: now - 7
		};
		let report;
		const result = {
			format: 'immutable-files-v1',
			id: `${now}-${randomUUID()}`,
			files: 4,
			bytes: 1024 * 1024,
			uploadedObjects: 1,
			reusedObjects: 1
		};
		await processStorageJob(db, {
			now,
			async runBackup(database, connection, options) {
				assert.equal(options.kind, kind);
				assert.equal(
					database.prepare('SELECT result FROM storage_jobs WHERE id=?').get(jobId).result,
					null
				);
				report = options.onProgress;
				report({ ...progress, privatePath: 'private-progress-data' });
				const saved = database
					.prepare('SELECT result FROM storage_jobs WHERE id=?')
					.get(jobId).result;
				assert.deepEqual(JSON.parse(saved), progress);
				for (const bad of [
					{ ...progress, phase: 'private-progress-data' },
					{ ...progress, files: -1 },
					{ ...progress, uploading: 17 }
				])
					report(bad);
				assert.equal(
					database.prepare('SELECT result FROM storage_jobs WHERE id=?').get(jobId).result,
					saved
				);
				const display = storageStatus(database, now).jobs.find((job) => job.id === jobId).progress;
				assert.match(display, /Files collected: 2\/4; objects verified: 1\/2/);
				assert.match(display, /Phase: collecting; uploading: 1; verifying: 0/);
				assert.match(display, /Uploaded: 1.00 MiB; verified on storage: 3.00 checksum MiB/);
				assert.match(display, /activity: 7s ago/);
				assert.doesNotMatch(display, /private-progress-data/);
				const parallel = { ...progress, phase: 'verifying', uploading: 0, verifying: 16 };
				report(parallel);
				assert.deepEqual(
					JSON.parse(
						database.prepare('SELECT result FROM storage_jobs WHERE id=?').get(jobId).result
					),
					parallel
				);
				assert.match(
					storageStatus(database, now).jobs.find((job) => job.id === jobId).progress,
					/Phase: verifying; uploading: 0; verifying: 16/
				);
				report({ ...parallel, verifying: 0 });
				return result;
			},
			async prune() {
				assert.match(
					storageStatus(db, now).jobs.find((job) => job.id === jobId).progress,
					/Phase: pruning/
				);
			}
		});
		assert.deepEqual(
			JSON.parse(db.prepare('SELECT result FROM storage_jobs WHERE id=?').get(jobId).result),
			result
		);
		report({ ...progress, files: 3 });
		assert.deepEqual(
			JSON.parse(db.prepare('SELECT result FROM storage_jobs WHERE id=?').get(jobId).result),
			result
		);
		const completed = storageStatus(db, now + 100).jobs.find((job) => job.id === jobId);
		assert.equal(completed.status, 'succeeded');
		assert.match(completed.progress, /Files: 4; objects uploaded and verified: 1; reused: 1/);
		assert.doesNotMatch(completed.progress, /ago|Phase:/);
	});
}

for (const mode of ['cancelled', 'lost lease']) {
	test(`backup progress cannot publish after the job is ${mode}`, async (t) => {
		const { db, settings } = fixture(t);
		saveStorageSettings(db, { ...settings, archiveEnabled: false });
		const jobId = queueStorageJob(db, 'full', { now });
		let report;
		await processStorageJob(db, {
			now,
			async runBackup(database, connection, options) {
				const progress = {
					phase: 'collecting',
					files: 0,
					totalFiles: 1,
					bundles: 0,
					uploadedObjects: 0,
					reusedObjects: 0,
					uploading: 0,
					verifying: 0,
					uploadedBytes: 0,
					downloadedBytes: 0,
					verificationBytes: 0,
					lastActivityAt: now
				};
				report = options.onProgress;
				report(progress);
				const before = db.prepare('SELECT result FROM storage_jobs WHERE id=?').get(jobId).result;
				if (mode === 'cancelled') cancelStorageJob(db, jobId, { now });
				else db.prepare("UPDATE storage_worker_lock SET owner='replacement-worker'").run();
				report({ ...progress, files: 1 });
				assert.equal(
					db.prepare('SELECT result FROM storage_jobs WHERE id=?').get(jobId).result,
					before
				);
				return { files: 1 };
			},
			prune() {
				assert.fail('unowned backup cannot prune');
			}
		});
		const before = db.prepare('SELECT result FROM storage_jobs WHERE id=?').get(jobId).result;
		report({ phase: 'preparing' });
		assert.equal(
			db.prepare('SELECT result FROM storage_jobs WHERE id=?').get(jobId).result,
			before
		);
		assert.notEqual(
			db.prepare('SELECT status FROM storage_jobs WHERE id=?').get(jobId).status,
			'succeeded'
		);
	});
}

test('storage worker owns a durable lease, retries failures and resumes interrupted jobs', async (t) => {
	const { db, settings } = fixture(t);
	saveStorageSettings(db, { ...settings, archiveEnabled: false });
	let backups = 0;
	const options = {
		now,
		runArchive: async () => ({ copied: 0, evicted: 0, syncPending: 0 }),
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
	assert.equal(backups, 1);
	assert.equal(
		db.prepare("SELECT status FROM storage_jobs WHERE kind='full'").get().status,
		'succeeded'
	);
	db.prepare("UPDATE storage_jobs SET status='running' WHERE kind='full'").run();
	await processStorageJob(db, { ...options, now: failed.retry_at + 1 });
	await processStorageJob(db, { ...options, now: failed.retry_at + 1 });
	assert.equal(
		db.prepare("SELECT status FROM storage_jobs WHERE kind='full'").get().status,
		'succeeded'
	);
	assert.equal(backups, 2);
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
	assert.equal(queueStorageJob(db, 'restore', { now, backupId, audioMode: 'download' }), id);
	assert.throws(
		() => queueStorageJob(db, 'restore', { backupId, audioMode: 'remote' }),
		/existing restore/
	);
	for (const audioMode of [null, '', 'REMOTE', 'local', '../outside', 1, {}, ['remote']])
		assert.throws(() => queueStorageJob(db, 'restore', { backupId, audioMode }), /audio mode/);
	assert.throws(
		() => queueStorageJob(db, 'restore', { backupId: `${now}-${randomUUID()}` }),
		/existing restore/
	);
	assert.equal(
		db.prepare('SELECT backup_id FROM storage_restore_requests WHERE job_id=?').get(id).backup_id,
		backupId
	);
	assert.equal(
		db.prepare('SELECT audio_mode FROM storage_restore_requests WHERE job_id=?').get(id).audio_mode,
		'download'
	);
	assert.equal(storageStatus(db, now).jobs[0].audioMode, 'download');
	scheduleStorageJobs(db, now);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 1);
});

test('restore audio schema migrates existing requests to download and enforces supported modes', (t) => {
	const db = new Database(':memory:');
	t.after(() => db.close());
	db.exec(`CREATE TABLE storage_restore_requests (
		job_id INTEGER PRIMARY KEY REFERENCES storage_jobs(id) ON DELETE CASCADE,
		backup_id TEXT NOT NULL
	)`);
	initializeSchema(db, schema);
	db.exec("INSERT INTO storage_jobs(kind,created_at) VALUES('restore',1)");
	db.prepare('INSERT INTO storage_restore_requests(job_id,backup_id) VALUES(1,?)').run('legacy');
	// Simulate the deployed table before the audio-mode migration.
	db.exec('ALTER TABLE storage_restore_requests DROP COLUMN audio_mode');
	initializeSchema(db, schema);
	initializeSchema(db, schema);
	assert.deepEqual(db.prepare('SELECT * FROM storage_restore_requests').get(), {
		job_id: 1,
		backup_id: 'legacy',
		audio_mode: 'download'
	});
	for (const mode of [null, '', 'REMOTE', 'local'])
		assert.throws(() => db.prepare('UPDATE storage_restore_requests SET audio_mode=?').run(mode));
	db.prepare("UPDATE storage_restore_requests SET audio_mode='remote'").run();
	initializeSchema(db, schema);
	assert.equal(
		db.prepare('SELECT audio_mode FROM storage_restore_requests').get().audio_mode,
		'remote'
	);
	assert.equal(db.prepare('SELECT status FROM storage_jobs WHERE id=1').get().status, 'pending');
	assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('remote restore mode survives restart, deduplication and retry and publishes only safe counts', async (t) => {
	const { db, settings, directory } = fixture(t);
	saveStorageSettings(db, { ...settings, enabled: false });
	const backupId = `${now}-${randomUUID()}`;
	const id = queueStorageJob(db, 'restore', { now, backupId, audioMode: 'remote' });
	assert.equal(queueStorageJob(db, 'restore', { backupId, audioMode: 'remote' }), id);
	assert.equal(storageStatus(db, now).jobs[0].audioMode, 'remote');
	await processStorageJob(db, {
		now,
		prepareRestore: async (_connection, { audioMode }) => {
			assert.equal(audioMode, 'remote');
			throw new Error('synthetic-private-error');
		}
	});
	assert.equal(db.prepare('SELECT status FROM storage_jobs WHERE id=?').get(id).status, 'failed');
	const filename = join(directory, 'restore-requests.db');
	writeFileSync(filename, db.serialize());
	const reopened = new Database(filename);
	try {
		initializeSchema(reopened, schema);
		assert.throws(
			() => queueStorageJob(reopened, 'restore', { backupId, audioMode: 'download' }),
			/existing restore/
		);
		assert.equal(
			queueStorageJob(reopened, 'restore', { now, backupId, audioMode: 'remote', retryNow: true }),
			id
		);
		assert.equal(
			reopened.prepare('SELECT retry_at FROM storage_jobs WHERE id=?').get(id).retry_at,
			now
		);
		const restoreId = randomUUID();
		await processStorageJob(reopened, {
			now,
			prepareRestore: async (_connection, { backupId: savedId, audioMode, onProgress }) => {
				assert.equal(savedId, backupId);
				assert.equal(audioMode, 'remote');
				const initial = JSON.parse(
					reopened.prepare('SELECT result FROM storage_jobs WHERE id=?').get(id).result
				);
				assert.equal(initial.audioMode, 'remote');
				onProgress({
					...initial,
					phase: 'complete',
					audioMode: 'download',
					privateValue: 'synthetic-private'
				});
				return {
					restoreId,
					audioMode,
					files: 7,
					remoteAudioFiles: 3,
					privateValue: 'synthetic-private'
				};
			}
		});
		const saved = reopened.prepare('SELECT * FROM storage_jobs WHERE id=?').get(id);
		assert.equal(saved.status, 'succeeded');
		assert.equal(saved.attempts, 2);
		assert.equal(JSON.parse(saved.result).audioMode, 'remote');
		assert.equal(JSON.parse(saved.result).remoteAudioFiles, 3);
		const status = storageStatus(reopened, now);
		assert.equal(status.jobs[0].audioMode, 'remote');
		assert.equal(status.jobs[0].remoteAudioFiles, 3);
		assert.equal(status.preparedRestores[0].audioMode, 'remote');
		assert.equal(status.preparedRestores[0].remoteAudioFiles, 3);
		assert.equal(status.preparedRestores[0].directory, `restore-staging/${restoreId}`);
		assert.ok(!JSON.stringify(status).includes('synthetic-private'));
		assert.ok(!saved.result.includes('synthetic-private'));
	} finally {
		reopened.close();
	}
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
				assert.equal(options.audioMode, 'download');
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

test('restore preparation persists safe live counts with bounded writes and retains the completed location', async (t) => {
	const { db, settings } = fixture(t);
	saveStorageSettings(db, { ...settings, enabled: false });
	t.mock.timers.enable({ apis: ['Date'], now: now * 1000 });
	const backupId = `${now}-${randomUUID()}`;
	const restoreId = randomUUID();
	const id = queueStorageJob(db, 'restore', { now, backupId });
	let report;
	const read = () => db.prepare('SELECT result FROM storage_jobs WHERE id=?').get(id).result;
	const progress = {
		phase: 'downloading',
		downloadedObjects: 1,
		totalObjects: 2,
		restoredFiles: 0,
		totalFiles: 3,
		downloadedBytes: 100,
		verificationBytes: 100,
		elapsedSeconds: 1,
		lastActivityAt: now + 1
	};
	await processStorageJob(db, {
		now,
		prepareRestore: async (_connection, { onProgress }) => {
			report = onProgress;
			assert.equal(JSON.parse(read()).phase, 'preparing');
			t.mock.timers.tick(1_000);
			onProgress({
				...progress,
				path: 'synthetic-private-patient',
				error: 'synthetic-private-error'
			});
			const persisted = read();
			assert.deepEqual(JSON.parse(persisted), { ...progress, audioMode: 'download' });
			assert.match(storageStatus(db, now + 1).jobs[0].progress, /objects downloaded: 1\/2/);
			assert.equal(storageStatus(db, now + 1).jobs[0].restoreDirectory, null);
			for (let i = 0; i < 100; i++) onProgress({ ...progress, downloadedBytes: 101 + i });
			assert.equal(read(), persisted);
			t.mock.timers.tick(1_000);
			for (const invalid of [
				{ ...progress, phase: 'synthetic-private-patient' },
				{ ...progress, downloadedBytes: 'synthetic-private-path' },
				{ ...progress, restoredFiles: 4 }
			])
				onProgress(invalid);
			assert.equal(read(), persisted);
			onProgress({ ...progress, phase: 'complete', downloadedObjects: 2, restoredFiles: 3 });
			assert.equal(JSON.parse(read()).restoredFiles, 3);
			return { id: backupId, restoreId, files: 3, path: 'synthetic-private-path' };
		}
	});
	const final = read();
	const status = storageStatus(db, now + 2);
	assert.equal(status.jobs[0].status, 'succeeded');
	assert.match(status.jobs[0].progress, /Phase: complete/);
	assert.match(status.jobs[0].progress, /files restored and verified: 3\/3/);
	assert.equal(status.jobs[0].restoreDirectory, `restore-staging/${restoreId}`);
	assert.equal(status.preparedRestores[0].directory, `restore-staging/${restoreId}`);
	assert.ok(!final.includes('synthetic-private'));
	assert.ok(!JSON.stringify(status).includes('synthetic-private'));
	report({ ...progress, phase: 'complete' });
	assert.equal(read(), final);
});

test('cancelled or unowned restore callbacks cannot persist more progress or publish a location', async (t) => {
	for (const reason of ['cancel', 'lease'])
		await t.test(reason, async (t) => {
			const { db, settings } = fixture(t);
			saveStorageSettings(db, { ...settings, enabled: false });
			const backupId = `${now}-${randomUUID()}`;
			const id = queueStorageJob(db, 'restore', { now, backupId });
			await processStorageJob(db, {
				now,
				prepareRestore: async (_connection, { onProgress, owned }) => {
					const before = db.prepare('SELECT result FROM storage_jobs WHERE id=?').get(id).result;
					if (reason === 'cancel') cancelStorageJob(db, id, { now });
					else db.prepare('DELETE FROM storage_worker_lock').run();
					assert.equal(owned(), false);
					onProgress({ ...JSON.parse(before), phase: 'complete' });
					assert.equal(
						db.prepare('SELECT result FROM storage_jobs WHERE id=?').get(id).result,
						before
					);
					return { id: backupId, restoreId: randomUUID(), files: 0 };
				}
			});
			assert.notEqual(storageStatus(db, now).jobs[0].status, 'succeeded');
			assert.equal(storageStatus(db, now).jobs[0].restoreDirectory, null);
			assert.deepEqual(storageStatus(db, now).preparedRestores, []);
		});
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
	const ids = ['test', 'archive', 'full'].map((kind) => queueStorageJob(db, kind, { now }));
	ids.push(
		Number(
			db.prepare("INSERT INTO storage_jobs(kind,created_at) VALUES('database',?)").run(now)
				.lastInsertRowid
		)
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

async function seedSyncedResetReport(context) {
	const { db, connection, objects, client } = context;
	const objectKey = `${'c'.repeat(64)}.enc`;
	const remote = `${connection.root}/files/objects/${objectKey}`;
	await client.mkdir(`${connection.root}/files/objects`);
	objects.set(remote, Buffer.from('synthetic encrypted report'));
	const destination = storageDestination(connection);
	db.prepare(
		`INSERT INTO storage_file_objects(destination,object_key,sha256,remote_sha256,bytes,encrypted_bytes,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?)`
	).run(
		destination,
		objectKey,
		'a'.repeat(64),
		'b'.repeat(64),
		10,
		objects.get(remote).length,
		now,
		now
	);
	db.prepare(
		'INSERT INTO storage_file_catalog(path,original,destination,object_key,synced_at) VALUES(?,?,?,?,?)'
	).run('reports/synthetic.docx', 'uploads/reports/synthetic.docx', destination, objectKey, now);
	db.prepare('INSERT INTO storage_file_queue(path,queued_at) VALUES(?,?)').run(
		'reports/synthetic.docx',
		now
	);
	return remote;
}

function syncedResetRows(db) {
	return Object.fromEntries(
		['storage_file_queue', 'storage_file_catalog', 'storage_file_objects'].map((table) => [
			table,
			db.prepare(`SELECT * FROM ${table}`).all()
		])
	);
}

test('reset removes synchronized objects and tracking only after archived audio recovery', async (t) => {
	const context = resetFixture(t);
	const { db, connection, options, audio, objects, folders, client, run } = context;
	await archiveAudio(db, connection, options);
	unlinkSync(audio);
	db.prepare('UPDATE storage_audio SET evicted_at=?').run(now);
	const remote = await seedSyncedResetReport(context);
	await client.mkdir('/radiology/backups/objects');
	objects.set(`/radiology/backups/objects/${'d'.repeat(64)}.enc`, objects.get(remote));
	objects.set('/radiology/unrelated.txt', Buffer.from('leave alone'));
	const before = syncedResetRows(db);
	const deleted = [];
	const removedFolders = [];
	const remove = client.delete;
	client.delete = async (path) => {
		assert.equal(readFileSync(audio, 'utf8'), 'synthetic audio');
		assert.equal(db.prepare('SELECT restored FROM storage_reset_requests').get().restored, 1);
		assert.deepEqual(syncedResetRows(db), before);
		deleted.push(path);
		return remove(path);
	};
	const rmdir = client.rmdir;
	client.rmdir = async (path, recursive) => {
		assert.deepEqual(syncedResetRows(db), before);
		removedFolders.push(path);
		return rmdir(path, recursive);
	};
	queueStorageReset(db, { now });
	await run();
	assert.equal(storageStatus(db, now).jobs[0].status, 'succeeded');
	assert.equal(readFileSync(audio, 'utf8'), 'synthetic audio');
	assert.equal(deleted.length, 3);
	assert.ok(deleted.includes(remote));
	assert.ok(
		removedFolders.indexOf('/radiology/backups') <
			removedFolders.indexOf('/radiology/files/objects')
	);
	assert.ok(
		removedFolders.indexOf('/radiology/files/objects') < removedFolders.indexOf('/radiology/files')
	);
	assert.deepEqual([...folders], ['/', '/radiology']);
	assert.deepEqual([...objects.keys()], ['/radiology/unrelated.txt']);
	assert.deepEqual(syncedResetRows(db), {
		storage_file_queue: [],
		storage_file_catalog: [],
		storage_file_objects: []
	});
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 0);
	assert.equal(getStorageSettings(db).enabled, false);
});

for (const unexpected of [
	'files/unexpected.txt',
	'files/objects/not-an-object.enc',
	'files/unexpected-directory'
]) {
	test(`reset rejects ${unexpected} without deleting remote objects or synchronization tracking`, async (t) => {
		const context = resetFixture(t);
		const { db, connection, options, audio, objects, client, run } = context;
		await archiveAudio(db, connection, options);
		unlinkSync(audio);
		await seedSyncedResetReport(context);
		if (unexpected.endsWith('directory')) await client.mkdir(`${connection.root}/${unexpected}`);
		else objects.set(`${connection.root}/${unexpected}`, Buffer.from('unrelated'));
		const before = syncedResetRows(db);
		const remoteBefore = new Map(objects);
		client.delete = async () =>
			assert.fail('Unexpected namespace entry must block all remote deletion');
		queueStorageReset(db, { now });
		await run();
		assert.equal(storageStatus(db, now).jobs[0].status, 'failed');
		assert.equal(readFileSync(audio, 'utf8'), 'synthetic audio');
		assert.deepEqual(objects, remoteBefore);
		assert.deepEqual(syncedResetRows(db), before);
		assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 1);
		assert.equal(db.prepare('SELECT phase FROM storage_reset_requests').get().phase, 'recovering');
	});
}

test('failed audio recovery preserves synchronized remote objects and all file tracking', async (t) => {
	const context = resetFixture(t);
	const { db, connection, options, audio, objects, client, run } = context;
	await archiveAudio(db, connection, options);
	unlinkSync(audio);
	const audioRemote = [...objects.keys()][0];
	await seedSyncedResetReport(context);
	objects.set(audioRemote, Buffer.from('corrupted ciphertext'));
	const before = syncedResetRows(db);
	const remoteBefore = new Map(objects);
	client.delete = async () => assert.fail('Audio recovery must finish before remote deletion');
	queueStorageReset(db, { now });
	await run();
	assert.equal(storageStatus(db, now).jobs[0].status, 'failed');
	assert.equal(existsSync(audio), false);
	assert.deepEqual(objects, remoteBefore);
	assert.deepEqual(syncedResetRows(db), before);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 1);
});

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

test('background job types rotate fairly instead of starving full backups behind file synchronization', async (t) => {
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
		for (const kind of ['archive', 'full']) queueStorageJob(db, kind, { now: at });
		await processStorageJob(db, { ...options, now: at });
	}
	assert.deepEqual(calls, ['full', 'archive', 'full', 'archive', 'full', 'archive']);
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
	assert.match(
		storageStatus(db, now).jobs[0].error,
		/Recovering local audio 1\/1: Local audio differs/
	);
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

test('reset removes unfinished indexes only after verified audio recovery and retries safely', async (t) => {
	const { db, connection, options, audio, objects, client, run } = resetFixture(t);
	await archiveAudio(db, connection, options);
	unlinkSync(audio);
	await client.mkdir('/radiology/backups/indexes');
	const pending = `/radiology/backups/indexes/${now}-${randomUUID()}.pending`;
	objects.set(pending, Buffer.from('unfinished backup'));
	writeFileSync(audio, 'changed local audio');
	const remove = client.delete;
	client.delete = async (...args) => {
		assert.equal(readFileSync(audio, 'utf8'), 'synthetic audio');
		assert.equal(db.prepare('SELECT phase FROM storage_reset_requests').get().phase, 'cleaning');
		return remove(...args);
	};
	const before = new Map(objects);
	const id = queueStorageReset(db, { now });
	await run();
	const job = storageStatus(db, now).jobs.find((row) => row.id === id);
	assert.equal(job.status, 'failed');
	assert.match(job.error, /Recovering local audio 1\/1: Local audio differs/);
	assert.match(job.progress, /audio 0\/1, remote files removed 0/);
	assert.equal(readFileSync(audio, 'utf8'), 'changed local audio');
	assert.deepEqual(objects, before);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 1);
	assert.equal(
		db.prepare('SELECT phase FROM storage_reset_requests WHERE job_id=?').get(id).phase,
		'recovering'
	);
	unlinkSync(audio);
	const retry = db.prepare('SELECT retry_at FROM storage_jobs WHERE id=?').get(id).retry_at;
	await run(retry);
	const completed = storageStatus(db, retry).jobs.find((row) => row.id === id);
	assert.equal(completed.status, 'succeeded');
	assert.equal(completed.error, null);
	assert.equal(readFileSync(audio, 'utf8'), 'synthetic audio');
	assert.equal(objects.size, 0);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 0);
});

for (const invalid of [
	'malformed name',
	'wrong namespace',
	'listed symlink',
	'listed directory',
	'changed symlink',
	'changed directory'
]) {
	test(`reset refuses ${invalid} pending indexes without deleting remote data`, async (t) => {
		const { db, connection, options, audio, objects, client, run } = resetFixture(t);
		await archiveAudio(db, connection, options);
		unlinkSync(audio);
		const name = `${now}-${randomUUID()}${invalid === 'malformed name' ? '.full' : ''}.pending`;
		const folder =
			invalid === 'wrong namespace' ? '/radiology/files/objects' : '/radiology/backups/indexes';
		await client.mkdir(folder);
		const pending = `${folder}/${name}`;
		objects.set(pending, Buffer.from('unfinished backup'));
		if (invalid.startsWith('listed')) {
			const list = client.list;
			client.list = async (path) =>
				(await list(path)).map((entry) =>
					path === folder && entry.name === name
						? { ...entry, type: invalid === 'listed symlink' ? 'l' : 'd' }
						: entry
				);
		} else if (invalid.startsWith('changed')) {
			const attributes = client.lstat;
			client.lstat = async (path) =>
				path === pending
					? {
							isFile: false,
							isSymbolicLink: invalid === 'changed symlink',
							isDirectory: invalid === 'changed directory'
						}
					: attributes(path);
		}
		const before = new Map(objects);
		queueStorageReset(db, { now });
		await run();
		const job = storageStatus(db, now).jobs[0];
		assert.equal(job.status, 'failed');
		assert.match(
			job.error,
			invalid.startsWith('changed') ? /Remote storage changed/ : /Unexpected entry/
		);
		assert.match(job.progress, /audio 1\/1, remote files removed 0/);
		assert.deepEqual(objects, before);
		assert.equal(readFileSync(audio, 'utf8'), 'synthetic audio');
		assert.equal(
			db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n,
			invalid.startsWith('changed') ? 0 : 1
		);
	});
}

for (const scenario of ['pending', 'unexpected', 'permission']) {
	test(`reset handles ${scenario} indexes through the real sanitizing transport`, async (t) => {
		const { db, settings, options, audio, objects, client, directory } = resetFixture(t);
		const hostKey = Buffer.from('synthetic reset SSH host key');
		const fingerprint = `SHA256:${createHash('sha256').update(hostKey).digest('base64').replace(/=$/, '')}`;
		saveStorageSettings(db, { ...settings, fingerprint });
		const connection = getStorageConnection(db);
		await archiveAudio(db, connection, options);
		unlinkSync(audio);
		await client.mkdir('/radiology/backups/indexes');
		if (scenario !== 'permission')
			objects.set(
				`/radiology/backups/indexes/${scenario === 'pending' ? `${now}-${randomUUID()}.pending` : 'unknown.pending'}`,
				Buffer.from('unfinished')
			);
		else {
			const list = client.list;
			client.list = async (path) => {
				if (path === '/radiology/backups/indexes')
					throw Object.assign(new Error('synthetic-password private-patient-path'), { code: 3 });
				return list(path);
			};
		}
		const before = new Map(objects);
		let activeSessions = 0;
		let maximumSessions = 0;
		const transport = (config, action) =>
			withStorage(config, action, () => {
				let active = false;
				const close = () => {
					if (active) activeSessions--;
					active = false;
				};
				return {
					...client,
					async connect(config) {
						assert.equal(config.hostVerifier(hostKey), true);
						active = true;
						maximumSessions = Math.max(maximumSessions, ++activeSessions);
					},
					async end() {
						close();
					},
					destroy: close
				};
			});
		const id = queueStorageReset(db, { now });
		await processStorageJob(db, {
			now,
			resetStorage: (database, config, resetOptions) =>
				resetStorageData(database, config, {
					...resetOptions,
					roots: [directory],
					transport
				})
		});
		const job = storageStatus(db, now).jobs.find((row) => row.id === id);
		assert.equal(maximumSessions, Math.min(storageParallelConnections(connection), 4));
		assert.equal(activeSessions, 0);
		assert.equal(readFileSync(audio, 'utf8'), 'synthetic audio');
		if (scenario === 'pending') {
			assert.equal(job.status, 'succeeded');
			assert.equal(job.error, null);
			assert.equal(objects.size, 0);
			assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 0);
		} else {
			assert.equal(job.status, 'failed');
			assert.match(job.error, /Inspecting remote backups\/indexes:/);
			assert.match(
				job.error,
				scenario === 'unexpected'
					? /unrecognized file name or entry type/
					: /Remote permission denied \(SFTP status 3\)/
			);
			assert.doesNotMatch(job.error, /synthetic-password|private-patient-path|storage.invalid/);
			assert.match(job.progress, /audio 1\/1, remote files removed 0/);
			assert.deepEqual(objects, before);
			assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 1);
		}
	});
}

for (const [code, expected] of [
	[3, /Remote permission denied \(SFTP status 3\)/],
	['EACCES', /Permission denied \(EACCES\)/],
	['ENOSPC', /Insufficient local disk space \(ENOSPC\)/],
	['ETIMEDOUT', /Storage operation timed out \(ETIMEDOUT\)/],
	[undefined, /sensitive error details were withheld/],
	['synthetic-secret-code', /sensitive error details were withheld/]
]) {
	test(`reset reports inspection failure ${code ?? 'without a code'} without leaking transport details`, async (t) => {
		const { db, connection, options, objects, client, run } = resetFixture(t);
		await archiveAudio(db, connection, options);
		const before = new Map(objects);
		client.list = async () => {
			throw Object.assign(new Error('synthetic-password private-patient-path'), { code });
		};
		queueStorageReset(db, { now });
		await run();
		const job = storageStatus(db, now).jobs[0];
		assert.equal(job.status, 'failed');
		assert.match(job.error, /Inspecting remote audio:/);
		assert.match(job.error, expected);
		assert.doesNotMatch(
			job.error,
			/synthetic-password|private-patient-path|synthetic-secret-code|storage.invalid/
		);
		assert.deepEqual(objects, before);
		assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 1);
	});
}

test('reset identifies final local audio recheck failures without deleting remote data', async (t) => {
	const { db, connection, options, audio, objects, resetOptions } = resetFixture(t);
	await archiveAudio(db, connection, options);
	const id = queueStorageReset(db, { now });
	let changed = false;
	await assert.rejects(
		resetStorageData(db, connection, {
			...resetOptions,
			jobId: id,
			owned() {
				if (
					!changed &&
					db.prepare('SELECT restored FROM storage_reset_requests WHERE job_id=?').get(id)
						.restored === 1
				) {
					writeFileSync(audio, 'changed after recovery');
					changed = true;
				}
				return true;
			}
		}),
		/Rechecking recovered local audio 1\/1: Local audio differs/
	);
	assert.equal(objects.size, 1);
	assert.equal(
		db.prepare('SELECT restored FROM storage_reset_requests WHERE job_id=?').get(id).restored,
		1
	);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 1);
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

for (const stage of ['connect', 'root', 'list', 'get', 'delete', 'rmdir']) {
	test(
		`reset cancellation aborts stalled ${stage} and prevents late cleanup`,
		{ timeout: 5_000 },
		async (t) => {
			const { db, settings, options, audio, objects, client, directory } = resetFixture(t);
			const hostKey = Buffer.from('synthetic cancellable reset host key');
			const fingerprint = `SHA256:${createHash('sha256').update(hostKey).digest('base64').replace(/=$/, '')}`;
			saveStorageSettings(db, { ...settings, fingerprint, parallelConnections: 1 });
			await archiveAudio(db, getStorageConnection(db), options);
			unlinkSync(audio);
			await client.mkdir('/radiology/backups/indexes');
			const entered = Promise.withResolvers();
			const blocked = Promise.withResolvers();
			const aborted = Promise.withResolvers();
			let recoveryDirectory;
			t.after(() => blocked.resolve());
			let destroyed = 0;
			let ended = 0;
			const session = {
				...client,
				async connect(config) {
					assert.equal(config.hostVerifier(hostKey), true);
					if (stage === 'connect') {
						entered.resolve();
						await blocked.promise;
					}
				},
				destroy() {
					destroyed++;
					aborted.resolve();
				},
				end() {
					ended++;
					return blocked.promise;
				}
			};
			const method = stage === 'root' ? 'lstat' : stage;
			if (stage !== 'connect') {
				const original = session[method];
				session[method] = async (...args) => {
					if (
						(stage === 'root' && args[0] !== '/') ||
						(stage === 'list' && args[0] !== '/radiology/backups/indexes')
					)
						return original(...args);
					if (stage === 'get') recoveryDirectory = join(args[1], '..');
					entered.resolve();
					await blocked.promise;
					return stage === 'root' ? { isDirectory: true } : stage === 'list' ? [] : undefined;
				};
			}
			const id = queueStorageReset(db, { now });
			const running = processStorageJob(db, {
				now,
				resetStorage: (database, config, resetOptions) =>
					resetStorageData(database, config, {
						...resetOptions,
						roots: [directory],
						transport: (config, action) => withStorage(config, action, () => session)
					})
			});
			await entered.promise;
			const before = new Map(objects);
			const metadata = db.prepare('SELECT * FROM storage_reset_requests WHERE job_id=?').get(id);
			let settled = false;
			running.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				}
			);
			cancelStorageJob(db, id, { now });
			await aborted.promise;
			if (!['connect', 'root'].includes(stage)) {
				await new Promise((resolve) => setImmediate(resolve));
				assert.equal(settled, false, 'reset must drain the blocked callback before returning');
				assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_worker_lock').get().n, 1);
				assert.deepEqual(objects, before);
				assert.deepEqual(
					db.prepare('SELECT * FROM storage_reset_requests WHERE job_id=?').get(id),
					metadata
				);
				if (recoveryDirectory) assert.ok(existsSync(recoveryDirectory));
				blocked.resolve();
			}
			await running;
			if (recoveryDirectory) assert.equal(existsSync(recoveryDirectory), false);
			assert.equal(destroyed, 1);
			assert.equal(ended, 0);
			assert.equal(storageStatus(db, now).jobs.find((job) => job.id === id).status, 'cancelled');
			assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_worker_lock').get().n, 0);
			assert.deepEqual(objects, before);
			assert.deepEqual(
				db.prepare('SELECT * FROM storage_reset_requests WHERE job_id=?').get(id),
				metadata
			);
			blocked.resolve();
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.deepEqual(objects, before);
			assert.deepEqual(
				db.prepare('SELECT * FROM storage_reset_requests WHERE job_id=?').get(id),
				metadata
			);
			assert.equal(getStorageSettings(db).enabled, false);
			if (!['connect', 'root', 'get'].includes(stage))
				assert.equal(readFileSync(audio, 'utf8'), 'synthetic audio');
		}
	);
}

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
