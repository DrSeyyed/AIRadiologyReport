import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setImmediate } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { syncStorageData, remoteFileStat, ensureFileDirectory } from '../src/lib/server/storage-sync.js';
import { storageDestination } from '../src/lib/server/storage-settings.js';

const connection = {
	host: 'storage.invalid', port: 22, username: 'backup', root: '/vault',
	fingerprint: 'test-fingerprint', integrityAuditDays: 7
};
const initialTime = 1800000000;
const week = 7 * 86400;
const digest = (data) => createHash('sha256').update(data).digest('hex');
const failed = /Storage synchronization failed\./;

async function fixture(t, settings = connection) {
	const root = path.join(process.cwd(), 'tests', `.storage-sync-${randomUUID()}`);
	const cwd = path.join(root, 'app');
	const remote = path.join(root, 'remote');
	await fs.mkdir(path.join(cwd, 'uploads', 'audio'), { recursive: true });
	await fs.mkdir(remote);
	const db = new Database(path.join(root, 'state.sqlite'));
	t.after(async () => {
		if (db.open) db.close();
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	const calls = { puts: [], hashes: [], links: [], deletes: [], encryptions: [], decryptions: [], stats: [], sessions: 0, keyChecks: 0 };
	const hooks = {};
	const progress = [];
	const local = (target) => {
		assert.equal(typeof target, 'string');
		assert.ok(target.startsWith('/vault/'), `Unexpected remote path: ${target}`);
		assert.ok(!target.includes('\\') && !target.split('/').includes('..'));
		return path.join(remote, ...target.slice('/vault/'.length).split('/'));
	};
	const client = {
		async mkdir(target) {
			if (hooks.mkdir) return hooks.mkdir(target);
			await fs.mkdir(local(target), { recursive: true });
		},
		async lstat(target) {
			calls.stats.push(target);
			if (hooks.lstat) {
				const result = await hooks.lstat(target);
				if (result !== undefined) return result;
			}
			const stat = await fs.lstat(local(target));
			return {
				size: stat.size,
				isFile: stat.isFile(),
				isDirectory: stat.isDirectory(),
				isSymbolicLink: stat.isSymbolicLink()
			};
		},
		async put(source, target) {
			calls.puts.push(target);
			if (hooks.beforePut) await hooks.beforePut(source, target);
			await pipeline(source, createWriteStream(local(target)));
			if (hooks.afterPut) await hooks.afterPut(source, target);
		},
		async delete(target) {
			calls.deletes.push(target);
			await fs.unlink(local(target));
		},
		async get() { assert.fail('Synchronization must not download remote objects.'); },
		createReadStream() { assert.fail('Synchronization must not read remote objects back.'); }
	};
	const injected = {
		async withStorage(config, callback) {
			assert.equal(config, settings);
			calls.sessions++;
			return callback(client);
		},
		storagePath(config, ...segments) { return path.posix.join(config.root, ...segments); },
		async assertStorageKey() { calls.keyChecks++; },
		async encryptFile(source, target) {
			calls.encryptions.push(source);
			if (hooks.encrypt) return hooks.encrypt(source, target);
			await fs.copyFile(source, target);
		},
		async decryptFile(source, target) {
			calls.decryptions.push(source);
			await fs.copyFile(source, target);
		},
		async hashStorageFile(worker, target, config, options) {
			calls.hashes.push(target);
			options.assertActive();
			if (hooks.hash) return hooks.hash(target);
			return digest(await fs.readFile(local(target)));
		},
		async linkStorageFile(worker, source, target, config, options) {
			options.assertActive();
			calls.links.push([source, target]);
			await fs.link(local(source), local(target));
		}
	};
	const run = (options = {}) => syncStorageData(db, settings, {
		cwd, env: {}, voiceSaveDir: 'uploads/audio', owned: () => true,
		now: initialTime, archiveAudio: false, onProgress: (state) => progress.push(state), ...options
	}, injected);
	const write = async (relative, content) => {
		const target = path.join(cwd, ...relative.split('/'));
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, content);
		return target;
	};
	const catalog = (relative) => db.prepare('SELECT * FROM storage_file_catalog WHERE path=?').get(relative);
	const objects = () => db.prepare('SELECT * FROM storage_file_objects ORDER BY object_key').all();
	const queue = () => db.prepare('SELECT * FROM storage_file_queue ORDER BY path').all();
	const clean = async () => assert.deepEqual((await fs.readdir(cwd)).filter((name) => name.startsWith('.storage-sync-work-')), []);
	async function archived(relative, { payload = 'archived audio', ciphertext = 'encrypted archived audio', evicted = true } = {}) {
		db.exec(`CREATE TABLE IF NOT EXISTS storage_audio (
			path TEXT PRIMARY KEY, object_key TEXT, sha256 TEXT, remote_sha256 TEXT,
			bytes INTEGER, archived_at INTEGER, evicted_at INTEGER, destination TEXT)`);
		const key = `${randomUUID()}.enc`;
		await fs.mkdir(path.join(remote, 'audio'), { recursive: true });
		const target = path.join(remote, 'audio', key);
		await fs.writeFile(target, ciphertext);
		if (!evicted) await write(relative, payload);
		db.prepare('INSERT INTO storage_audio VALUES(?,?,?,?,?,?,?,?)').run(
			relative, key, digest(payload), digest(ciphertext), Buffer.byteLength(payload),
			initialTime - 100, evicted ? initialTime - 50 : null, storageDestination(settings)
		);
		return { key, target, payload, ciphertext, objectKey: `${digest(ciphertext)}.enc` };
	}
	return { root, cwd, remote, db, calls, hooks, client, injected, progress, local, run, write, catalog, objects, queue, clean, archived };
}

function scopedEnvironment(t, values) {
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	const apply = (entries) => {
		for (const [key, value] of Object.entries(entries)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	apply(values);
	t.after(() => apply(previous));
}

async function audioFixture(t) {
	const f = await fixture(t, { ...connection, archiveEnabled: true, localRetentionDays: 30 });
	const work = path.join(f.root, 'archive-work');
	await fs.mkdir(work);
	scopedEnvironment(t, { TEMP: work, TMP: work, TMPDIR: work, STORAGE_ENCRYPTION_KEY: undefined });
	f.db.exec(`
		CREATE TABLE study_recordings (
			id INTEGER PRIMARY KEY, audio_report_path TEXT, created_at TEXT, processing INTEGER);
		CREATE TABLE recording_audio_parts (
			id INTEGER PRIMARY KEY, recording_id INTEGER, audio_report_path TEXT, created_at TEXT);
		CREATE TABLE storage_audio (
			path TEXT PRIMARY KEY, object_key TEXT, sha256 TEXT, remote_sha256 TEXT,
			bytes INTEGER, archived_at INTEGER, evicted_at INTEGER, destination TEXT);
		CREATE TABLE storage_jobs (id INTEGER PRIMARY KEY, kind TEXT, status TEXT, started_at INTEGER, result TEXT);
		CREATE TABLE storage_deleted_recovery_points (backup_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL);
	`);
	f.db.prepare('INSERT INTO storage_jobs(id,kind,status,started_at) VALUES(1,?,?,?)').run('full', 'succeeded', initialTime - 10);
	const recording = await f.write('uploads/audio/recording.ogg', 'referenced recording');
	const part = await f.write('uploads/audio/part.ogg', 'referenced recording part');
	f.db.prepare('INSERT INTO study_recordings VALUES(1,?,?,0)').run(recording, '2020-01-01 00:00:00');
	f.db.prepare('INSERT INTO recording_audio_parts VALUES(1,1,?,?)').run(part, '2020-01-01 00:00:00');
	return { ...f, recording, part, archiveWork: work };
}

for (const parallelConnections of [1, 4, 16]) {
	test(`synchronization bounds preparation, uploads and scheduled checksums to ${parallelConnections} workers`, async (t) => {
		const f = await fixture(t, { ...connection, parallelConnections });
		await Promise.all(Array.from({ length: 32 }, (_, i) => f.write(`uploads/file-${i}.txt`, `unique ${i}`)));
		let activeSessions = 0;
		let peakSessions = 0;
		f.injected.withStorage = async (_settings, action) => {
			peakSessions = Math.max(peakSessions, ++activeSessions);
			try { return await action({ ...f.client }); }
			finally { activeSessions--; }
		};
		function phase() {
			let release;
			const gate = new Promise((resolve) => { release = resolve; });
			const state = { active: 0, peak: 0, started: 0 };
			return {
				state,
				async track(operation) {
					state.peak = Math.max(state.peak, ++state.active);
					if (++state.started === parallelConnections) release();
					try {
						await gate;
						await setImmediate();
						return await operation();
					} finally { state.active--; }
				}
			};
		}
		const preparing = phase();
		const uploading = phase();
		let verifying = phase();
		f.hooks.encrypt = (source, target) => preparing.track(() => fs.copyFile(source, target));
		f.hooks.beforePut = () => uploading.track(async () => {});
		f.hooks.hash = (target) => verifying.track(async () => digest(await fs.readFile(f.local(target))));
		assert.equal((await f.run()).copied, 32);
		for (const stage of [preparing, uploading, verifying]) {
			assert.equal(stage.state.peak, parallelConnections);
			assert.equal(stage.state.active, 0);
			assert.equal(stage.state.started, 32);
		}
		verifying = phase();
		await f.run({ now: initialTime + week + 1 });
		assert.equal(verifying.state.peak, parallelConnections);
		assert.equal(verifying.state.started, 32);
		assert.equal(verifying.state.active, 0);
		assert.equal(peakSessions, parallelConnections);
		assert.equal(activeSessions, 0);
		assert.equal(f.calls.puts.length, 32);
		await f.clean();
	});
}

test('discovers nested uploads, synchronizes verified immutable objects and reports progress', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/reports/nested/report.md', 'report content');
	await f.write('uploads/audio/voice.ogg', 'audio content');
	await f.write('outside.txt', 'not a storage source');
	const result = await f.run();
	assert.equal(result.copied, 2);
	assert.equal(result.syncPending, 0);
	assert.equal(result.evicted, 0);
	assert.equal(f.calls.keyChecks, 1);
	assert.equal(f.calls.puts.length, 2);
	assert.equal(f.calls.hashes.length, 2);
	assert.equal(f.calls.decryptions.length, 0);
	assert.equal(f.objects().length, 2);
	for (const [relative, content] of [['uploads/reports/nested/report.md', 'report content'], ['uploads/audio/voice.ogg', 'audio content']]) {
		const entry = f.catalog(relative);
		assert.equal(entry.object_key, `${digest(content)}.enc`);
		assert.equal(entry.synced_at, initialTime);
		assert.equal(entry.deleted_at, null);
		assert.equal(await fs.readFile(path.join(f.remote, 'files', 'objects', entry.object_key), 'utf8'), content);
		const object = f.objects().find((row) => row.object_key === entry.object_key);
		assert.equal(object.sha256, digest(content));
		assert.equal(object.remote_sha256, digest(content));
		assert.equal(object.bytes, Buffer.byteLength(content));
		assert.equal(object.encrypted_bytes, Buffer.byteLength(content));
		assert.equal(object.verified_at, initialTime);
	}
	assert.ok(f.progress.length >= 2);
	assert.equal(f.progress.at(-1).copied, 2);
	for (const field of ['preparing', 'uploading', 'verifying']) assert.equal(f.progress.at(-1)[field], 0);
	assert.equal(result.verificationBytes, Buffer.byteLength('report contentaudio content'));
	assert.deepEqual(f.queue(), []);
	await f.clean();
});

test('unchanged sources do not upload, encrypt, stat objects or checksum before the weekly audit', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/report.md', 'unchanged');
	await f.run();
	const previous = f.catalog('uploads/report.md');
	f.calls.stats.length = 0;
	const result = await f.run({ now: initialTime + week - 1 });
	assert.equal(result.copied, 0);
	assert.equal(result.verificationBytes, 0);
	assert.equal(f.calls.puts.length, 1);
	assert.equal(f.calls.encryptions.length, 1);
	assert.equal(f.calls.hashes.length, 1);
	assert.ok(f.calls.stats.every((target) => !target.endsWith('.enc')));
	assert.deepEqual(f.catalog('uploads/report.md'), previous);
	assert.equal(f.objects()[0].verified_at, initialTime);
	await f.clean();
});

test('changed files create new immutable versions and never overwrite the previous object', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/report.md', 'version one');
	await f.run();
	const old = f.catalog('uploads/report.md');
	await f.write('uploads/report.md', 'version two, edited');
	await f.run({ now: initialTime + 1 });
	const current = f.catalog('uploads/report.md');
	assert.notEqual(current.object_key, old.object_key);
	assert.equal(f.objects().length, 2);
	assert.equal(await fs.readFile(path.join(f.remote, 'files', 'objects', old.object_key), 'utf8'), 'version one');
	assert.equal(await fs.readFile(path.join(f.remote, 'files', 'objects', current.object_key), 'utf8'), 'version two, edited');
	assert.equal(f.calls.puts.length, 2);
	assert.deepEqual(f.queue(), []);
});

