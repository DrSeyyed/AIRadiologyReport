import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
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
			await fs.copyFile(source, local(p));
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
	assert.ok(second.reusedObjects >= 3);
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
	const result = await backupRecovery(f.db, connection, { ...f.options, kind: 'full' }, f.deps);
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
		manifest.files.find((entry) => entry.role === 'audio').object
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
	await fs.unlink(path.join(f.remote, 'backups', 'objects', manifest.files[0].object));
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
		// Database, audio, report: change audio after its own object upload, not during copying.
		if (destination.includes('/objects/')) {
			const plain = path.join(f.root, 'checking-upload');
			await f.deps.decryptFile(source, plain);
			if ((await fs.readFile(plain, 'utf8')) === 'audio payload') {
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
