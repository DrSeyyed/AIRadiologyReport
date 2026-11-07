import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BUNDLE_BYTES } from '../src/lib/server/recovery-bundles.js';
import Database from 'better-sqlite3';
import {
	backupRecovery,
	listRecovery,
	pruneRecovery,
	restoreRecovery,
	recoveryDestination
} from '../src/lib/server/recovery-backups.js';

const connection = {
	host: 'EXAMPLE.invalid',
	port: 22,
	username: 'backup',
	password: 'private-password',
	root: '/vault',
	fingerprint: 'pinned'
};
const digest = (data) => createHash('sha256').update(data).digest('hex');

async function fixture(t) {
	const root = path.join(process.cwd(), 'tests', `.recovery-test-${randomUUID()}`);
	const app = path.join(root, 'app');
	const remote = path.join(root, 'remote');
	await fs.mkdir(path.join(app, 'uploads', 'audio'), { recursive: true });
	await fs.mkdir(remote, { recursive: true });
	const db = new Database(path.join(app, 'source.sqlite'));
	db.pragma('journal_mode = WAL');
	db.exec(`
		CREATE TABLE study_recordings(id INTEGER PRIMARY KEY, audio_report_path TEXT, text_report_path TEXT);
		CREATE TABLE recording_audio_parts(id INTEGER PRIMARY KEY, audio_report_path TEXT);
		CREATE TABLE storage_audio(path TEXT PRIMARY KEY, object_key TEXT, sha256 TEXT, remote_sha256 TEXT,
			bytes INTEGER, archived_at INTEGER, evicted_at INTEGER, destination TEXT);
	`);
	t.after(async () => {
		if (db.open) db.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	const key = randomBytes(32);
	const local = (remotePath) => {
		assert.ok(remotePath.startsWith('/vault/'));
		assert.ok(!remotePath.split('/').includes('..'));
		return path.join(remote, ...remotePath.slice('/vault/'.length).split('/'));
	};
	const client = {
		async mkdir(p) {
			await fs.mkdir(local(p), { recursive: true });
		},
		async put(source, p) {
			if (typeof source === 'string') await fs.copyFile(source, local(p));
			else await pipeline(source, createWriteStream(local(p)));
		},
		createReadStream(p) {
			return createReadStream(local(p));
		},
		async get(p, target) {
			await fs.copyFile(local(p), target);
		},
		async list(p) {
			return (await fs.readdir(local(p), { withFileTypes: true })).map((e) => ({
				name: e.name,
				type: e.isFile() ? '-' : e.isDirectory() ? 'd' : 'l'
			}));
		},
		async delete(p) {
			await fs.unlink(local(p));
		},
		async rename(a, b) {
			await fs.rename(local(a), local(b));
		}
	};
	const deps = {
		withStorage: async (_connection, callback) => callback(client),
		storagePath: (_connection, ...segments) => '/vault/' + segments.join('/'),
		hashRemote: async (_client, p) => digest(await fs.readFile(local(p))),
		assertStorageKey() {},
		async encryptFile(source, target) {
			const iv = randomBytes(12);
			const cipher = createCipheriv('aes-256-gcm', key, iv);
			const ciphertext = Buffer.concat([cipher.update(await fs.readFile(source)), cipher.final()]);
			await fs.writeFile(target, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), {
				mode: 0o600
			});
		},
		async decryptFile(source, target) {
			const bytes = await fs.readFile(source);
			const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
			decipher.setAuthTag(bytes.subarray(12, 28));
			await fs.writeFile(
				target,
				Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]),
				{ mode: 0o600 }
			);
		}
	};
	const options = { cwd: app, env: {}, now: 1800000000 };
	async function write(relative, value) {
		const target = path.join(app, ...relative.split('/'));
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, value);
		return target;
	}
	async function manifest(result) {
		const plain = path.join(root, `manifest-${randomUUID()}.json`);
		await deps.decryptFile(path.join(remote, 'backups', 'manifests', `${result.id}.enc`), plain);
		return JSON.parse(await fs.readFile(plain, 'utf8'));
	}
	function restoreOptions(result) {
		return {
			manifestFile: path.join(remote, 'backups', 'manifests', `${result.id}.enc`),
			objectsDirectory: path.join(remote, 'backups', 'objects'),
			outputDirectory: path.join(root, `restored-${randomUUID()}`)
		};
	}
	return { root, app, remote, db, deps, client, options, write, manifest, restoreOptions };
}

async function ordinary(t) {
	const f = await fixture(t);
	await f.write('uploads/audio/part.ogg', 'audio payload');
	await f.write('uploads/reports/report.md', 'report payload');
	f.db
		.prepare('INSERT INTO study_recordings VALUES(1, ?, ?)')
		.run('uploads/audio/part.ogg', 'uploads/reports/report.md');
	f.db.prepare('INSERT INTO recording_audio_parts VALUES(1, ?)').run('uploads/audio/part.ogg');
	return f;
}

for (const kind of ['database', 'full']) {
	test(`${kind} backup reports live file, verified bundle and transfer progress through publication`, async (t) => {
		const f = await ordinary(t);
		await f.write('.env', 'ORIGIN=https://example.invalid\nOPENAI_API_KEY=not-for-progress\n');
		t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: f.options.now * 1000 });
		const snapshots = [];
		let uploadedBytes = 0;
		let verificationBytes = 0;
		const remoteFile = (target) =>
			path.join(f.remote, ...target.slice('/vault/'.length).split('/'));
		const put = f.client.put;
		f.client.put = async (...args) => {
			await put(...args);
			uploadedBytes += (await fs.stat(remoteFile(args[1]))).size;
			t.mock.timers.tick(2_000);
			assert.equal(snapshots.at(-1).uploading, 1);
		};
		const hashRemote = f.deps.hashRemote;
		f.deps.hashRemote = async (client, target, settings) => {
			const bytes = (await fs.stat(remoteFile(target))).size;
			settings.onProgress(bytes);
			verificationBytes += bytes;
			t.mock.timers.tick(2_000);
			assert.equal(snapshots.at(-1).verifying, 1);
			return hashRemote(client, target);
		};
		const rename = f.client.rename;
		f.client.rename = async (...args) => {
			t.mock.timers.tick(2_000);
			const live = snapshots.at(-1);
			assert.equal(live.phase, 'publishing');
			assert.equal(live.files, live.totalFiles);
			assert.equal(live.uploadedObjects + live.reusedObjects, live.bundles);
			return rename(...args);
		};
		const result = await backupRecovery(
			f.db,
			connection,
			{ ...f.options, kind, onProgress: (value) => snapshots.push(value) },
			f.deps
		);
		const final = snapshots.at(-1);
		assert.equal(final.files, result.files);
		assert.equal(final.totalFiles, result.files);
		assert.equal(final.uploadedObjects, result.uploadedObjects);
		assert.equal(final.reusedObjects, result.reusedObjects);
		assert.equal(final.uploadedBytes, uploadedBytes);
		assert.equal(final.verificationBytes, verificationBytes);
		assert.equal(final.uploading + final.verifying, 0);
		assert.equal(final.phase, 'cleanup');
		assert.ok(snapshots.some((value) => value.phase === 'collecting'));
		assert.doesNotMatch(
			JSON.stringify(snapshots),
			/not-for-progress|private-password|uploads\/audio|example\.invalid/
		);
		const count = snapshots.length;
		t.mock.timers.tick(60_000);
		assert.equal(snapshots.length, count);
		await restoreRecovery(f.restoreOptions(result), f.deps);
	});
}