test('identical content shares a verified object without uploading a second copy', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/first.md', 'shared content');
	await f.write('uploads/second.md', 'shared content');
	const result = await f.run();
	assert.equal(result.copied, 2);
	assert.equal(f.calls.puts.length, 1);
	assert.equal(f.calls.encryptions.length, 1);
	assert.equal(f.calls.hashes.length, 1);
	assert.equal(f.objects().length, 1);
	assert.equal(f.catalog('uploads/first.md').object_key, f.catalog('uploads/second.md').object_key);
});

test('deletions persist tombstones while retaining immutable objects; recreation clears the tombstone', async (t) => {
	const f = await fixture(t);
	const source = await f.write('uploads/report.md', 'keep old object');
	await f.run();
	const old = f.catalog('uploads/report.md');
	await fs.unlink(source);
	const result = await f.run({ now: initialTime + 1 });
	assert.equal(result.syncPending, 0);
	assert.equal(f.catalog('uploads/report.md').deleted_at, initialTime + 1);
	assert.equal(f.catalog('uploads/report.md').object_key, old.object_key);
	assert.equal(f.objects().length, 1);
	assert.equal(await fs.readFile(path.join(f.remote, 'files', 'objects', old.object_key), 'utf8'), 'keep old object');
	await f.write('uploads/report.md', 'replacement content');
	await f.run({ now: initialTime + 2 });
	assert.equal(f.catalog('uploads/report.md').deleted_at, null);
	assert.notEqual(f.catalog('uploads/report.md').object_key, old.object_key);
	assert.equal(f.objects().length, 2);
});

