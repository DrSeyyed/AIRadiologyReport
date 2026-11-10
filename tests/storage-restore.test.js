import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import Database from 'better-sqlite3';
import { backupRecovery, restoreRecovery, recoveryAudioPlan } from '../src/lib/server/recovery-backups.js';
import { storageDestination, getStorageConnection } from '../src/lib/server/storage-settings.js';
import { withAudioFile } from '../src/lib/server/storage-audio.js';
import { ensureStorageFileState } from '../src/lib/server/storage-file-state.js';
import { decryptFile, encryptFile } from '../src/lib/server/storage-crypto.js';
import { hashRemote, storagePath } from '../src/lib/server/storage-transport.js';
import { isStorageRestoreId, prepareStorageRestore } from '../src/lib/server/storage-restore.js';

const connection = {
	host: 'storage.invalid',
	username: 'backup',
	password: 'private-password',
	root: '/vault',
	port: 22,
	fingerprint: `SHA256:${Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '')}`
};

async function fixture(t, { archived = false, bundleBytes } = {}) {
	const root = path.join(process.cwd(), 'tests', `.storage-restore-${randomUUID()}`);
	const app = path.join(root, 'app');
	const remote = path.join(root, 'remote');
	await fs.mkdir(path.join(app, 'uploads'), { recursive: true });
	await fs.mkdir(remote);
	const previousKey = process.env.STORAGE_ENCRYPTION_KEY;
	process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
	const db = new Database(path.join(app, 'live.sqlite'));
	db.exec(`
		CREATE TABLE study_recordings(id INTEGER PRIMARY KEY, audio_report_path TEXT, text_report_path TEXT);
		CREATE TABLE recording_audio_parts(id INTEGER PRIMARY KEY, audio_report_path TEXT);
		CREATE TABLE storage_audio(path TEXT PRIMARY KEY, object_key TEXT, sha256 TEXT, remote_sha256 TEXT,
			bytes INTEGER, archived_at INTEGER, evicted_at INTEGER, destination TEXT);
		CREATE TABLE application_settings(key TEXT PRIMARY KEY, value TEXT);
		CREATE TABLE storage_jobs(id INTEGER PRIMARY KEY, kind TEXT);
		CREATE TABLE storage_restore_requests(job_id INTEGER PRIMARY KEY REFERENCES storage_jobs(id) ON DELETE CASCADE, backup_id TEXT NOT NULL);
		CREATE TABLE storage_worker_lock(id INTEGER PRIMARY KEY);
		CREATE TABLE storage_reset_requests(job_id INTEGER PRIMARY KEY REFERENCES storage_jobs(id) ON DELETE CASCADE, phase TEXT, restored INTEGER, total INTEGER, deleted INTEGER);
		CREATE TABLE storage_job_log_hidden(job_id INTEGER PRIMARY KEY REFERENCES storage_jobs(id) ON DELETE CASCADE);
		INSERT INTO storage_jobs VALUES(1,'restore');
		INSERT INTO storage_restore_requests VALUES(1,'old');
		INSERT INTO storage_reset_requests VALUES(1,'restoring',1,2,0);
		INSERT INTO storage_job_log_hidden VALUES(1);
		INSERT INTO storage_worker_lock VALUES(1);
		INSERT INTO application_settings VALUES('storage_settings','{"enabled":true,"archiveEnabled":true,"backupsEnabled":true}');
	`);
	ensureStorageFileState(db);
	db.prepare('INSERT INTO storage_file_catalog(path,original,destination) VALUES(?,?,?)').run(
		'uploads/old',
		'uploads/old',
		'old'
	);
	db.prepare('INSERT INTO storage_file_queue(path,queued_at) VALUES(?,?)').run('uploads/old', 1);
	db.prepare(
		'INSERT INTO storage_file_objects(destination,object_key,sha256,remote_sha256,bytes,encrypted_bytes,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?)'
	).run('old', 'old.enc', 'old', 'old', 1, 1, 1, 1);
	const archivedContent = archived ? 'old audio payload'.repeat(20000) : 'audio payload';
	await fs.writeFile(path.join(app, 'uploads', 'audio.ogg'), archivedContent);
	await fs.writeFile(path.join(app, 'uploads', 'report.md'), 'report payload');
	await fs.writeFile(path.join(app, 'uploads', 'unreferenced.ogg'), 'extra audio');
	db.prepare('INSERT INTO study_recordings VALUES(1,?,?)').run(
		path.join(app, 'uploads', 'audio.ogg'),
		'uploads/report.md'
	);
	db.prepare('INSERT INTO recording_audio_parts VALUES(1,?)').run(
		path.join(app, 'uploads', 'audio.ogg')
	);
	t.after(async () => {
		if (db.open) db.close();
		if (previousKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
		else process.env.STORAGE_ENCRYPTION_KEY = previousKey;
		await fs.rm(root, { recursive: true, force: true });
	});
	const downloads = [];
	const calls = [];
	const local = (p) => {
		assert.ok(p === '/' || p === '/vault' || p.startsWith('/vault/'));
		assert.ok(!p.split('/').includes('..'));
		if (p === '/' || p === '/vault') return remote;
		return path.join(remote, ...p.slice('/vault/'.length).split('/'));
	};
	const client = {
		async lstat(p) {
			return fs.lstat(local(p));
		},
		async mkdir(p) {
			await fs.mkdir(local(p), { recursive: true });
		},
		async put(source, p) {
			if (typeof source === 'string') await fs.copyFile(source, local(p));
			else await pipeline(source, createWriteStream(local(p)));
		},
		async get(p, target) {
			await fs.copyFile(local(p), target);
		},
		async rename(a, b) {
			await fs.rename(local(a), local(b));
		},
		async list(p) {
			return (await fs.readdir(local(p), { withFileTypes: true })).map((entry) => ({
				name: entry.name,
				type: entry.isSymbolicLink() ? 'l' : entry.isDirectory() ? 'd' : '-'
			}));
		},
		createReadStream(p) {
			downloads.push(p);
			return createReadStream(local(p));
		}
	};
	const deps = {
		cwd: app,
		storagePath,
		hashRemote,
		async withStorage(config, callback) {
			calls.push(config);
			return callback(client);
		}
	};
	const archiveObjects = [];
	if (archived) {
		db.prepare("UPDATE application_settings SET value=? WHERE key='storage_settings'").run(JSON.stringify({
			enabled: true, archiveEnabled: true, backupsEnabled: true,
			...Object.fromEntries(['host', 'port', 'username', 'root', 'fingerprint'].map((key) => [key, connection[key]]))
		}));
		await fs.mkdir(path.join(remote, 'audio'));
		for (const original of [path.join(app, 'uploads', 'audio.ogg'), 'uploads/unreferenced.ogg']) {
			const source = path.resolve(app, original);
			const bytes = await fs.readFile(source);
			const object = `${randomUUID()}.enc`;
			const encrypted = path.join(remote, 'audio', object);
			await encryptFile(source, encrypted);
			db.prepare('INSERT INTO storage_audio VALUES(?,?,?,?,?,?,?,?)').run(original, object,
				createHash('sha256').update(bytes).digest('hex'),
				createHash('sha256').update(await fs.readFile(encrypted)).digest('hex'),
				bytes.length, 1700000000, 1700000001, storageDestination(connection));
			await fs.unlink(source);
			archiveObjects.push(object);
		}
	}
	deps.hashStorageFile = async (_client, file) =>
		createHash('sha256').update(await fs.readFile(local(file))).digest('hex');
	const backup = await backupRecovery(
		db,
		connection,
		{ cwd: app, now: 1800000000, kind: 'full', env: {}, format: 'concat-gzip-v1', bundleBytes },
		deps
	);
	downloads.length = 0;
	calls.length = 0;
	const encryptedManifest = path.join(remote, 'backups', 'manifests', `${backup.id}.enc`);
	const plain = path.join(root, 'manifest.json');
	await decryptFile(encryptedManifest, plain);
	const manifest = JSON.parse(await fs.readFile(plain, 'utf8'));
	async function replaceManifest(value) {
		await fs.writeFile(plain, JSON.stringify(value));
		await fs.unlink(encryptedManifest);
		await encryptFile(plain, encryptedManifest);
	}
	async function clean() {
		assert.deepEqual(await fs.readdir(path.join(app, 'restore-staging')), []);
	}
	async function reject(options = {}, overrides = {}) {
		await assert.rejects(
			prepareStorageRestore(
				connection,
				{ backupId: backup.id, ...options },
				{ ...deps, ...overrides }
			),
			{
				message: 'Storage restore preparation failed.'
			}
		);
		await clean();
	}
	return {
		root,
		app,
		remote,
		db,
		client,
		deps,
		backup,
		manifest,
		archiveObjects,
		archivedContent,
		encryptedManifest,
		downloads,
		calls,
		replaceManifest,
		clean,
		reject
	};
}

test('completed encrypted recovery is staged independently, with rewritten paths and paused storage', async (t) => {
	const f = await fixture(t);
	await fs.writeFile(
		path.join(f.remote, 'backups', 'objects', 'unreferenced.enc'),
		'do not download'
	);
	await fs.writeFile(
		path.join(
			f.remote,
			'backups',
			'indexes',
			'1800000001-00000000-0000-4000-8000-000000000000.pending'
		),
		'{}'
	);
	const progress = [];
	const result = await prepareStorageRestore(
		connection,
		{ backupId: f.backup.id, onProgress: (value) => progress.push(value) },
		f.deps
	);
	assert.equal(progress[0].phase, 'preparing');
	for (const phase of [
		'listing',
		'manifest',
		'downloading',
		'decrypting',
		'verifying',
		'database',
		'publishing',
		'complete'
	])
		assert.ok(
			progress.some((value) => value.phase === phase),
			phase
		);
	assert.ok(progress.some((value) => value.phase === 'decrypting' && value.downloadedObjects > 0));
	const completed = progress.at(-1);
	assert.equal(completed.phase, 'complete');
	assert.equal(completed.downloadedObjects, f.manifest.bundles.length);
	assert.equal(completed.totalObjects, f.manifest.bundles.length);
	assert.equal(completed.restoredFiles, f.manifest.files.length);
	assert.equal(completed.totalFiles, f.manifest.files.length);
	assert.ok(completed.downloadedBytes > 0);
	assert.equal(completed.verificationBytes, completed.downloadedBytes);
	assert.ok(!JSON.stringify(progress).includes('audio.ogg'));
	assert.ok(!JSON.stringify(progress).includes(f.app));
	assert.ok(!JSON.stringify(progress).includes('private'));
	assert.equal(result.id, f.backup.id);
	assert.ok(isStorageRestoreId(result.restoreId));
	assert.equal(result.files, f.manifest.files.length);
	assert.equal(f.calls.length, Math.min(4, f.manifest.bundles.length));
	assert.ok(f.calls.every((config) => config.operationTimeoutMs === 21_600_000));
	const staging = path.join(f.app, 'restore-staging', result.restoreId);
	assert.deepEqual(await fs.readdir(path.dirname(staging)), [result.restoreId]);
	assert.equal(
		await fs.readFile(path.join(staging, 'uploads', 'audio.ogg'), 'utf8'),
		'audio payload'
	);
	assert.equal(
		await fs.readFile(path.join(staging, 'uploads', 'unreferenced.ogg'), 'utf8'),
		'extra audio'
	);
	assert.equal(
		await fs.readFile(path.join(staging, 'uploads', 'report.md'), 'utf8'),
		'report payload'
	);
	const restored = new Database(path.join(staging, 'db', 'pacs.db'));
	try {
		assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
		assert.equal(
			restored.prepare('SELECT audio_report_path FROM study_recordings').get().audio_report_path,
			'uploads/audio.ogg'
		);
		for (const table of [
			'storage_audio',
			'storage_file_queue',
			'storage_file_catalog',
			'storage_file_objects',
			'storage_jobs',
			'storage_restore_requests',
			'storage_reset_requests',
			'storage_job_log_hidden',
			'storage_worker_lock'
		]) {
			assert.equal(restored.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
		}
		const settings = JSON.parse(
			restored.prepare("SELECT value FROM application_settings WHERE key='storage_settings'").get()
				.value
		);
		assert.equal(settings.enabled, false);
		assert.equal(settings.archiveEnabled, false);
		assert.equal(settings.backupsEnabled, false);
	} finally {
		restored.close();
	}
	assert.equal(f.db.prepare('SELECT count(*) AS n FROM storage_jobs').get().n, 1);
	assert.equal(
		f.db.prepare('SELECT audio_report_path FROM study_recordings').get().audio_report_path,
		path.join(f.app, 'uploads', 'audio.ogg')
	);
	assert.equal(
		await fs.readFile(path.join(f.app, 'uploads', 'audio.ogg'), 'utf8'),
		'audio payload'
	);
	assert.ok(!f.downloads.some((p) => p.endsWith('/unreferenced.enc')));
	const expected = new Set(f.manifest.bundles.map((entry) => entry.object));
	for (const p of f.downloads.filter((value) => value.includes('/objects/')))
		assert.ok(expected.has(path.posix.basename(p)));
	if (process.platform !== 'win32') {
		assert.equal((await fs.stat(staging)).mode & 0o777, 0o700);
		assert.equal((await fs.stat(path.join(staging, 'db', 'pacs.db'))).mode & 0o777, 0o600);
	}
});

test('progress observer failures during restore verification remove staging and never report completion', async (t) => {
	const f = await fixture(t);
	const phases = [];
	await f.reject({
		onProgress(progress) {
			phases.push(progress.phase);
			if (progress.phase === 'verifying') throw new Error('private/patient/path');
		}
	});
	assert.ok(phases.includes('verifying'));
	assert.ok(!phases.includes('complete'));
});

test('strict backup IDs reject malformed IDs and traversal before contacting remote', async (t) => {
	const f = await fixture(t);
	for (const backupId of [
		null,
		'',
		'../bad',
		f.backup.id + '/..',
		f.backup.id + '\\..',
		f.backup.id + '\n',
		f.backup.id.toUpperCase(),
		f.backup.id.replace(/^1800000000/, '01800000000'),
		f.backup.id.replace(/^1800000000/, '9999999999999999')
	]) {
		await assert.rejects(prepareStorageRestore(connection, { backupId }, f.deps), {
			message: 'Storage restore preparation failed.'
		});
	}
	assert.equal(f.calls.length, 0);
	assert.equal(isStorageRestoreId('../path'), false);
	assert.equal(isStorageRestoreId(randomUUID() + '\n'), false);
});

test('pending-only, missing and ambiguous completed recovery points are rejected', async (t) => {
	for (const kind of ['pending', 'missing', 'duplicate'])
		await t.test(kind, async (t) => {
			const f = await fixture(t);
			const index = path.join(f.remote, 'backups', 'indexes', `${f.backup.id}.full.json`);
			if (kind === 'pending') await fs.rename(index, index.replace('.full.json', '.pending'));
			if (kind === 'missing') await fs.unlink(index);
			if (kind === 'duplicate')
				await fs.copyFile(index, index.replace('.full.json', '.database.json'));
			await f.reject();
			assert.equal(f.downloads.length, 0);
		});
});

test('manifest authentication and identity are checked before downloading any object', async (t) => {
	for (const kind of [
		'tamper',
		'missing',
		'id',
		'kind',
		'createdAt',
		'traversal',
		'object',
		'duplicate-path',
		'budget'
	])
		await t.test(kind, async (t) => {
			const f = await fixture(t);
			if (kind === 'tamper') {
				const bytes = await fs.readFile(f.encryptedManifest);
				bytes[bytes.length - 1] ^= 1;
				await fs.writeFile(f.encryptedManifest, bytes);
			} else if (kind === 'missing') {
				await fs.unlink(f.encryptedManifest);
			} else {
				const manifest = structuredClone(f.manifest);
				if (kind === 'id') manifest.id = `1800000000-${randomUUID()}`;
				if (kind === 'kind') manifest.kind = 'database';
				if (kind === 'createdAt') manifest.createdAt++;
				if (kind === 'traversal') manifest.files[0].path = 'uploads/../../outside';
				if (kind === 'object') manifest.bundles[0].object = '../outside.enc';
				if (kind === 'duplicate-path') manifest.files.push(structuredClone(manifest.files[0]));
				if (kind === 'budget') manifest.files[0].bytes = 1024 ** 4 + 1;
				await f.replaceManifest(manifest);
			}
			await f.reject();
			assert.ok(!f.downloads.some((p) => p.includes('/objects/')));
		});
});

test('missing, corrupt and incorrectly described objects leave no prepared output', async (t) => {
	for (const kind of ['missing', 'tamper', 'plaintext-hash', 'plaintext-size', 'database'])
		await t.test(kind, async (t) => {
			const f = await fixture(t);
			const object = path.join(f.remote, 'backups', 'objects', f.manifest.bundles[0].object);
			if (kind === 'missing') await fs.unlink(object);
			if (kind === 'tamper') {
				const bytes = await fs.readFile(object);
				bytes[bytes.length - 1] ^= 1;
				await fs.writeFile(object, bytes);
			}
			if (kind === 'plaintext-hash' || kind === 'plaintext-size') {
				if (kind === 'plaintext-hash') f.manifest.files[0].sha256 = '0'.repeat(64);
				else f.manifest.files[0].bytes++;
				await f.replaceManifest(f.manifest);
			}
			if (kind === 'database') {
				const database = f.manifest.files.find((entry) => entry.role === 'database');
				database.role = 'audio';
				await f.replaceManifest(f.manifest);
			}
			await f.reject();
		});
});

test('remote symbolic links and oversized objects are rejected before reading', async (t) => {
	for (const target of ['indexes', 'manifest', 'object', 'ancestor', 'oversized'])
		await t.test(target, async (t) => {
			const f = await fixture(t);
			const lstat = f.client.lstat;
			const remote =
				target === 'indexes'
					? '/vault/backups/indexes'
					: target === 'manifest'
						? `/vault/backups/manifests/${f.backup.id}.enc`
						: target === 'ancestor'
							? '/vault/backups'
							: `/vault/backups/objects/${f.manifest.bundles[0].object}`;
			f.client.lstat = async (p) =>
				p === remote
					? target === 'oversized'
						? { type: '-', size: 1024 ** 4 + 1 }
						: { type: 'l' }
					: lstat(p);
			await f.reject();
			assert.ok(!f.downloads.includes(remote));
		});
});

test('lost lease before download, during restore, and after publication never reports ready', async (t) => {
	for (const phase of ['initial', 'throw', 'download', 'restored', 'published'])
		await t.test(phase, async (t) => {
			const f = await fixture(t);
			let checks = 0;
			const owned = async () => {
				checks++;
				if (phase === 'initial') return false;
				if (phase === 'throw' && f.downloads.length) throw new Error(connection.password);
				if (phase === 'download') return f.downloads.length === 0;
				const staging = await fs.readdir(path.join(f.app, 'restore-staging')).catch(() => []);
				if (phase === 'published') return !staging.some(isStorageRestoreId);
				for (const directory of staging.filter((value) => value.startsWith('.prepare-'))) {
					try {
						await fs.stat(path.join(f.app, 'restore-staging', directory, 'verified'));
						return false;
					} catch (error) {
						if (error.code !== 'ENOENT') throw error;
					}
				}
				return true;
			};
			await assert.rejects(
				prepareStorageRestore(connection, { backupId: f.backup.id, owned }, f.deps),
				{ message: 'Storage restore preparation failed.' }
			);
			if (phase !== 'initial') await f.clean();
			assert.ok(checks > 0);
			assert.equal(f.db.prepare('SELECT count(*) AS n FROM storage_jobs').get().n, 1);
		});
});

test('restore hash and download streams respect configured read inactivity and clean staging', async (t) => {
	for (const readNumber of [1, 2])
		for (const seconds of [2, 45]) {
			await t.test(`manifest read ${readNumber}, ${seconds} seconds`, async (t) => {
				const f = await fixture(t);
				t.mock.timers.enable({ apis: ['setTimeout'] });
				const original = f.client.createReadStream;
				let reads = 0;
				let ready;
				const started = new Promise((resolve) => {
					ready = resolve;
				});
				let stalled;
				f.client.createReadStream = (remote) => {
					if (remote.includes('/manifests/') && ++reads === readNumber) {
						stalled = new Readable({ read() {} });
						ready();
						return stalled;
					}
					return original(remote);
				};
				let settled = false;
				const rejected = assert
					.rejects(
						prepareStorageRestore(
							{ ...connection, verificationTimeoutSeconds: seconds },
							{ backupId: f.backup.id },
							f.deps
						),
						{ message: 'Storage restore preparation failed.' }
					)
					.then(() => {
						settled = true;
					});
				await started;
				await new Promise(setImmediate);
				t.mock.timers.tick(seconds * 1000 - 1);
				await new Promise(setImmediate);
				assert.equal(settled, false);
				t.mock.timers.tick(1);
				await rejected;
				assert.equal(stalled.destroyed, true);
				await f.clean();
			});
		}
});

test('transport errors are sanitized and partial encrypted downloads are removed', async (t) => {
	const f = await fixture(t);
	let streams = 0;
	const original = f.client.createReadStream;
	f.client.createReadStream = (p) => {
		streams++;
		const stream = original(p);
		if (streams === 2)
			process.nextTick(() =>
				stream.destroy(new Error(`${connection.password} ${connection.fingerprint}`))
			);
		return stream;
	};
	await f.reject();
});

test('changed and over-budget remote streams fail closed even after valid lstat and hash', async (t) => {
	for (const phase of ['changed', 'growth'])
		await t.test(phase, async (t) => {
			const f = await fixture(t);
			const original = f.client.createReadStream;
			let manifestReads = 0;
			f.client.createReadStream = (p) => {
				if (p.includes('/manifests/') && ++manifestReads === 2) {
					const stream = original(p);
					const transform = new Transform({
						transform(chunk, _encoding, callback) {
							const data = Buffer.from(chunk);
							data[data.length - 1] ^= 1;
							callback(null, phase === 'growth' ? Buffer.alloc(16 * 1024 * 1024 + 1) : data);
						}
					});
					stream.pipe(transform);
					transform.once('close', () => stream.destroy());
					return transform;
				}
				return original(p);
			};
			await f.reject();
			assert.ok(!f.downloads.some((p) => p.includes('/objects/')));
		});
});

test('staging rejects overlapping VOICE_SAVE_DIR roots before connecting or creating output', async (t) => {
	for (const voice of ['.', '..', 'restore-staging', 'restore-staging/voice'])
		await t.test(voice, async (t) => {
			const f = await fixture(t);
			await assert.rejects(
				prepareStorageRestore(
					connection,
					{ backupId: f.backup.id },
					{
						...f.deps,
						env: { VOICE_SAVE_DIR: voice }
					}
				),
				{ message: 'Storage restore preparation failed.' }
			);
			assert.equal(f.calls.length, 0);
			await assert.rejects(fs.lstat(path.join(f.app, 'restore-staging')), { code: 'ENOENT' });
		});
});

test('staging rejects served and voice symlink aliases, including dangling targets', async (t) => {
	for (const type of ['static', 'voice'])
		await t.test(type, async (t) => {
			const f = await fixture(t);
			const alias = path.join(f.app, type === 'static' ? 'static' : 'voice-alias');
			await fs.symlink(
				path.join(f.app, 'restore-staging'),
				alias,
				process.platform === 'win32' ? 'junction' : 'dir'
			);
			await assert.rejects(
				prepareStorageRestore(
					connection,
					{ backupId: f.backup.id },
					{
						...f.deps,
						env: type === 'voice' ? { VOICE_SAVE_DIR: alias } : {}
					}
				),
				{ message: 'Storage restore preparation failed.' }
			);
			assert.equal(f.calls.length, 0);
			await assert.rejects(fs.lstat(path.join(f.app, 'restore-staging')), { code: 'ENOENT' });
		});
});

test('local staging directory links are rejected without touching their targets', async (t) => {
	const f = await fixture(t);
	const outside = path.join(f.root, 'outside');
	await fs.mkdir(outside);
	await fs.writeFile(path.join(outside, 'sentinel'), 'keep');
	await fs.symlink(
		outside,
		path.join(f.app, 'restore-staging'),
		process.platform === 'win32' ? 'junction' : 'dir'
	);
	await assert.rejects(prepareStorageRestore(connection, { backupId: f.backup.id }, f.deps), {
		message: 'Storage restore preparation failed.'
	});
	assert.deepEqual(await fs.readdir(outside), ['sentinel']);
	assert.equal(f.calls.length, 0);
});

async function independentObjects(f) {
	const raw = [];
	for (const bundle of f.manifest.bundles) {
		const plain = path.join(f.root, `${randomUUID()}.gz`);
		await decryptFile(path.join(f.remote, 'backups', 'objects', bundle.object), plain);
		raw.push(gunzipSync(await fs.readFile(plain)));
	}
	for (const entry of f.manifest.files) {
		const plain = path.join(f.root, `${randomUUID()}.legacy`);
		const encrypted = path.join(f.root, `${randomUUID()}.enc`);
		await fs.writeFile(
			plain,
			Buffer.concat(
				entry.parts.map((part) => raw[part.bundle].subarray(part.offset, part.offset + part.bytes))
			)
		);
		await encryptFile(plain, encrypted);
		entry.remoteSha256 = createHash('sha256')
			.update(await fs.readFile(encrypted))
			.digest('hex');
		entry.object = `${entry.remoteSha256}.enc`;
		delete entry.parts;
		await fs.copyFile(encrypted, path.join(f.remote, 'backups', 'objects', entry.object));
	}
	f.manifest.version = 1;
	delete f.manifest.bundles;
	delete f.manifest.format;
	await f.replaceManifest(f.manifest);
	f.downloads.length = 0;
}

test('remote preparation downloads and restores legacy v1 independent objects', async (t) => {
	const f = await fixture(t);
	await independentObjects(f);
	const result = await prepareStorageRestore(connection, { backupId: f.backup.id }, f.deps);
	assert.equal(
		await fs.readFile(
			path.join(f.app, 'restore-staging', result.restoreId, 'uploads', 'audio.ogg'),
			'utf8'
		),
		'audio payload'
	);
});

for (const limit of [1, 2, 4]) {
	test(
		`restore uses ${limit} bounded transfer/local slots and retains restored data`,
		{ timeout: 10000 },
		async (t) => {
			const f = await fixture(t);
			const expected = Math.min(limit, f.manifest.bundles.length);
			let sessions = 0;
			let peakSessions = 0;
			const phases = new Map(
				['download', 'decrypt'].map((phase) => {
					let release;
					const gate = new Promise((resolve) => {
						release = resolve;
					});
					return [phase, { active: 0, peak: 0, arrivals: 0, gate, release }];
				})
			);
			async function tracked(phase, operation) {
				const state = phases.get(phase);
				state.peak = Math.max(state.peak, ++state.active);
				if (++state.arrivals === expected) state.release();
				try {
					await state.gate;
					return await operation();
				} finally {
					state.active--;
				}
			}
			const result = await prepareStorageRestore(
				{ ...connection, parallelConnections: limit },
				{ backupId: f.backup.id },
				{
					...f.deps,
					async withStorage(settings, callback) {
						assert.equal(settings.parallelConnections, limit);
						assert.equal(settings.fingerprint, connection.fingerprint);
						peakSessions = Math.max(peakSessions, ++sessions);
						try {
							return await callback(Object.create(f.client));
						} finally {
							sessions--;
						}
					},
					hashRemote(client, target, settings) {
						const operation = () => hashRemote(client, target, settings);
						return target.includes('/objects/') ? tracked('download', operation) : operation();
					},
					decryptFile(source, target) {
						const operation = () => decryptFile(source, target);
						return path.dirname(source).endsWith('objects')
							? tracked('decrypt', operation)
							: operation();
					}
				}
			);
			assert.equal(peakSessions, expected, 'coordinator is included in the session cap');
			assert.equal(sessions, 0);
			for (const state of phases.values()) {
				assert.equal(state.peak, expected);
				assert.equal(state.active, 0);
			}
			assert.ok(isStorageRestoreId(result.restoreId));
			assert.equal(
				await fs.readFile(
					path.join(f.app, 'restore-staging', result.restoreId, 'uploads', 'audio.ogg'),
					'utf8'
				),
				'audio payload'
			);
		}
	);
}

test(
	'restore preparation drains a coordinator callback that outlives its transport',
	{ timeout: 10000 },
	async (t) => {
		const f = await fixture(t);
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		let ready;
		const started = new Promise((resolve) => {
			ready = resolve;
		});
		let active = 0;
		let sessions = 0;
		let returned = false;
		const operation = prepareStorageRestore(
			{ ...connection, parallelConnections: 2 },
			{ backupId: f.backup.id },
			{
				...f.deps,
				async withStorage(_settings, callback) {
					const coordinator = ++sessions === 1;
					const running = callback(Object.create(f.client));
					running.catch(() => {});
					if (coordinator) {
						await started;
						throw new Error('private transport failure');
					}
					return running;
				},
				async hashRemote(client, target, settings) {
					if (!target.includes('/objects/')) return hashRemote(client, target, settings);
					active++;
					if (active === 2) ready();
					try {
						await gate;
						return await hashRemote(client, target, settings);
					} finally {
						active--;
					}
				}
			}
		).finally(() => {
			returned = true;
		});
		const rejected = assert.rejects(operation, { message: 'Storage restore preparation failed.' });
		await started;
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(returned, false);
		assert.equal(active, 2);
		assert.equal((await fs.readdir(path.join(f.app, 'restore-staging'))).length, 1);
		release();
		await rejected;
		assert.equal(active, 0);
		await f.clean();
	}
);

for (const version of [1, 2]) {
	for (const audioMode of ['remote', 'download']) {
		test(`v${version} ${audioMode} restore preserves the selected audio placement`, async (t) => {
			const f = await fixture(t, { archived: true, bundleBytes: 64 * 1024 });
			if (version === 1) await independentObjects(f);
			const before = await Promise.all(
				f.archiveObjects.map((object) => fs.readFile(path.join(f.remote, 'audio', object)))
			);
			const result = await prepareStorageRestore(
				connection,
				{ backupId: f.backup.id, audioMode },
				f.deps
			);
			const staging = path.join(f.app, 'restore-staging', result.restoreId);
			const database = new Database(path.join(staging, 'db', 'pacs.db'));
			try {
				assert.equal(result.audioMode, audioMode);
				assert.equal(result.remoteAudioFiles, audioMode === 'remote' ? 2 : 0);
				assert.equal(result.files + result.remoteAudioFiles, f.manifest.files.length);
				assert.equal(
					await fs.readFile(path.join(staging, 'uploads', 'report.md'), 'utf8'),
					'report payload'
				);
				const audio = path.join(staging, 'uploads', 'audio.ogg');
				if (audioMode === 'remote') {
					await assert.rejects(fs.stat(audio), { code: 'ENOENT' });
					await assert.rejects(fs.stat(path.join(staging, 'uploads', 'unreferenced.ogg')), {
						code: 'ENOENT'
					});
					assert.equal(database.prepare('SELECT count(*) AS n FROM storage_audio').get().n, 2);
					const saved = database
						.prepare('SELECT * FROM storage_audio WHERE path=?')
						.get('uploads/audio.ogg');
					assert.equal(saved.bytes, Buffer.byteLength(f.archivedContent));
					assert.equal(saved.destination, storageDestination(connection));
					assert.equal(getStorageConnection(database).password, connection.password);
					assert.equal(getStorageConnection(database).enabled, false);
					assert.equal(
						database.prepare('SELECT audio_report_path FROM study_recordings').get()
							.audio_report_path,
						'uploads/audio.ogg'
					);
					const previous = process.cwd();
					try {
						process.chdir(staging);
						assert.equal(
							await withAudioFile(
								database,
								'uploads/audio.ogg',
								(file) => fs.readFile(file, 'utf8'),
								{ transport: f.deps.withStorage }
							),
							f.archivedContent
						);
					} finally {
						process.chdir(previous);
					}
					assert.ok(!f.downloads.some((file) => file.startsWith('/vault/audio/')));
					const needed = new Set(
						f.manifest.files
							.filter((entry) => entry.role !== 'audio')
							.flatMap((entry) =>
								version === 1
									? [entry.object]
									: entry.parts.map((part) => f.manifest.bundles[part.bundle].object)
							)
					);
					for (const file of f.downloads.filter((file) => file.includes('/objects/')))
						assert.ok(
							needed.has(path.posix.basename(file)),
							'audio-only objects must not be downloaded'
						);
				} else {
					assert.equal(await fs.readFile(audio, 'utf8'), f.archivedContent);
					assert.equal(database.prepare('SELECT count(*) AS n FROM storage_audio').get().n, 0);
				}
				assert.deepEqual(
					await Promise.all(
						f.archiveObjects.map((object) => fs.readFile(path.join(f.remote, 'audio', object)))
					),
					before
				);
			} finally {
				database.close();
			}
		});
	}
}

for (const kind of ['missing', 'corrupt', 'symlink']) {
	test(`remote audio restore fails closed for ${kind} original archives without downloading them`, async (t) => {
		const f = await fixture(t, { archived: true });
		await independentObjects(f);
		const object = path.join(f.remote, 'audio', f.archiveObjects[0]);
		if (kind === 'missing') await fs.unlink(object);
		if (kind === 'corrupt') {
			const bytes = await fs.readFile(object);
			bytes[bytes.length - 1] ^= 1;
			await fs.writeFile(object, bytes);
		}
		if (kind === 'symlink') {
			const lstat = f.client.lstat;
			f.client.lstat = (file) =>
				file.endsWith(`/audio/${f.archiveObjects[0]}`)
					? Promise.resolve({ type: 'l' })
					: lstat(file);
		}
		await f.reject({ audioMode: 'remote' });
		assert.ok(!f.downloads.some((file) => file.startsWith('/vault/audio/')));
		assert.equal(f.db.prepare('SELECT count(*) AS n FROM storage_audio').get().n, 2);
	});
}

test('remote audio planning rejects a different destination and restore rejects forged omissions', async (t) => {
	const f = await fixture(t, { archived: true });
	await independentObjects(f);
	assert.throws(() => recoveryAudioPlan(f.manifest, f.db.name, { ...connection, root: '/other' }));
	const remoteAudio = recoveryAudioPlan(f.manifest, f.db.name, connection);
	remoteAudio[0].path = 'uploads/report.md';
	await assert.rejects(
		restoreRecovery({
			manifestFile: f.encryptedManifest,
			objectsDirectory: path.join(f.remote, 'backups', 'objects'),
			outputDirectory: path.join(f.root, 'forged'),
			audioMode: 'remote',
			remoteAudio,
			remoteConnection: connection
		}),
		{ message: 'Recovery restore failed. Output was not published.' }
	);
	await assert.rejects(fs.stat(path.join(f.root, 'forged')), { code: 'ENOENT' });
});

test('restore rejects invalid audio modes before opening storage', async (t) => {
	const f = await fixture(t);
	for (const audioMode of ['', 'skip', null, true])
		await assert.rejects(
			prepareStorageRestore(connection, { backupId: f.backup.id, audioMode }, f.deps),
			{ message: 'Storage restore preparation failed.' }
		);
	assert.equal(f.calls.length, 0);
});

test('remote mode restores non-archived audio locally', async (t) => {
	const f = await fixture(t);
	const result = await prepareStorageRestore(
		connection,
		{ backupId: f.backup.id, audioMode: 'remote' },
		f.deps
	);
	assert.equal(result.remoteAudioFiles, 0);
	assert.equal(result.files, f.manifest.files.length);
	assert.equal(
		await fs.readFile(
			path.join(f.app, 'restore-staging', result.restoreId, 'uploads', 'unreferenced.ogg'),
			'utf8'
		),
		'extra audio'
	);
});

for (const limit of [1, 4, 16]) {
	test(`remote audio verification uses at most ${limit} connections and drains on failure`, async (t) => {
		const f = await fixture(t, { archived: true });
		let sessions = 0;
		let active = 0;
		let peak = 0;
		let hashing = 0;
		let lateWrites = 0;
		let settled = false;
		const deps = {
			...f.deps,
			withStorage: async (_connection, operation) => {
				sessions += 1;
				active += 1;
				peak = Math.max(peak, active);
				try {
					return await operation({ ...f.client });
				} finally {
					active -= 1;
				}
			},
			hashStorageFile: async (client, remotePath) => {
				hashing += 1;
				try {
					await new Promise((resolve) => setTimeout(resolve, 30));
					if (settled) lateWrites += 1;
					if (remotePath.endsWith(f.archiveObjects[0]))
						throw new Error('Archive verification failed.');
					return await f.deps.hashStorageFile(client, remotePath);
				} finally {
					hashing -= 1;
				}
			}
		};
		await assert.rejects(
			prepareStorageRestore(
				{ ...connection, parallelConnections: limit },
				{ backupId: f.backup.id, audioMode: 'remote' },
				deps
			),
			{ message: 'Storage restore preparation failed.' }
		);
		settled = true;
		await f.clean();
		assert.equal(active, 0);
		assert.equal(hashing, 0);
		assert.equal(peak, Math.min(limit, f.archiveObjects.length));
		assert.ok(sessions > 0);
		await new Promise((resolve) => setTimeout(resolve, 45));
		assert.equal(lateWrites, 0);
	});
}

test('lost ownership during remote archive checks drains hashing before staging cleanup', async (t) => {
	const f = await fixture(t, { archived: true });
	let owned = true;
	let hashing = 0;
	const deps = {
		...f.deps,
		withStorage: async (_connection, operation) => operation({ ...f.client }),
		hashStorageFile: async (client, remotePath) => {
			hashing += 1;
			owned = false;
			try {
				await new Promise((resolve) => setTimeout(resolve, 150));
				return await f.deps.hashStorageFile(client, remotePath);
			} finally {
				hashing -= 1;
			}
		}
	};
	await f.reject({ audioMode: 'remote', owned: () => owned }, deps);
	assert.equal(hashing, 0);
});

test('remote preparation rejects authenticated oversized bundle declarations before object download', async (t) => {
	const f = await fixture(t);
	f.manifest.bundles[0].bytes = 256 * 1024 * 1024 + 1;
	await f.replaceManifest(f.manifest);
	await f.reject();
	assert.ok(!f.downloads.some((name) => name.includes('/objects/')));
});