test('reused backup bundles count as verified without counting their bytes as new uploads', async (t) => {
	const f = await ordinary(t);
	await backupRecovery(f.db, connection, f.options, f.deps);
	const snapshots = [];
	const result = await backupRecovery(
		f.db,
		connection,
		{ ...f.options, now: f.options.now + 1, onProgress: (value) => snapshots.push(value) },
		f.deps
	);
	const final = snapshots.at(-1);
	assert.equal(final.uploadedObjects, 0);
	assert.equal(final.reusedObjects, result.reusedObjects);
	assert.equal(final.bundles, result.reusedObjects);
	assert.ok(final.reusedObjects > 0);
	assert.ok(final.uploadedBytes > 0, 'the manifest and publication index still need uploading');
});

test('a failing progress observer cannot publish a recovery point or leak its error', async (t) => {
	const f = await ordinary(t);
	await assert.rejects(
		backupRecovery(
			f.db,
			connection,
			{
				...f.options,
				onProgress() {
					throw new Error('private observer detail');
				}
			},
			f.deps
		),
		{ message: 'Recovery backup failed.' }
	);
	assert.deepEqual(await listRecovery(connection, f.deps), []);
	assert.equal(
		await fs.readFile(path.join(f.app, 'uploads', 'audio', 'part.ogg'), 'utf8'),
		'audio payload'
	);
});

test('full encrypted snapshot restores SQLite, reports, uploads extras and filtered private environment', async (t) => {
	const f = await ordinary(t);
	await f.write('uploads/templates/custom.txt', 'template payload');
	await f.write(
		'.env',
		'ORIGIN=https://example.invalid\nOPENAI_API_KEY=forbidden-secret\nSTORAGE_ENCRYPTION_KEY=forbidden-key\n'
	);
	const result = await backupRecovery(
		f.db,
		connection,
		{
			...f.options,
			kind: 'full',
			env: { NODE_ENV: 'production', OPENAI_API_KEY: 'forbidden-secret' }
		},
		f.deps
	);
	assert.equal(result.files, 6);
	const listing = await listRecovery(connection, f.deps);
	assert.deepEqual(listing, [{ id: result.id, kind: 'full', createdAt: f.options.now }]);
	const manifest = await f.manifest(result);
	assert.equal(manifest.references.length, 2);
	assert.equal(manifest.version, 2);
	assert.equal(manifest.format, 'concat-gzip-v1');
	assert.equal(manifest.bundles.length, 2);
	assert.ok(manifest.bundles.every((bundle) => bundle.bytes <= BUNDLE_BYTES));
	for (const name of await fs.readdir(path.join(f.remote, 'backups', 'objects'))) {
		const bytes = await fs.readFile(path.join(f.remote, 'backups', 'objects', name));
		assert.ok(!bytes.includes(Buffer.from('audio payload')));
		assert.ok(!bytes.includes(Buffer.from('forbidden-secret')));
	}
	const restore = f.restoreOptions(result);
	await restoreRecovery(restore, f.deps);
	assert.equal(
		await fs.readFile(
			path.join(restore.outputDirectory, 'uploads', 'templates', 'custom.txt'),
			'utf8'
		),
		'template payload'
	);
	assert.equal(
		await fs.readFile(path.join(restore.outputDirectory, 'uploads', 'audio', 'part.ogg'), 'utf8'),
		'audio payload'
	);
	assert.equal(
		await fs.readFile(path.join(restore.outputDirectory, '.env'), 'utf8'),
		'ORIGIN="https://example.invalid"\nVOICE_SAVE_DIR="uploads/audio"\n'
	);
	assert.deepEqual(
		JSON.parse(await fs.readFile(path.join(restore.outputDirectory, 'environment.json'), 'utf8')),
		{ NODE_ENV: 'production', VOICE_SAVE_DIR: 'uploads/audio' }
	);
	const restored = new Database(path.join(restore.outputDirectory, 'db', 'pacs.db'));
	assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
	assert.equal(restored.prepare('SELECT count(*) AS count FROM study_recordings').get().count, 1);
	restored.close();
	if (process.platform !== 'win32')
		assert.equal((await fs.stat(path.join(restore.outputDirectory, '.env'))).mode & 0o777, 0o600);
});

test('database-only snapshots independently include referenced files and reuse verified encrypted objects', async (t) => {
	const f = await ordinary(t);
	await f.write('uploads/unreferenced.txt', 'not referenced');
	const first = await backupRecovery(f.db, connection, f.options, f.deps);
	const second = await backupRecovery(
		f.db,
		connection,
		{ ...f.options, now: f.options.now + 1 },
		f.deps
	);
	assert.notEqual(first.id, second.id);
	assert.equal(second.reusedObjects, 2);
	assert.equal(second.uploadedObjects, 0);
	assert.ok(
		!(await f.manifest(second)).files.some((entry) => entry.path === 'uploads/unreferenced.txt')
	);
	await fs.unlink(path.join(f.remote, 'backups', 'manifests', `${first.id}.enc`));
	await restoreRecovery(f.restoreOptions(second), f.deps);
});

test('database snapshot is taken before enumerating references, ignoring later database inserts', async (t) => {
	const f = await ordinary(t);
	const wrapper = {
		async backup(target) {
			await f.db.backup(target);
			f.db
				.prepare('INSERT INTO study_recordings VALUES(2, ?, NULL)')
				.run('uploads/audio/new-but-missing.ogg');
		}
	};
	const result = await backupRecovery(wrapper, connection, f.options, f.deps);
	assert.equal((await f.manifest(result)).references.length, 2);
	const restore = f.restoreOptions(result);
	await restoreRecovery(restore, f.deps);
	const restored = new Database(path.join(restore.outputDirectory, 'db', 'pacs.db'));
	assert.equal(restored.prepare('SELECT count(*) AS count FROM study_recordings').get().count, 1);
	restored.close();
});

test('archive-only audio is authenticated and copied into an independent backup object', async (t) => {
	const f = await fixture(t);
	const original = 'uploads/audio/archived.ogg';
	const source = await f.write(original, 'archive-only payload');
	const object = `${randomUUID()}.enc`;
	await fs.mkdir(path.join(f.remote, 'audio'));
	const archive = path.join(f.remote, 'audio', object);
	await f.deps.encryptFile(source, archive);
	f.db.prepare('INSERT INTO study_recordings VALUES(1, ?, NULL)').run(original);
	f.db
		.prepare('INSERT INTO storage_audio VALUES(?,?,?,?,?,?,?,?)')
		.run(
			original,
			object,
			digest(await fs.readFile(source)),
			digest(await fs.readFile(archive)),
			(await fs.stat(source)).size,
			1,
			2,
			recoveryDestination(connection)
		);
	await fs.unlink(source);
	const progress = [];
	const result = await backupRecovery(
		f.db,
		connection,
		{ ...f.options, kind: 'full', onProgress: (value) => progress.push(value) },
		f.deps
	);
	assert.equal(progress.at(-1).downloadedBytes, (await fs.stat(archive)).size);
	const entry = (await f.manifest(result)).files.find((e) => e.path === original);
	assert.notEqual(entry.object, object);
	await fs.rm(path.join(f.remote, 'audio'), { recursive: true });
	const restore = f.restoreOptions(result);
	await restoreRecovery(restore, f.deps);
	assert.equal(
		await fs.readFile(
			path.join(restore.outputDirectory, 'uploads', 'audio', 'archived.ogg'),
			'utf8'
		),
		'archive-only payload'
	);
	const restored = new Database(path.join(restore.outputDirectory, 'db', 'pacs.db'));
	assert.equal(restored.prepare('SELECT count(*) AS count FROM storage_audio').get().count, 0);
	restored.close();
});