test('archive-only audio is linked remotely, not downloaded, encrypted or uploaded', async (t) => {
	const f = await fixture(t);
	const archived = await f.archived('uploads/audio/evicted.ogg');
	const result = await f.run();
	assert.equal(result.copied, 1);
	assert.equal(result.syncPending, 0);
	assert.deepEqual(f.calls.puts, []);
	assert.deepEqual(f.calls.encryptions, []);
	assert.deepEqual(f.calls.decryptions, []);
	assert.deepEqual(f.calls.links, [[`/vault/audio/${archived.key}`, `/vault/files/objects/${archived.objectKey}`]]);
	assert.equal(f.calls.hashes.length, 1);
	assert.equal(f.catalog('uploads/audio/evicted.ogg').state, null);
	assert.equal(f.catalog('uploads/audio/evicted.ogg').object_key, archived.objectKey);
	assert.equal(f.objects()[0].sha256, digest(archived.payload));
	assert.equal(f.objects()[0].remote_sha256, digest(archived.ciphertext));
	assert.equal(await fs.readFile(archived.target, 'utf8'), archived.ciphertext);
	const linked = path.join(f.remote, 'files', 'objects', archived.objectKey);
	assert.equal((await fs.stat(linked)).ino, (await fs.stat(archived.target)).ino);
	await f.run({ now: initialTime + 1 });
	assert.equal(f.calls.links.length, 1);
	assert.equal(f.calls.hashes.length, 1);
	await f.clean();
});

test('matching locally retained archived audio also reuses its encrypted remote object', async (t) => {
	const f = await fixture(t);
	await f.archived('uploads/audio/retained.ogg', { evicted: false });
	await f.run();
	assert.equal(f.calls.links.length, 1);
	assert.equal(f.calls.puts.length, 0);
	assert.equal(f.calls.encryptions.length, 0);
	assert.notEqual(f.catalog('uploads/audio/retained.ogg').state, null);
});

