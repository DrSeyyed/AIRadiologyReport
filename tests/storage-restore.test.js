import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Transform } from 'node:stream';
import Database from 'better-sqlite3';
import { backupRecovery } from '../src/lib/server/recovery-backups.js';
import { decryptFile, encryptFile } from '../src/lib/server/storage-crypto.js';
import { hashRemote, storagePath } from '../src/lib/server/storage-transport.js';
import { isStorageRestoreId, prepareStorageRestore } from '../src/lib/server/storage-restore.js';

const connection = {
	host: 'storage.invalid',
	username: 'backup',
	password: 'private-password',
	root: '/vault',
	fingerprint: 'private-fingerprint'
};

async function fixture(t) {
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
	await fs.writeFile(path.join(app, 'uploads', 'audio.ogg'), 'audio payload');
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
			await fs.copyFile(source, local(p));
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
	const backup = await backupRecovery(
		db,
		connection,
		{ cwd: app, now: 1800000000, kind: 'full', env: {} },
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
	const result = await prepareStorageRestore(connection, { backupId: f.backup.id }, f.deps);
	assert.equal(result.id, f.backup.id);
	assert.ok(isStorageRestoreId(result.restoreId));
	assert.equal(result.files, f.manifest.files.length);
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0].operationTimeoutMs, 21_600_000);
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

test('remote preparation downloads and restores legacy v1 independent objects', async (t) => {
	const f = await fixture(t);
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
	const result = await prepareStorageRestore(connection, { backupId: f.backup.id }, f.deps);
	assert.equal(
		await fs.readFile(
			path.join(f.app, 'restore-staging', result.restoreId, 'uploads', 'audio.ogg'),
			'utf8'
		),
		'audio payload'
	);
});

test('remote preparation rejects authenticated oversized bundle declarations before object download', async (t) => {
	const f = await fixture(t);
	f.manifest.bundles[0].bytes = 256 * 1024 * 1024 + 1;
	await f.replaceManifest(f.manifest);
	await f.reject();
	assert.ok(!f.downloads.some((name) => name.includes('/objects/')));
});