test('missing referenced file fails closed without publishing an index and cleans work directories', async (t) => {
	const f = await ordinary(t);
	await fs.unlink(path.join(f.app, 'uploads', 'audio', 'part.ogg'));
	await assert.rejects(
		backupRecovery(f.db, connection, f.options, f.deps),
		/^Error: Recovery backup failed/
	);
	assert.deepEqual(await listRecovery(connection, f.deps), []);
	assert.ok(!(await fs.readdir(f.app)).some((name) => name.startsWith('.recovery-work-')));
});

test('interrupted upload cannot create a completed snapshot', async (t) => {
	const f = await ordinary(t);
	f.client.rename = async () => {
		throw new Error('private-password patient-name');
	};
	await assert.rejects(backupRecovery(f.db, connection, f.options, f.deps), (error) => {
		assert.ok(!error.message.includes('patient-name'));
		assert.ok(!error.message.includes('private-password'));
		return true;
	});
	assert.deepEqual(await listRecovery(connection, f.deps), []);
});

test('mutating a source during collection fails closed', async (t) => {
	const f = await ordinary(t);
	const put = f.client.put;
	f.client.put = async (source, destination) => {
		await put(source, destination);
		if (destination.includes('/objects/'))
			await fs.unlink(path.join(f.app, 'uploads', 'audio', 'part.ogg')).catch(() => {});
	};
	await assert.rejects(backupRecovery(f.db, connection, f.options, f.deps));
	assert.deepEqual(await listRecovery(connection, f.deps), []);
});

test('tampered encrypted object prevents incremental reuse and offline publication', async (t) => {
	const f = await ordinary(t);
	const result = await backupRecovery(f.db, connection, f.options, f.deps);
	const manifest = await f.manifest(result);
	const file = path.join(
		f.remote,
		'backups',
		'objects',
		manifest.bundles[manifest.files.find((entry) => entry.role === 'audio').parts[0].bundle].object
	);
	await fs.appendFile(file, 'tampered');
	await assert.rejects(
		backupRecovery(f.db, connection, { ...f.options, now: f.options.now + 1 }, f.deps)
	);
	assert.equal((await listRecovery(connection, f.deps)).length, 1);
	const restore = f.restoreOptions(result);
	await assert.rejects(restoreRecovery(restore, f.deps), /^Error: Recovery restore failed/);
	await assert.rejects(fs.stat(restore.outputDirectory), { code: 'ENOENT' });
});

test('tampered authenticated manifest cannot restore', async (t) => {
	const f = await ordinary(t);
	const result = await backupRecovery(f.db, connection, f.options, f.deps);
	const restore = f.restoreOptions(result);
	const bytes = await fs.readFile(restore.manifestFile);
	bytes[bytes.length - 1] ^= 1;
	await fs.writeFile(restore.manifestFile, bytes);
	await assert.rejects(restoreRecovery(restore, f.deps));
	await assert.rejects(fs.stat(restore.outputDirectory), { code: 'ENOENT' });
});

test('restore rejects traversal, absolute and colliding manifest destinations', async (t) => {
	const f = await ordinary(t);
	const result = await backupRecovery(f.db, connection, f.options, f.deps);
	const original = await f.manifest(result);
	for (const bad of [
		'../escaped',
		'/absolute',
		'C:\\absolute',
		'uploads/../escape',
		'uploads\\escape',
		'db/pacs.db'
	]) {
		const changed = structuredClone(original);
		changed.files.find((entry) => entry.role === 'audio').path = bad;
		const plain = path.join(f.root, 'changed.json');
		await fs.writeFile(plain, JSON.stringify(changed));
		const restore = f.restoreOptions(result);
		await f.deps.encryptFile(plain, restore.manifestFile);
		await assert.rejects(restoreRecovery(restore, f.deps));
	}
});

test('restore refuses existing nonempty output and preserves it', async (t) => {
	const f = await ordinary(t);
	const result = await backupRecovery(f.db, connection, f.options, f.deps);
	const restore = f.restoreOptions(result);
	await fs.mkdir(restore.outputDirectory);
	await fs.writeFile(path.join(restore.outputDirectory, 'keep'), 'existing');
	await assert.rejects(restoreRecovery(restore, f.deps));
	assert.equal(await fs.readFile(path.join(restore.outputDirectory, 'keep'), 'utf8'), 'existing');
});

test('custom voice root and absolute database references remain local after promotion', async (t) => {
	const f = await fixture(t);
	const voice = path.join(f.root, 'custom-voice');
	await fs.mkdir(voice);
	const original = path.join(voice, 'custom.ogg');
	const report = path.join(voice, 'custom.txt');
	await fs.writeFile(original, 'custom audio');
	await fs.writeFile(report, 'custom report');
	f.db.prepare('INSERT INTO study_recordings VALUES(1, ?, ?)').run(original, report);
	const result = await backupRecovery(
		f.db,
		connection,
		{ ...f.options, kind: 'full', voiceSaveDir: voice, env: { VOICE_SAVE_DIR: voice } },
		f.deps
	);
	const restore = f.restoreOptions(result);
	await restoreRecovery(restore, f.deps);
	assert.equal(
		await fs.readFile(path.join(restore.outputDirectory, 'voice', 'custom.ogg'), 'utf8'),
		'custom audio'
	);
	const restored = new Database(path.join(restore.outputDirectory, 'db', 'pacs.db'));
	const paths = restored
		.prepare('SELECT audio_report_path, text_report_path FROM study_recordings')
		.get();
	assert.equal(paths.audio_report_path, 'voice/custom.ogg');
	assert.equal(paths.text_report_path, 'voice/custom.txt');
	restored.close();
	const promoted = path.join(f.root, 'promoted-app');
	await fs.rename(restore.outputDirectory, promoted);
	assert.equal(
		await fs.readFile(path.resolve(promoted, paths.audio_report_path), 'utf8'),
		'custom audio'
	);
	assert.equal(
		await fs.readFile(path.resolve(promoted, paths.text_report_path), 'utf8'),
		'custom report'
	);
	restore.outputDirectory = promoted;
	assert.equal(
		JSON.parse(await fs.readFile(path.join(restore.outputDirectory, 'environment.json'), 'utf8'))
			.VOICE_SAVE_DIR,
		'voice'
	);
});

test('outside allowlist sources and symlinks are rejected', async (t) => {
	const f = await fixture(t);
	const outside = path.join(f.root, 'outside.ogg');
	await fs.writeFile(outside, 'outside');
	f.db.prepare('INSERT INTO study_recordings VALUES(1, ?, NULL)').run(outside);
	await assert.rejects(backupRecovery(f.db, connection, f.options, f.deps));
	f.db.prepare('DELETE FROM study_recordings').run();
	const link = path.join(f.app, 'uploads', 'linked');
	try {
		await fs.symlink(f.root, link, process.platform === 'win32' ? 'junction' : 'dir');
	} catch (error) {
		if (error.code === 'EPERM') return;
		throw error;
	}
	await assert.rejects(backupRecovery(f.db, connection, { ...f.options, kind: 'full' }, f.deps));
	assert.deepEqual(await listRecovery(connection, f.deps), []);
});