test('archive corruption is not acknowledged or recorded as a verified object', async (t) => {
	const f = await fixture(t);
	const archived = await f.archived('uploads/audio/corrupt.ogg');
	await fs.writeFile(archived.target, 'corrupted remote audio');
	await assert.rejects(f.run(), failed);
	assert.equal(f.objects().length, 0);
	assert.equal(f.catalog('uploads/audio/corrupt.ogg').object_key, null);
	assert.equal(f.queue().length, 1);
	assert.equal(f.calls.encryptions.length, 0);
	await f.clean();
});

test('failed uploads leave durable SQLite queue entries that a subsequent run retries', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/retry.md', 'retry payload');
	f.hooks.beforePut = async () => { throw new Error('simulated SFTP failure'); };
	await assert.rejects(f.run(), failed);
	assert.equal(f.queue().length, 1);
	assert.equal(f.catalog('uploads/retry.md').object_key, null);
	assert.equal(f.objects().length, 0);
	await f.clean();
	const observer = new Database(path.join(f.root, 'state.sqlite'));
	try { assert.equal(observer.prepare('SELECT COUNT(*) AS n FROM storage_file_queue').get().n, 1); }
	finally { observer.close(); }
	delete f.hooks.beforePut;
	const result = await f.run({ now: initialTime + 1 });
	assert.equal(result.copied, 1);
	assert.equal(result.syncPending, 0);
	assert.equal(f.calls.puts.length, 2);
	assert.equal(f.catalog('uploads/retry.md').synced_at, initialTime + 1);
	await f.clean();
});

test('failed upload checksum never acknowledges the source or writes verified metadata', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/report.md', 'expected payload');
	f.hooks.hash = async () => '0'.repeat(64);
	await assert.rejects(f.run(), failed);
	assert.equal(f.catalog('uploads/report.md').object_key, null);
	assert.equal(f.objects().length, 0);
	assert.equal(f.queue().length, 1);
	await f.clean();
	delete f.hooks.hash;
	await f.run({ now: initialTime + 1 });
	assert.equal(f.objects()[0].verified_at, initialTime + 1);
	assert.deepEqual(f.queue(), []);
});

test('source mutation after preparing a snapshot refuses acknowledgement and retries the current version', async (t) => {
	const f = await fixture(t);
	const source = await f.write('uploads/mutating.md', 'original snapshot');
	f.hooks.encrypt = async (plain, encrypted) => {
		await fs.writeFile(source, 'source changed during synchronization');
		await fs.copyFile(plain, encrypted);
	};
	await assert.rejects(f.run(), failed);
	assert.equal(f.catalog('uploads/mutating.md').object_key, null);
	assert.equal(f.catalog('uploads/mutating.md').synced_at, null);
	assert.equal(f.queue().length, 1);
	await f.clean();
	delete f.hooks.encrypt;
	await f.run({ now: initialTime + 1 });
	assert.equal(f.catalog('uploads/mutating.md').object_key, `${digest('source changed during synchronization')}.enc`);
	assert.deepEqual(f.queue(), []);
});

test('queue revisions added during upload are not accidentally acknowledged by older work', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/report.md', 'revision payload');
	f.hooks.afterPut = async () => {
		f.db.prepare('UPDATE storage_file_queue SET revision=revision+1 WHERE path=?').run('uploads/report.md');
	};
	const first = await f.run();
	assert.equal(first.syncPending, 1);
	assert.equal(f.queue()[0].revision, 2);
	assert.ok(f.catalog('uploads/report.md').object_key);
	delete f.hooks.afterPut;
	const second = await f.run({ now: initialTime + 1 });
	assert.equal(second.syncPending, 0);
	assert.equal(f.calls.puts.length, 1);
});

test('ownership cancellation before discovery creates no remote work and cleans up', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/report.md', 'cancel me');
	await assert.rejects(f.run({ owned: () => false }), failed);
	assert.equal(f.calls.sessions, 0);
	assert.deepEqual(f.calls.puts, []);
	assert.deepEqual(f.queue(), []);
	await f.clean();
});

test('ownership loss after upload prevents verification and acknowledgement and remains retryable', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/report.md', 'cancel after upload');
	let owned = true;
	f.hooks.afterPut = async () => { owned = false; };
	await assert.rejects(f.run({ owned: () => owned }), failed);
	assert.equal(f.calls.puts.length, 1);
	assert.equal(f.calls.hashes.length, 0);
	assert.equal(f.objects().length, 0);
	assert.equal(f.queue().length, 1);
	assert.equal(f.catalog('uploads/report.md').object_key, null);
	await f.clean();
	delete f.hooks.afterPut;
	await f.run();
	assert.deepEqual(f.queue(), []);
});

test('a throwing progress observer cancels before any transfer', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/report.md', 'payload');
	await assert.rejects(f.run({ onProgress() { throw new Error('observer stopped'); } }), failed);
	assert.equal(f.calls.puts.length, 0);
	await f.clean();
});

test('weekly audit starts at the exact boundary and advances timestamps only after successful verification', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/report.md', 'audited payload');
	await f.run();
	const result = await f.run({ now: initialTime + week });
	assert.equal(result.copied, 0);
	assert.equal(f.calls.puts.length, 1);
	assert.equal(f.calls.hashes.length, 2);
	assert.equal(result.verificationBytes, Buffer.byteLength('audited payload'));
	assert.equal(f.objects()[0].verified_at, initialTime + week);
	await f.run({ now: initialTime + week + 1 });
	assert.equal(f.calls.hashes.length, 2);
});

test('weekly corruption audit fails without refreshing the verification timestamp; repair can retry', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/report.md', 'original');
	await f.run();
	const object = f.objects()[0];
	const target = path.join(f.remote, 'files', 'objects', object.object_key);
	await fs.writeFile(target, 'tampered');
	await assert.rejects(f.run({ now: initialTime + week }), failed);
	assert.equal(f.objects()[0].verified_at, initialTime);
	assert.equal(f.calls.puts.length, 1);
	assert.equal(f.catalog('uploads/report.md').synced_at, initialTime);
	await f.clean();
	await fs.writeFile(target, 'original');
	await f.run({ now: initialTime + week + 1 });
	assert.equal(f.objects()[0].verified_at, initialTime + week + 1);
});

test('an audit transport error leaves verified_at unchanged', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/report.md', 'audit failure');
	await f.run();
	f.hooks.hash = async () => { throw new Error('SSH checksum unavailable'); };
	await assert.rejects(f.run({ now: initialTime + week }), failed);
	assert.equal(f.objects()[0].verified_at, initialTime);
	await f.clean();
});

test('normal synchronization processes at most 100 queued files and continues on the next run', async (t) => {
	const f = await fixture(t);
	await Promise.all(Array.from({ length: 103 }, (_, i) => f.write(`uploads/batch-${String(i).padStart(3, '0')}.md`, `payload ${i}`)));
	const first = await f.run();
	assert.equal(first.copied, 100);
	assert.equal(first.syncPending, 3);
	assert.equal(f.calls.puts.length, 100);
	assert.equal(f.objects().length, 100);
	assert.equal(f.queue()[0].path, 'uploads/batch-100.md');
	const second = await f.run({ now: initialTime + 1 });
	assert.equal(second.copied, 3);
	assert.equal(second.syncPending, 0);
	assert.equal(f.calls.puts.length, 103);
	assert.equal(f.objects().length, 103);
	await f.clean();
});

test('forceAll synchronizes more than 100 files without the normal batch limit', async (t) => {
	const f = await fixture(t);
	await Promise.all(Array.from({ length: 103 }, (_, i) => f.write(`uploads/all-${i}.md`, `unique ${i}`)));
	const result = await f.run({ forceAll: true });
	assert.equal(result.copied, 103);
	assert.equal(result.syncPending, 0);
	assert.equal(f.objects().length, 103);
	assert.equal(f.calls.puts.length, 103);
	await f.clean();
});

test('a separately configured voice directory is included without uploading unrelated files', async (t) => {
	const f = await fixture(t);
	await f.write('voices/recording.ogg', 'external voice directory');
	await f.write('uploads/report.md', 'upload report');
	await f.write('private/not-uploaded.txt', 'private');
	const result = await f.run({ voiceSaveDir: 'voices' });
	assert.equal(result.copied, 2);
	assert.ok(f.catalog('voice/recording.ogg').object_key);
	assert.ok(f.catalog('uploads/report.md').object_key);
	assert.equal(f.catalog('private/not-uploaded.txt'), undefined);
});

test('voice root cannot contain the working directory or be the working directory', async (t) => {
	const f = await fixture(t);
	for (const voiceSaveDir of ['.', '..']) {
		await assert.rejects(f.run({ voiceSaveDir }), /Unsafe voice root\./);
	}
	assert.equal(f.calls.sessions, 0);
	await f.clean();
});

test('local directory symlinks are rejected rather than traversed', async (t) => {
	const f = await fixture(t);
	const outside = path.join(f.root, 'outside');
	await fs.mkdir(outside);
	await fs.writeFile(path.join(outside, 'secret.txt'), 'must not upload');
	await fs.symlink(outside, path.join(f.cwd, 'uploads', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
	await assert.rejects(f.run(), failed);
	assert.equal(f.calls.puts.length, 0);
	assert.equal(f.calls.sessions, 0);
	assert.deepEqual(f.queue(), []);
	await f.clean();
});

test('a symlinked uploads root is rejected', async (t) => {
	const f = await fixture(t);
	const outside = path.join(f.root, 'outside');
	await fs.mkdir(outside);
	await fs.rm(path.join(f.cwd, 'uploads'), { recursive: true });
	await fs.symlink(outside, path.join(f.cwd, 'uploads'), process.platform === 'win32' ? 'junction' : 'dir');
	await assert.rejects(f.run(), failed);
	assert.equal(f.calls.puts.length, 0);
	await f.clean();
});

test('a regular file in place of the uploads directory fails safely', async (t) => {
	const f = await fixture(t);
	await fs.rm(path.join(f.cwd, 'uploads'), { recursive: true });
	await fs.writeFile(path.join(f.cwd, 'uploads'), 'not a directory');
	await assert.rejects(f.run(), failed);
	assert.equal(f.calls.puts.length, 0);
	await f.clean();
});

test('unsafe remote directories cannot receive uploads', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/report.md', 'payload');
	f.hooks.lstat = async (target) => target === '/vault/files' ? { type: 'l', size: 0 } : undefined;
	await assert.rejects(f.run(), failed);
	assert.equal(f.calls.puts.length, 0);
	assert.equal(f.queue().length, 1);
	await f.clean();
});

test('deduplicated objects must still be regular files of their recorded size', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/first.md', 'shared');
	await f.run();
	await f.write('uploads/second.md', 'shared');
	const target = f.calls.puts[0];
	for (const info of [{ type: 'l', size: 6 }, { type: 'd', size: 6 }, { type: '-', size: 7 }]) {
		f.hooks.lstat = async (remote) => remote === target ? info : undefined;
		await assert.rejects(f.run({ now: initialTime + 1 }), failed);
		assert.equal(f.catalog('uploads/second.md').object_key, null);
		assert.equal(f.queue().length, 1);
	}
	assert.equal(f.calls.puts.length, 1);
	delete f.hooks.lstat;
	await f.run();
	assert.deepEqual(f.queue(), []);
});