test('retention keeps newest UTC hourly/daily/monthly buckets, never archives or objects', async (t) => {
	const f = await fixture(t);
	const now = Math.floor(Date.UTC(2026, 10, 6, 16, 30) / 1000);
	const ago = (hours) => now - hours * 3600;
	const dates = [
		ago(0),
		ago(0) - 30,
		ago(1),
		ago(3),
		ago(24),
		ago(48),
		Math.floor(Date.UTC(2026, 9, 15) / 1000),
		Math.floor(Date.UTC(2026, 7, 1) / 1000)
	];
	for (const timestamp of dates)
		await backupRecovery(f.db, connection, { ...f.options, now: timestamp }, f.deps);
	await fs.mkdir(path.join(f.remote, 'audio'));
	await fs.writeFile(path.join(f.remote, 'audio', 'never-delete.enc'), 'archive');
	const before = await fs.readdir(path.join(f.remote, 'backups', 'objects'));
	const result = await pruneRecovery(
		connection,
		{ hourlyRetention: 2, dailyRetention: 2, monthlyRetention: 2 },
		now,
		f.deps
	);
	assert.equal(result.pruned, 4);
	assert.equal(result.kept, 4);
	assert.deepEqual(
		(await listRecovery(connection, f.deps)).map((s) => s.createdAt),
		[ago(0), ago(1), ago(24), dates[6]]
	);
	assert.deepEqual(await fs.readdir(path.join(f.remote, 'backups', 'objects')), before);
	assert.equal(
		await fs.readFile(path.join(f.remote, 'audio', 'never-delete.enc'), 'utf8'),
		'archive'
	);
	await pruneRecovery(
		connection,
		{ hourlyRetention: 0, dailyRetention: 0, monthlyRetention: 0 },
		now,
		f.deps
	);
	assert.equal((await listRecovery(connection, f.deps)).length, 1);
});

test('archive authentication, wrong destination and plaintext mismatch fail closed', async (t) => {
	for (const mismatch of ['destination', 'ciphertext', 'plaintext']) {
		const f = await fixture(t);
		const original = 'uploads/audio/archived.ogg';
		const source = await f.write(original, 'private audio');
		const object = `${randomUUID()}.enc`;
		await fs.mkdir(path.join(f.remote, 'audio'));
		const archived = path.join(f.remote, 'audio', object);
		await f.deps.encryptFile(source, archived);
		f.db.prepare('INSERT INTO study_recordings VALUES(1, ?, NULL)').run(original);
		f.db
			.prepare('INSERT INTO storage_audio VALUES(?,?,?,?,?,?,?,?)')
			.run(
				original,
				object,
				mismatch === 'plaintext' ? '0'.repeat(64) : digest(await fs.readFile(source)),
				mismatch === 'ciphertext' ? '0'.repeat(64) : digest(await fs.readFile(archived)),
				(await fs.stat(source)).size,
				1,
				2,
				mismatch === 'destination' ? 'wrong' : recoveryDestination(connection)
			);
		await fs.unlink(source);
		await assert.rejects(backupRecovery(f.db, connection, f.options, f.deps));
		assert.deepEqual(await listRecovery(connection, f.deps), []);
	}
});

test('incorrect decryption key and missing object fail without publishing partial output', async (t) => {
	const f = await ordinary(t);
	const result = await backupRecovery(f.db, connection, f.options, f.deps);
	const other = await fixture(t);
	await assert.rejects(restoreRecovery(f.restoreOptions(result), other.deps));
	const manifest = await f.manifest(result);
	await fs.unlink(path.join(f.remote, 'backups', 'objects', manifest.bundles[0].object));
	const restore = f.restoreOptions(result);
	await fs.mkdir(restore.outputDirectory);
	await assert.rejects(restoreRecovery(restore, f.deps));
	assert.deepEqual(await fs.readdir(restore.outputDirectory), []);
});

test('collection detects a source changed after its encrypted object was uploaded', async (t) => {
	const f = await ordinary(t);
	const put = f.client.put;
	f.client.put = async (source, destination) => {
		await put(source, destination);
		// Mutate a captured source after bundle upload, not during copying.
		if (destination.includes('/objects/')) {
			const plain = path.join(f.root, 'checking-upload');
			await f.deps.decryptFile(source, plain);
			if ((await fs.readFile(plain)).length > 0) {
				await fs.writeFile(path.join(f.app, 'uploads', 'audio', 'part.ogg'), 'audio changed');
			}
		}
	};
	await assert.rejects(backupRecovery(f.db, connection, f.options, f.deps));
	assert.deepEqual(await listRecovery(connection, f.deps), []);
});

test('retention preserves the newest full file catalog even when a database snapshot is newer', async (t) => {
	const f = await ordinary(t);
	await f.write('uploads/templates/template.txt', 'extra template');
	const full = await backupRecovery(f.db, connection, { ...f.options, kind: 'full' }, f.deps);
	const database = await backupRecovery(
		f.db,
		connection,
		{ ...f.options, now: f.options.now + 1 },
		f.deps
	);
	const result = await pruneRecovery(
		connection,
		{ hourlyRetention: 0, dailyRetention: 0, monthlyRetention: 0 },
		f.options.now + 2,
		f.deps
	);
	assert.equal(result.kept, 2);
	assert.deepEqual(
		(await listRecovery(connection, f.deps)).map((entry) => entry.id),
		[database.id, full.id]
	);
});

test('environment whitelist skips multiline provider secrets and normalizes a custom restore root', async (t) => {
	const f = await fixture(t);
	await f.write(
		'.env',
		[
			'OPENAI_API_KEY="multiline',
			'ORIGIN=must-not-be-copied',
			'end"',
			'ORIGIN="https://example.invalid" # private comment omitted',
			'VOICE_SAVE_DIR="uploads/voice"',
			'HOST=127.0.0.1 # private comment omitted',
			'THIRDPARTY_SECRET=do-not-copy'
		].join('\n')
	);
	const result = await backupRecovery(
		f.db,
		connection,
		{ ...f.options, voiceSaveDir: 'uploads/voice' },
		f.deps
	);
	const restore = f.restoreOptions(result);
	await restoreRecovery(restore, f.deps);
	const content = await fs.readFile(path.join(restore.outputDirectory, '.env'), 'utf8');
	assert.ok(content.includes('ORIGIN="https://example.invalid"'));
	assert.ok(content.includes('VOICE_SAVE_DIR="uploads/voice"'));
	assert.ok(!content.includes('must-not-be-copied'));
	assert.ok(!content.includes('comment'));
	assert.ok(!content.includes('do-not-copy'));
});

test('unsupported backup kinds, invalid retention and overly broad voice roots are rejected', async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		backupRecovery(f.db, connection, { ...f.options, kind: 'unsupported' }, f.deps)
	);
	await assert.rejects(
		backupRecovery(f.db, connection, { ...f.options, voiceSaveDir: f.app }, f.deps)
	);
	await assert.rejects(pruneRecovery(connection, { hourlyRetention: -1 }, f.options.now, f.deps));
	await assert.rejects(pruneRecovery(connection, { dailyRetention: 0.5 }, f.options.now, f.deps));
	assert.deepEqual(await listRecovery(connection, f.deps), []);
});