test('changing the destination does not silently acknowledge files in the new destination', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/report.md', 'payload');
	await f.run();
	const saved = f.catalog('uploads/report.md');
	await assert.rejects(syncStorageData(f.db, { ...connection, root: '/different' }, {
		cwd: f.cwd, env: {}, voiceSaveDir: 'uploads/audio', archiveAudio: false
	}, f.injected), failed);
	assert.deepEqual(f.catalog('uploads/report.md'), saved);
	assert.equal(f.calls.puts.length, 1);
	await f.clean();
});

test('parallel worker failure drains active workers before removing their staging files', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/a-slow.md', 'slow');
	await f.write('uploads/b-fail.md', 'fail');
	await f.write('uploads/c-unstarted.md', 'unstarted');
	let started;
	const slowStarted = new Promise((resolve) => { started = resolve; });
	let release;
	const released = new Promise((resolve) => { release = resolve; });
	let drained = false;
	let sawFailure = false;
	f.injected.withStorage = async (config, callback) => callback({ ...f.client });
	f.hooks.encrypt = async (plain, encrypted) => {
		const content = await fs.readFile(plain, 'utf8');
		if (content === 'slow') {
			started();
			await released;
			assert.equal(sawFailure, true);
			await fs.access(plain);
			await fs.copyFile(plain, encrypted);
			drained = true;
		} else if (content === 'fail') {
			await slowStarted;
			sawFailure = true;
			setTimeout(release, 30);
			throw new Error('parallel worker failed');
		} else await fs.copyFile(plain, encrypted);
	};
	await assert.rejects(f.run(), failed);
	assert.equal(sawFailure, true);
	assert.equal(drained, true);
	assert.ok(f.queue().some((row) => row.path === 'uploads/b-fail.md'));
	assert.equal(f.catalog('uploads/b-fail.md').object_key, null);
	await f.clean();
});

test('an empty source tree initializes SQLite state without any transfers', async (t) => {
	const f = await fixture(t);
	const result = await f.run();
	assert.equal(result.copied, 0);
	assert.equal(result.syncPending, 0);
	assert.equal(result.verificationBytes, 0);
	assert.deepEqual(f.objects(), []);
	assert.deepEqual(f.queue(), []);
	assert.equal(f.calls.puts.length, 0);
	await f.clean();
});

test('empty files are valid immutable objects', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/empty.txt', '');
	await f.run();
	const object = f.objects()[0];
	assert.equal(object.bytes, 0);
	assert.equal(object.encrypted_bytes, 0);
	assert.equal(object.sha256, digest(''));
	assert.equal(f.catalog('uploads/empty.txt').object_key, object.object_key);
	assert.deepEqual(f.queue(), []);
});

test('archived audio with edited local content uploads the new version instead of linking the old archive', async (t) => {
	const f = await fixture(t);
	const archived = await f.archived('uploads/audio/edited.ogg', { evicted: false });
	await f.write('uploads/audio/edited.ogg', 'edited local recording');
	await f.run();
	assert.equal(f.calls.links.length, 0);
	assert.equal(f.calls.puts.length, 1);
	assert.equal(f.calls.encryptions.length, 1);
	assert.equal(f.catalog('uploads/audio/edited.ogg').object_key, `${digest('edited local recording')}.enc`);
	assert.equal(await fs.readFile(archived.target, 'utf8'), archived.ciphertext);
});

test('an existing remote archive link is verified before reuse rather than relinked', async (t) => {
	const f = await fixture(t);
	const archived = await f.archived('uploads/audio/existing.ogg');
	const target = path.join(f.remote, 'files', 'objects', archived.objectKey);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.link(archived.target, target);
	await f.run();
	assert.equal(f.calls.links.length, 0);
	assert.equal(f.calls.puts.length, 0);
	assert.equal(f.calls.hashes.length, 1);
	assert.equal(f.catalog('uploads/audio/existing.ogg').object_key, archived.objectKey);
});

test('archive-only metadata cannot redirect discovery outside permitted roots', async (t) => {
	const f = await fixture(t);
	await f.archived('../outside.ogg');
	await assert.rejects(f.run(), failed);
	assert.equal(f.calls.sessions, 0);
	assert.equal(f.calls.puts.length, 0);
	assert.equal(f.calls.links.length, 0);
	assert.equal(f.objects().length, 0);
	await f.clean();
});

test('a non-regular archived source is rejected before linking or acknowledging', async (t) => {
	const f = await fixture(t);
	const archived = await f.archived('uploads/audio/symlink.ogg');
	f.hooks.lstat = async (target) => target === `/vault/audio/${archived.key}` ? { type: 'l', size: 22 } : undefined;
	await assert.rejects(f.run(), failed);
	assert.equal(f.calls.links.length, 0);
	assert.equal(f.calls.puts.length, 0);
	assert.equal(f.calls.hashes.length, 0);
	assert.equal(f.objects().length, 0);
	assert.equal(f.catalog('uploads/audio/symlink.ogg').object_key, null);
	assert.equal(f.queue().length, 1);
	await f.clean();
});