async function savedArchive(f, { referenced = true, keepLocal = false } = {}) {
	const original = `uploads/audio/${randomUUID()}.ogg`;
	const source = await f.write(original, 'saved archive payload');
	const object = `${randomUUID()}.enc`;
	await fs.mkdir(path.join(f.remote, 'audio'), { recursive: true });
	const encrypted = path.join(f.remote, 'audio', object);
	await f.deps.encryptFile(source, encrypted);
	f.db
		.prepare('INSERT INTO storage_audio VALUES(?,?,?,?,?,?,?,?)')
		.run(
			original,
			object,
			digest(await fs.readFile(source)),
			digest(await fs.readFile(encrypted)),
			(await fs.stat(source)).size,
			f.options.now,
			keepLocal ? null : f.options.now,
			recoveryDestination(connection)
		);
	if (referenced)
		f.db.prepare('INSERT INTO study_recordings(audio_report_path) VALUES(?)').run(original);
	if (!keepLocal) await fs.unlink(source);
	return { original, source, encrypted, object };
}

test('database snapshots include archived referenced audio and full snapshots include unreferenced saved archives', async (t) => {
	const f = await fixture(t);
	const referenced = await savedArchive(f);
	const unreferenced = await savedArchive(f, { referenced: false });
	const database = await backupRecovery(f.db, connection, f.options, f.deps);
	assert.equal(database.archivedFiles, 1);
	assert.ok((await f.manifest(database)).files.some((file) => file.path === referenced.original));
	assert.ok(
		!(await f.manifest(database)).files.some((file) => file.path === unreferenced.original)
	);
	const full = await backupRecovery(f.db, connection, { ...f.options, kind: 'full' }, f.deps);
	assert.equal(full.archivedFiles, 2);
	assert.ok((await f.manifest(full)).files.some((file) => file.path === unreferenced.original));
});

for (const kind of ['database', 'full']) {
	for (const corrupt of [false, true]) {
		test(
			`${kind} backup verifies archives four at a time in both publication passes${corrupt ? ' and rejects late corruption' : ''}`,
			{ timeout: 5000 },
			async (t) => {
				const f = await fixture(t);
				const archives = [];
				for (let i = 0; i < 4; i++) archives.push(await savedArchive(f, { keepLocal: true }));
				t.mock.timers.enable({ apis: ['setInterval'] });
				const snapshots = [];
				const reads = new Map();
				let coordinator;
				let workers = 0;
				let active = 0;
				let passes = 0;
				let gate;
				let release;
				const deps = {
					...f.deps,
					async withStorage(_settings, callback) {
						const client = {
							...f.client,
							async put(source, target) {
								await f.client.put(source, target);
								if (corrupt && target.endsWith('.pending'))
									await fs.appendFile(archives[0].encrypted, 'changed');
							},
							async rename(source, target) {
								assert.equal(workers, 0, 'close every verification worker before publication');
								assert.equal(active, 0);
								assert.equal(passes, 2, 'retain both complete verification passes');
								return f.client.rename(source, target);
							}
						};
						const extra = !!coordinator;
						if (extra) workers++;
						else coordinator = client;
						try {
							return await callback(client);
						} finally {
							if (extra) workers--;
						}
					},
					async hashRemote(client, target, settings) {
						if (!target.startsWith('/vault/audio/'))
							return f.deps.hashRemote(client, target, settings);
						reads.set(target, (reads.get(target) || 0) + 1);
						if (active++ === 0)
							gate = new Promise((resolve) => {
								release = resolve;
							});
						const current = gate;
						if (active === 4) {
							passes++;
							t.mock.timers.tick(2000);
							release();
						}
						try {
							await current;
							return await f.deps.hashRemote(client, target, settings);
						} finally {
							active--;
						}
					}
				};
				const operation = backupRecovery(
					f.db,
					connection,
					{ ...f.options, kind, onProgress: (value) => snapshots.push(value) },
					deps
				);
				if (corrupt) {
					await assert.rejects(operation, /Recovery backup failed/);
					assert.deepEqual(await listRecovery(connection, f.deps), []);
				} else {
					assert.equal((await operation).archivedFiles, 4);
				}
				assert.equal(passes, 2);
				assert.equal(reads.size, 4);
				for (const count of reads.values()) assert.equal(count, 2);
				assert.equal(workers, 0);
				assert.equal(active, 0);
				assert.ok(snapshots.some((value) => value.phase === 'verifying' && value.verifying === 4));
				assert.equal(snapshots.at(-1).verifying, 0);
			}
		);
	}
}

test('full backup rejects archive metadata changed after collection, including during pending-index upload', async (t) => {
	for (const change of ['sha256', 'object_key', 'archived_at', 'deleted']) {
		const f = await fixture(t);
		const archive = await savedArchive(f);
		const put = f.client.put;
		f.client.put = async (source, target) => {
			await put(source, target);
			if (target.endsWith('.pending')) {
				if (change === 'deleted')
					f.db.prepare('DELETE FROM storage_audio WHERE path = ?').run(archive.original);
				else
					f.db
						.prepare(`UPDATE storage_audio SET ${change} = ? WHERE path = ?`)
						.run(
							change === 'sha256'
								? '0'.repeat(64)
								: change === 'object_key'
									? `${randomUUID()}.enc`
									: f.options.now + 1,
							archive.original
						);
			}
		};
		await assert.rejects(backupRecovery(f.db, connection, { ...f.options, kind: 'full' }, f.deps));
		assert.deepEqual(await listRecovery(connection, f.deps), []);
	}
});

test('full backup rejects a new archive created after the database snapshot with archived_at equal to start', async (t) => {
	const f = await fixture(t);
	const put = f.client.put;
	f.client.put = async (source, target) => {
		await put(source, target);
		if (target.endsWith('.pending')) await savedArchive(f, { referenced: false });
	};
	await assert.rejects(backupRecovery(f.db, connection, { ...f.options, kind: 'full' }, f.deps));
	assert.deepEqual(await listRecovery(connection, f.deps), []);
});

test('full backup verifies local archived plaintext and rechecks encrypted archive bytes at publication', async (t) => {
	for (const change of ['local', 'remote']) {
		const f = await fixture(t);
		const archive = await savedArchive(f, { keepLocal: true });
		if (change === 'local') await fs.writeFile(archive.source, 'changed local data');
		else {
			const put = f.client.put;
			f.client.put = async (source, target) => {
				await put(source, target);
				if (target.endsWith('.pending'))
					await fs.appendFile(archive.encrypted, 'changed remote data');
			};
		}
		await assert.rejects(backupRecovery(f.db, connection, { ...f.options, kind: 'full' }, f.deps));
		assert.deepEqual(await listRecovery(connection, f.deps), []);
	}
});

test('owned lease callback is checked before work and immediately before completion publication', async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		backupRecovery(f.db, connection, { ...f.options, owned: () => false }, f.deps)
	);
	let owned = true;
	let calls = 0;
	const put = f.client.put;
	f.client.put = async (source, target) => {
		await put(source, target);
		if (target.endsWith('.pending')) owned = false;
	};
	await assert.rejects(
		backupRecovery(
			f.db,
			connection,
			{
				...f.options,
				owned: async () => {
					calls++;
					return owned;
				}
			},
			f.deps
		)
	);
	assert.ok(calls >= 3);
	assert.deepEqual(await listRecovery(connection, f.deps), []);
	f.client.put = put;
	const result = await backupRecovery(
		f.db,
		connection,
		{ ...f.options, owned: () => true },
		f.deps
	);
	assert.equal((await listRecovery(connection, f.deps))[0].id, result.id);
});

test('STORAGE_ENCRYPTION_KEY from process.env is never exported in environment snapshots', async (t) => {
	const f = await fixture(t);
	const previous = process.env.STORAGE_ENCRYPTION_KEY;
	const secret = randomBytes(32).toString('base64');
	process.env.STORAGE_ENCRYPTION_KEY = secret;
	try {
		const result = await backupRecovery(
			f.db,
			connection,
			{ ...f.options, env: { ...process.env, VOICE_SAVE_DIR: 'uploads/audio' } },
			f.deps
		);
		const restore = f.restoreOptions(result);
		await restoreRecovery(restore, f.deps);
		const environment = await fs.readFile(
			path.join(restore.outputDirectory, 'environment.json'),
			'utf8'
		);
		assert.ok(!environment.includes('STORAGE_ENCRYPTION_KEY'));
		assert.ok(!environment.includes(secret));
	} finally {
		if (previous === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
		else process.env.STORAGE_ENCRYPTION_KEY = previous;
	}
});

test('restore pauses storage and clears all job and lease history while retaining encrypted credentials', async (t) => {
	const f = await ordinary(t);
	f.db.exec(`
		CREATE TABLE application_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE storage_jobs(id INTEGER PRIMARY KEY, kind TEXT, status TEXT);
		CREATE TABLE storage_worker_lock(id INTEGER PRIMARY KEY, owner TEXT, expires_at INTEGER);
		INSERT INTO storage_jobs VALUES(1,'full','succeeded'),(2,'full','running'),(3,'database','pending'),(4,'database','failed');
		INSERT INTO storage_worker_lock VALUES(1,'obsolete-worker',2000000000);
		CREATE TABLE storage_job_cancellations(job_id INTEGER PRIMARY KEY REFERENCES storage_jobs(id), requested_at INTEGER NOT NULL);
		INSERT INTO storage_job_cancellations VALUES(2,1800000000);
	`);
	const settings = {
		enabled: true,
		archiveEnabled: true,
		backupsEnabled: true,
		host: 'example.invalid',
		port: 22,
		username: 'backup',
		root: '/original-destination',
		fingerprint: 'pinned',
		hourlyRetention: 48,
		dailyRetention: 30,
		monthlyRetention: 12
	};
	const insert = f.db.prepare('INSERT INTO application_settings VALUES(?,?)');
	insert.run('storage_settings', JSON.stringify(settings));
	insert.run('storage_password', 'opaque-encrypted-credential');
	insert.run('unrelated_setting', 'keep unchanged');
	const result = await backupRecovery(f.db, connection, { ...f.options, kind: 'full' }, f.deps);
	const restore = f.restoreOptions(result);
	await restoreRecovery(restore, f.deps);
	const restored = new Database(path.join(restore.outputDirectory, 'db', 'pacs.db'));
	try {
		const values = Object.fromEntries(
			restored
				.prepare('SELECT key,value FROM application_settings')
				.all()
				.map((row) => [row.key, row.value])
		);
		assert.deepEqual(JSON.parse(values.storage_settings), {
			...settings,
			enabled: false,
			archiveEnabled: false,
			backupsEnabled: false
		});
		assert.equal(values.storage_password, 'opaque-encrypted-credential');
		assert.equal(values.unrelated_setting, 'keep unchanged');
		assert.equal(
			restored.prepare('SELECT count(*) AS n FROM storage_job_cancellations').get().n,
			0
		);
		assert.equal(restored.prepare('SELECT count(*) AS n FROM storage_jobs').get().n, 0);
		assert.equal(restored.prepare('SELECT count(*) AS n FROM storage_worker_lock').get().n, 0);
		assert.equal(restored.prepare('SELECT count(*) AS n FROM storage_audio').get().n, 0);
		assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
	} finally {
		restored.close();
	}
	assert.deepEqual(
		JSON.parse(
			f.db.prepare("SELECT value FROM application_settings WHERE key='storage_settings'").get()
				.value
		),
		settings
	);
	assert.equal(f.db.prepare('SELECT count(*) AS n FROM storage_jobs').get().n, 4);
	assert.equal(f.db.prepare('SELECT count(*) AS n FROM storage_job_cancellations').get().n, 1);
});

test('full settings extras are accepted and daily/monthly full catalogs survive newer database snapshots', async (t) => {
	const f = await fixture(t);
	const now = Math.floor(Date.UTC(2026, 10, 6, 16, 30) / 1000);
	const snapshots = {};
	for (const [label, kind, date] of [
		['expiredFull', 'full', Date.UTC(2026, 8, 10)],
		['olderMonthlyFull', 'full', Date.UTC(2026, 9, 3)],
		['monthlyFull', 'full', Date.UTC(2026, 9, 5)],
		['monthlyDatabase', 'database', Date.UTC(2026, 9, 28)],
		['dailyFull', 'full', Date.UTC(2026, 10, 5, 2)],
		['dailyDatabase', 'database', Date.UTC(2026, 10, 5, 23)],
		['latestFull', 'full', Date.UTC(2026, 10, 6, 2)],
		['latestDatabase', 'database', now * 1000]
	])
		snapshots[label] = await backupRecovery(
			f.db,
			connection,
			{ ...f.options, kind, now: Math.floor(date / 1000) },
			f.deps
		);
	await pruneRecovery(
		connection,
		{
			...connection,
			enabled: true,
			archiveEnabled: true,
			backupsEnabled: true,
			localRetentionDays: 30,
			databaseIntervalHours: 1,
			fileBackupHour: 2,
			hourlyRetention: 1,
			dailyRetention: 2,
			monthlyRetention: 2
		},
		now,
		f.deps
	);
	const kept = new Set((await listRecovery(connection, f.deps)).map((snapshot) => snapshot.id));
	assert.ok(kept.has(snapshots.dailyFull.id));
	assert.ok(kept.has(snapshots.monthlyFull.id));
	assert.ok(kept.has(snapshots.latestFull.id));
	assert.ok(kept.has(snapshots.latestDatabase.id));
	assert.ok(!kept.has(snapshots.expiredFull.id));
	assert.ok(!kept.has(snapshots.olderMonthlyFull.id));
});

test('bounded bundles split large files, preserve empty files and reuse unchanged payload after database changes', async (t) => {
	const f = await ordinary(t);
	const payload = Buffer.alloc(10000, 'compressible payload');
	await f.write('uploads/large.bin', payload);
	await f.write('uploads/empty.bin', '');
	const options = { ...f.options, kind: 'full', bundleBytes: 4096 };
	const first = await backupRecovery(f.db, connection, options, f.deps);
	const manifest = await f.manifest(first);
	const entry = manifest.files.find((file) => file.path === 'uploads/large.bin');
	assert.ok(entry.parts.length >= 3);
	assert.deepEqual(manifest.files.find((file) => file.path === 'uploads/empty.bin').parts, []);
	assert.ok(manifest.bundles.every((bundle) => bundle.bytes <= 4096));
	assert.ok(
		manifest.bundles.reduce((sum, bundle) => sum + bundle.compressedBytes, 0) < first.bytes / 2
	);
	f.db.exec("CREATE TABLE changed(value TEXT); INSERT INTO changed VALUES ('new snapshot')");
	const second = await backupRecovery(
		f.db,
		connection,
		{ ...options, now: options.now + 1 },
		f.deps
	);
	assert.ok(second.reusedObjects >= 3);
	await fs.rm(path.join(f.remote, 'audio'), { recursive: true, force: true });
	const restore = f.restoreOptions(second);
	await restoreRecovery(restore, f.deps);
	assert.deepEqual(
		await fs.readFile(path.join(restore.outputDirectory, 'uploads', 'large.bin')),
		payload
	);
	assert.equal((await fs.stat(path.join(restore.outputDirectory, 'uploads', 'empty.bin'))).size, 0);
});

test('v1 independent encrypted objects remain restorable and coexist with v2 backups', async (t) => {
	const f = await ordinary(t);
	const result = await backupRecovery(f.db, connection, f.options, f.deps);
	const manifest = await f.manifest(result);
	const raw = [];
	for (const bundle of manifest.bundles) {
		const plain = path.join(f.root, `${randomUUID()}.gz`);
		await f.deps.decryptFile(path.join(f.remote, 'backups', 'objects', bundle.object), plain);
		raw.push(gunzipSync(await fs.readFile(plain)));
	}
	for (const entry of manifest.files) {
		const bytes = Buffer.concat(
			entry.parts.map((part) => raw[part.bundle].subarray(part.offset, part.offset + part.bytes))
		);
		const plain = path.join(f.root, `${randomUUID()}.legacy`);
		const encrypted = path.join(f.root, `${randomUUID()}.enc`);
		await fs.writeFile(plain, bytes);
		await f.deps.encryptFile(plain, encrypted);
		entry.remoteSha256 = digest(await fs.readFile(encrypted));
		entry.object = `${entry.remoteSha256}.enc`;
		delete entry.parts;
		await fs.copyFile(encrypted, path.join(f.remote, 'backups', 'objects', entry.object));
	}
	manifest.version = 1;
	delete manifest.bundles;
	delete manifest.format;
	const plain = path.join(f.root, 'legacy-manifest.json');
	await fs.writeFile(plain, JSON.stringify(manifest));
	const restore = f.restoreOptions(result);
	await f.deps.encryptFile(plain, restore.manifestFile);
	await restoreRecovery(restore, f.deps);
	assert.equal(
		await fs.readFile(path.join(restore.outputDirectory, 'uploads', 'audio', 'part.ogg'), 'utf8'),
		'audio payload'
	);
	await backupRecovery(f.db, connection, { ...f.options, now: f.options.now + 1 }, f.deps);
	assert.equal((await listRecovery(connection, f.deps)).length, 2);
});

test('authenticated bundle descriptors reject invalid coverage, traversal and resource bounds', async (t) => {
	const f = await ordinary(t);
	const result = await backupRecovery(f.db, connection, f.options, f.deps);
	const original = await f.manifest(result);
	const changes = [
		(m) => (m.bundles[0].bytes = BUNDLE_BYTES + 1),
		(m) => (m.bundles[0].compressedBytes = BUNDLE_BYTES + 1024 * 1024 + 1),
		(m) => (m.bundles[0].object = '../escape.enc'),
		(m) => (m.files[0].parts[0].offset = 1),
		(m) => (m.files[0].parts[0].bytes = -1),
		(m) => (m.files[0].parts[0].bundle = -1),
		(m) => (m.files[0].parts[0].bundle = m.bundles.length),
		(m) => (m.files[0].parts = []),
		(m) => m.bundles.push(structuredClone(m.bundles[0])),
		(m) => (m.files[0].bytes = 1024 ** 4 + 1),
		(m) => (m.files[1].path = 'uploads'),
		(m) => (m.files[2].path = m.files[1].path.toUpperCase())
	];
	for (const change of changes) {
		const manifest = structuredClone(original);
		change(manifest);
		const plain = path.join(f.root, 'changed-manifest.json');
		await fs.writeFile(plain, JSON.stringify(manifest));
		const restore = f.restoreOptions(result);
		await f.deps.encryptFile(plain, restore.manifestFile);
		await assert.rejects(restoreRecovery(restore, f.deps));
		await assert.rejects(fs.stat(restore.outputDirectory), { code: 'ENOENT' });
	}
});

test('authenticated compressed objects cannot exceed declared decompression bounds or hide raw corruption', async (t) => {
	const f = await ordinary(t);
	const result = await backupRecovery(f.db, connection, f.options, f.deps);
	const original = await f.manifest(result);
	for (const corrupt of [false, true]) {
		const manifest = structuredClone(original);
		const bundle = manifest.bundles[0];
		const plain = path.join(f.root, `replacement-${corrupt}.gz`);
		await fs.writeFile(plain, gzipSync(Buffer.alloc(bundle.bytes + (corrupt ? 0 : 1), 65)));
		bundle.compressedBytes = (await fs.stat(plain)).size;
		const encrypted = path.join(f.root, `replacement-${corrupt}.enc`);
		await f.deps.encryptFile(plain, encrypted);
		bundle.remoteSha256 = digest(await fs.readFile(encrypted));
		bundle.object = `${bundle.remoteSha256}.enc`;
		await fs.copyFile(encrypted, path.join(f.remote, 'backups', 'objects', bundle.object));
		const json = path.join(f.root, 'replacement-manifest.json');
		await fs.writeFile(json, JSON.stringify(manifest));
		const restore = f.restoreOptions(result);
		await f.deps.encryptFile(json, restore.manifestFile);
		await assert.rejects(restoreRecovery(restore, f.deps));
		await assert.rejects(fs.stat(restore.outputDirectory), { code: 'ENOENT' });
		assert.ok(!(await fs.readdir(f.root)).some((name) => name.startsWith('.recovery-work-')));
	}
});

test('failed bundle upload has no completed index and retry publishes a verified self-contained backup', async (t) => {
	const f = await ordinary(t);
	const put = f.client.put;
	let fail = true;
	let active = false;
	for (const method of ['put', 'get', 'mkdir', 'list', 'rename']) {
		const original = f.client[method];
		f.client[method] = async (...args) => {
			assert.equal(active, false, 'SFTP operations must be sequential');
			active = true;
			try {
				return await original(...args);
			} finally {
				active = false;
			}
		};
	}
	const sequentialPut = f.client.put;
	f.client.put = async (source, target) => {
		if (fail && target.includes('/objects/')) {
			fail = false;
			await put(source, target);
			throw new Error('interrupted');
		}
		return sequentialPut(source, target);
	};
	await assert.rejects(backupRecovery(f.db, connection, f.options, f.deps));
	assert.deepEqual(await listRecovery(connection, f.deps), []);
	const result = await backupRecovery(f.db, connection, f.options, f.deps);
	await restoreRecovery(f.restoreOptions(result), f.deps);
	assert.equal((await listRecovery(connection, f.deps)).length, 1);
});

test('bundle byte ranges never accept extraction paths from unauthoritative part fields', async (t) => {
	const f = await ordinary(t);
	const result = await backupRecovery(f.db, connection, f.options, f.deps);
	const manifest = await f.manifest(result);
	const outside = path.join(f.root, 'must-not-change');
	await fs.writeFile(outside, 'preserved');
	manifest.files[0].parts[0].target = outside;
	const plain = path.join(f.root, 'injected-part.json');
	await fs.writeFile(plain, JSON.stringify(manifest));
	const restore = f.restoreOptions(result);
	await f.deps.encryptFile(plain, restore.manifestFile);
	await restoreRecovery(restore, f.deps);
	assert.equal(await fs.readFile(outside, 'utf8'), 'preserved');
});

test('backup transport defaults to six hours while preserving an explicit shorter operation bound', async (t) => {
	const f = await ordinary(t);
	const configs = [];
	const deps = {
		...f.deps,
		withStorage: async (config, callback) => {
			configs.push(config);
			return callback(f.client);
		}
	};
	await backupRecovery(f.db, connection, f.options, deps);
	assert.ok(configs.every((config) => config.operationTimeoutMs === 21_600_000));
	const firstConnections = configs.length;
	await backupRecovery(
		f.db,
		{ ...connection, operationTimeoutMs: 30_000 },
		{ ...f.options, now: f.options.now + 1 },
		deps
	);
	assert.ok(
		configs.slice(firstConnections).every((config) => config.operationTimeoutMs === 30_000)
	);
});

test('backup uses saved upload inactivity for bundles, manifests and publication indexes', async (t) => {
	for (const stage of ['/objects/', '/manifests/', '/indexes/']) {
		await t.test(stage, async (t) => {
			const f = await ordinary(t);
			const put = f.client.put;
			const keepAlive = setInterval(() => {}, 1000);
			t.after(() => clearInterval(keepAlive));
			let stalled;
			f.client.put = (source, target) => {
				if (!target.includes(stage)) return put(source, target);
				stalled = source;
				return new Promise((resolve, reject) => source.once('error', reject));
			};
			await assert.rejects(
				backupRecovery(f.db, { ...connection, uploadTimeoutSeconds: 1 }, f.options, f.deps),
				{ message: 'Recovery backup failed.' }
			);
			assert.equal(stalled.destroyed, true);
			assert.deepEqual(await listRecovery(connection, f.deps), []);
			assert.ok(!(await fs.readdir(f.app)).some((name) => name.startsWith('.recovery-work-')));
		});
	}
});

test('backup propagates configured verification inactivity to new and reused remote objects', async (t) => {
	const f = await ordinary(t);
	const checked = [];
	const deps = {
		...f.deps,
		async hashRemote(client, target, settings) {
			assert.equal(settings.verificationTimeoutSeconds, 75);
			checked.push(target);
			return f.deps.hashRemote(client, target);
		}
	};
	const configured = { ...connection, uploadTimeoutSeconds: 60, verificationTimeoutSeconds: 75 };
	await backupRecovery(f.db, configured, f.options, deps);
	await backupRecovery(f.db, configured, { ...f.options, now: f.options.now + 1 }, deps);
	assert.ok(checked.some((target) => target.includes('/objects/')));
	assert.ok(checked.some((target) => target.includes('/manifests/')));
});

test('parallel bundle transfers use at most two separate pinned sessions and settle before cleanup/publication', async (t) => {
	for (const mode of [
		'success',
		'upload-failure',
		'verification-failure',
		'lost-lease',
		'transfer-timeout',
		'coordinator-timeout'
	]) {
		await t.test(mode, { timeout: 15000 }, async (t) => {
			const f = await ordinary(t);
			t.mock.timers.enable({ apis: ['setInterval'] });
			const progress = [];
			await f.write('uploads/parallel.bin', Buffer.alloc(12000, 65));
			let pairReady;
			const paired = new Promise((resolve) => {
				pairReady = resolve;
			});
			let releaseSibling;
			const sibling = new Promise((resolve) => {
				releaseSibling = resolve;
			});
			t.after(() => releaseSibling());
			let firstFailed;
			const failed = new Promise((resolve) => {
				firstFailed = resolve;
			});
			let sessions = 0;
			let workers = 0;
			let peakWorkers = 0;
			let started = 0;
			let peakEncrypted = 0;
			let owned = true;
			let returned = false;
			const busy = new Set();
			const ordinals = new WeakMap();
			async function exclusive(client, operation) {
				assert.equal(busy.has(client), false, 'a client must never have concurrent operations');
				busy.add(client);
				try {
					return await operation();
				} finally {
					busy.delete(client);
				}
			}
			const deps = {
				...f.deps,
				async hashRemote(client, target) {
					return exclusive(client, async () => {
						const hash = await f.deps.hashRemote(client, target);
						if (ordinals.get(client) === 1) {
							if (mode === 'verification-failure') return '0'.repeat(64);
							if (mode === 'lost-lease') owned = false;
						}
						return hash;
					});
				},
				async withStorage(config, callback) {
					assert.equal(config.fingerprint, connection.fingerprint);
					assert.equal(config.host, connection.host);
					assert.equal(config.operationTimeoutMs, 21_600_000);
					const sessionId = sessions++;
					const worker = sessionId > 0;
					if (worker) {
						workers++;
						peakWorkers = Math.max(peakWorkers, workers);
					}
					assert.ok(workers <= 2);
					const client = {};
					for (const method of Object.keys(f.client)) {
						client[method] = (...args) =>
							exclusive(client, async () => {
								if (method === 'put' && args[1].includes('/objects/')) {
									assert.equal(worker, true);
									const ordinal = ++started;
									ordinals.set(client, ordinal);
									const work = path.dirname(args[0].path);
									const spools = (await fs.readdir(work)).filter((name) =>
										name.endsWith('.bundle.enc')
									).length;
									peakEncrypted = Math.max(peakEncrypted, spools);
									assert.ok(spools <= 2, 'encrypted spool count must be bounded');
									if (ordinal === 1) {
										await paired;
										if (mode === 'upload-failure') throw new Error('interrupted upload');
										if (mode === 'transfer-timeout' || mode === 'coordinator-timeout')
											await sibling;
									}
									if (ordinal === 2) {
										t.mock.timers.tick(2_000);
										assert.equal(progress.at(-1).uploading, 2);
										pairReady();
										await sibling;
										await fs.access(args[0].path);
									}
								} else if (method === 'put' || method === 'rename') {
									assert.equal(workers, 0, 'publication must wait for verified session closure');
								}
								return f.client[method](...args);
							});
					}
					try {
						const running = callback(client);
						running.catch(() => {});
						if (
							(mode === 'transfer-timeout' && sessionId === 1) ||
							(mode === 'coordinator-timeout' && !worker)
						) {
							await paired;
							firstFailed();
							throw new Error('transport timed out before callback settlement');
						}
						return await running;
					} catch (error) {
						if (worker && ordinals.get(client) === 1) firstFailed();
						throw error;
					} finally {
						await new Promise((resolve) => setImmediate(resolve));
						if (worker) workers--;
					}
				}
			};
			const options = {
				...f.options,
				kind: 'full',
				bundleBytes: 1024,
				owned: () => owned,
				onProgress: (value) => progress.push(value)
			};
			const backup = backupRecovery(f.db, connection, options, deps).finally(() => {
				returned = true;
			});
			backup.catch(() => {});
			await paired;
			assert.equal(peakWorkers, 2);
			if (mode !== 'success') {
				await failed;
				await new Promise((resolve) => setImmediate(resolve));
				assert.equal(returned, false, 'failure must await the still-active sibling session');
				assert.ok((await fs.readdir(f.app)).some((name) => name.startsWith('.recovery-work-')));
			}
			releaseSibling();
			if (mode === 'success') {
				const result = await backup;
				await restoreRecovery(f.restoreOptions(result), f.deps);
			} else {
				await assert.rejects(backup, { message: 'Recovery backup failed.' });
				assert.deepEqual(await listRecovery(connection, f.deps), []);
				const retry = await backupRecovery(
					f.db,
					connection,
					{ ...f.options, now: f.options.now + 1 },
					f.deps
				);
				await restoreRecovery(f.restoreOptions(retry), f.deps);
			}
			assert.equal(progress.at(-1).uploading + progress.at(-1).verifying, 0);
			const reports = progress.length;
			t.mock.timers.tick(60_000);
			assert.equal(
				progress.length,
				reports,
				'progress reporting must stop after success or failure'
			);
			assert.equal(workers, 0);
			assert.equal(busy.size, 0);
			assert.equal(peakWorkers, 2);
			assert.equal(peakEncrypted, 2);
			assert.ok(!(await fs.readdir(f.app)).some((name) => name.startsWith('.recovery-work-')));
		});
	}
});