test('a source recreated after deletion discovery is not incorrectly tombstoned', async (t) => {
	const f = await fixture(t);
	const source = await f.write('uploads/report.md', 'original');
	await f.run();
	await fs.unlink(source);
	let recreated = false;
	f.hooks.lstat = async (target) => {
		if (target === '/vault/files' && !recreated) {
			recreated = true;
			await fs.writeFile(source, 'recreated during synchronization');
		}
	};
	await assert.rejects(f.run({ now: initialTime + 1 }), failed);
	assert.equal(recreated, true);
	assert.equal(f.catalog('uploads/report.md').deleted_at, null);
	assert.equal(f.queue()[0].deleted, 1);
	delete f.hooks.lstat;
	await f.run({ now: initialTime + 2 });
	assert.equal(f.catalog('uploads/report.md').object_key, `${digest('recreated during synchronization')}.enc`);
	assert.equal(f.catalog('uploads/report.md').deleted_at, null);
	assert.deepEqual(f.queue(), []);
	await f.clean();
});

test('a regular file occupying a remote directory prevents uploads', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/report.md', 'payload');
	await fs.writeFile(path.join(f.remote, 'files'), 'not a directory');
	await assert.rejects(f.run(), failed);
	assert.equal(f.calls.puts.length, 0);
	assert.equal(f.queue().length, 1);
	assert.equal(f.catalog('uploads/report.md').object_key, null);
	await f.clean();
});

test('mixed weekly audit results refresh only successfully checked objects', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/first.md', 'first payload');
	await f.write('uploads/second.md', 'second payload');
	await f.run();
	const corrupted = f.catalog('uploads/second.md').object_key;
	f.hooks.hash = async (target) => target.endsWith(corrupted) ? '0'.repeat(64) : digest(await fs.readFile(f.local(target)));
	await assert.rejects(f.run({ now: initialTime + week }), failed);
	const first = f.objects().find((object) => object.object_key === f.catalog('uploads/first.md').object_key);
	const second = f.objects().find((object) => object.object_key === corrupted);
	assert.equal(first.verified_at, initialTime + week);
	assert.equal(second.verified_at, initialTime);
	assert.equal(f.calls.puts.length, 2);
	await f.clean();
});

test('weekly audits verify both file and backup links before advancing verified_at', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/report.md', 'backup-linked payload');
	await f.run();
	const object = f.objects()[0];
	const backup = path.join(f.remote, 'backups', 'objects', object.object_key);
	await fs.mkdir(path.dirname(backup), { recursive: true });
	await fs.link(path.join(f.remote, 'files', 'objects', object.object_key), backup);
	f.db.prepare('UPDATE storage_file_objects SET backup_linked_at=?').run(initialTime);
	f.calls.hashes.length = 0;
	await f.run({ now: initialTime + week - 1 });
	assert.deepEqual(f.calls.hashes, []);
	const result = await f.run({ now: initialTime + week });
	assert.deepEqual(f.calls.hashes, [
		`/vault/files/objects/${object.object_key}`,
		`/vault/backups/objects/${object.object_key}`
	]);
	assert.equal(result.verificationBytes, object.encrypted_bytes * 2);
	assert.equal(f.objects()[0].verified_at, initialTime + week);
	assert.equal(f.objects()[0].backup_linked_at, initialTime);
	assert.equal(f.calls.puts.length, 1);
	await f.clean();
});

test('corruption confined to the backup link fails audit without advancing verified_at', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/report.md', 'correct backup payload');
	await f.run();
	const object = f.objects()[0];
	const source = path.join(f.remote, 'files', 'objects', object.object_key);
	const backup = path.join(f.remote, 'backups', 'objects', object.object_key);
	await fs.mkdir(path.dirname(backup), { recursive: true });
	await fs.link(source, backup);
	f.db.prepare('UPDATE storage_file_objects SET backup_linked_at=?').run(initialTime);
	await fs.unlink(backup);
	await fs.writeFile(backup, 'corrupt backup payload');
	assert.equal(digest(await fs.readFile(source)), object.remote_sha256);
	f.calls.hashes.length = 0;
	await assert.rejects(f.run({ now: initialTime + week }), failed);
	assert.deepEqual(f.calls.hashes, [
		`/vault/files/objects/${object.object_key}`,
		`/vault/backups/objects/${object.object_key}`
	]);
	assert.equal(f.objects()[0].verified_at, initialTime);
	assert.equal(f.catalog('uploads/report.md').synced_at, initialTime);
	assert.equal(f.calls.puts.length, 1);
	await f.clean();
	await fs.unlink(backup);
	await fs.link(source, backup);
	await f.run({ now: initialTime + week + 1 });
	assert.equal(f.objects()[0].verified_at, initialTime + week + 1);
});

test('a missing linked backup object fails audit without refreshing verified_at', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/report.md', 'missing backup');
	await f.run();
	f.db.prepare('UPDATE storage_file_objects SET backup_linked_at=?').run(initialTime);
	await assert.rejects(f.run({ now: initialTime + week }), failed);
	assert.equal(f.objects()[0].verified_at, initialTime);
	assert.equal(f.calls.puts.length, 1);
	await f.clean();
});

test('explicit empty env ignores process VOICE_SAVE_DIR when no voiceSaveDir option is supplied', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/audio/included.ogg', 'default voice root');
	await f.write('process-voices/excluded.ogg', 'process environment must not select this root');
	scopedEnvironment(t, { VOICE_SAVE_DIR: 'process-voices' });
	const result = await f.run({ voiceSaveDir: undefined, env: {} });
	assert.equal(result.copied, 1);
	assert.ok(f.catalog('uploads/audio/included.ogg').object_key);
	assert.equal(f.catalog('voice/excluded.ogg'), undefined);
	assert.equal(f.calls.puts.length, 1);
	await f.clean();
});

test('referenced recordings and parts are promoted to audio links without duplicate encryption or upload', async (t) => {
	const f = await audioFixture(t);
	const result = await f.run({ archiveAudio: true });
	assert.equal(result.copied, 2);
	assert.equal(result.evicted, 0);
	assert.equal(result.syncPending, 0);
	assert.equal(f.calls.puts.length, 2);
	assert.ok(f.calls.puts.every((target) => target.startsWith('/vault/files/objects/')));
	assert.equal(f.calls.encryptions.length, 2);
	assert.equal(f.calls.hashes.length, 2);
	assert.equal(f.calls.links.length, 2);
	assert.deepEqual(f.calls.decryptions, []);
	const rows = f.db.prepare('SELECT * FROM storage_audio ORDER BY path').all();
	assert.equal(rows.length, 2);
	for (const original of [f.recording, f.part]) {
		const relative = path.relative(f.cwd, original).split(path.sep).join('/');
		const object = f.objects().find((entry) => entry.object_key === f.catalog(relative).object_key);
		const audio = rows.find((entry) => entry.path === original);
		assert.match(audio.object_key, /^[a-f0-9-]{36}\.enc$/);
		assert.equal(audio.sha256, object.sha256);
		assert.equal(audio.remote_sha256, object.remote_sha256);
		assert.equal(audio.bytes, object.bytes);
		assert.equal(audio.archived_at, initialTime);
		assert.equal(audio.evicted_at, null);
		assert.equal(audio.destination, object.destination);
		const stored = path.join(f.remote, 'files', 'objects', object.object_key);
		const linked = path.join(f.remote, 'audio', audio.object_key);
		assert.equal((await fs.stat(linked)).ino, (await fs.stat(stored)).ino);
		assert.equal((await fs.stat(linked)).nlink, 2);
		assert.equal(digest(await fs.readFile(linked)), object.remote_sha256);
		await fs.access(original);
	}
	assert.deepEqual(await fs.readdir(f.archiveWork), []);
	await f.run({ archiveAudio: true, now: initialTime + 1 });
	assert.equal(f.calls.puts.length, 2);
	assert.equal(f.calls.encryptions.length, 2);
	assert.equal(f.calls.links.length, 2);
	assert.equal(f.calls.hashes.length, 2);
	assert.deepEqual(await fs.readdir(f.archiveWork), []);
	await f.clean();
});

test('orphan audio cleanup removes only its hardlink and preserves immutable file objects', async (t) => {
	const f = await audioFixture(t);
	await f.run({ archiveAudio: true });
	const rows = f.db.prepare('SELECT * FROM storage_audio ORDER BY path').all();
	const originals = f.objects().map((object) => ({
		...object, target: path.join(f.remote, 'files', 'objects', object.object_key)
	}));
	const inodes = await Promise.all(originals.map(async (object) => (await fs.stat(object.target)).ino));
	f.db.exec('DELETE FROM recording_audio_parts; DELETE FROM study_recordings;');
	await f.run({ archiveAudio: true, now: initialTime + 1 });
	assert.deepEqual(f.db.prepare('SELECT * FROM storage_audio').all(), []);
	assert.deepEqual([...f.calls.deletes].sort(), rows.map((row) => `/vault/audio/${row.object_key}`).sort());
	for (const row of rows) {
		await assert.rejects(fs.access(path.join(f.remote, 'audio', row.object_key)), { code: 'ENOENT' });
	}
	for (const [index, object] of originals.entries()) {
		const stat = await fs.stat(object.target);
		assert.equal(stat.ino, inodes[index]);
		assert.equal(stat.nlink, 1);
		assert.equal(digest(await fs.readFile(object.target)), object.remote_sha256);
	}
	assert.equal(f.objects().length, 2);
	assert.equal(f.calls.puts.length, 2);
	assert.equal(f.calls.encryptions.length, 2);
	assert.equal(f.calls.links.length, 2);
	assert.equal(f.calls.hashes.length, 2);
	assert.deepEqual(await fs.readdir(f.archiveWork), []);
	await f.clean();
});

test('remoteFileStat accepts only regular files with safe nonnegative integer sizes', async () => {
	for (const info of [{ type: '-', size: 0 }, { isFile: true, size: 1 }, { isFile: () => true, size: 2 }]) {
		assert.equal(await remoteFileStat({ lstat: async () => info }, '/object'), info);
	}
	for (const info of [null, { type: 'd', size: 1 }, { type: 'l', size: 1 }, { type: '-', size: -1 }, { type: '-', size: 1.5 }, { type: '-', size: Number.MAX_SAFE_INTEGER + 1 }, { type: '-', size: '10' }]) {
		await assert.rejects(remoteFileStat({ lstat: async () => info }, '/object'), /Unsafe storage object\./);
	}
	for (const code of ['ENOENT', 2]) {
		const client = { lstat: async () => { throw Object.assign(new Error('missing'), { code }); } };
		assert.equal(await remoteFileStat(client, '/missing', true), null);
		await assert.rejects(remoteFileStat(client, '/missing'), /missing/);
	}
	await assert.rejects(remoteFileStat({ lstat: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }, '/object', true), /denied/);
});

test('ensureFileDirectory checks the created path is actually a directory', async () => {
	for (const info of [{ type: 'd' }, { isDirectory: true }, { isDirectory: () => true }]) {
		const calls = [];
		await ensureFileDirectory({ mkdir: async (...args) => calls.push(args), lstat: async () => info }, '/directory');
		assert.deepEqual(calls, [['/directory', true]]);
	}
	for (const info of [{ type: '-' }, { type: 'l' }, null]) {
		await assert.rejects(ensureFileDirectory({ mkdir: async () => {}, lstat: async () => info }, '/directory'), /Unsafe storage directory\./);
	}
});
