import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
	backupRecovery,
	listRecovery,
	restoreRecovery,
	recoveryDestination,
	validateRecoveryManifest
} from '../src/lib/server/recovery-backups.js';
import { safeRecoveryProgress } from '../src/lib/server/recovery-progress.js';

const connection = {
	host: 'storage.invalid',
	port: 22,
	username: 'backup',
	root: '/vault',
	fingerprint: 'pinned',
	integrityAuditDays: 7
};
const digest = (data) => createHash('sha256').update(data).digest('hex');
const failed = /Recovery backup failed\./;

async function fixture(t, settings = connection) {
	const root = path.join(process.cwd(), 'tests', `.recovery-files-${randomUUID()}`);
	const app = path.join(root, 'app');
	const remote = path.join(root, 'remote');
	await fs.mkdir(path.join(app, 'uploads', 'audio'), { recursive: true });
	await fs.mkdir(remote);
	const db = new Database(path.join(app, 'source.sqlite'));
	db.pragma('journal_mode = WAL');
	db.exec(`CREATE TABLE study_recordings(id INTEGER PRIMARY KEY, audio_report_path TEXT, text_report_path TEXT);
		CREATE TABLE recording_audio_parts(id INTEGER PRIMARY KEY, audio_report_path TEXT);
		CREATE TABLE storage_audio(path TEXT PRIMARY KEY, object_key TEXT, sha256 TEXT, remote_sha256 TEXT, bytes INTEGER, archived_at INTEGER, evicted_at INTEGER, destination TEXT);`);
	t.after(async () => {
		if (db.open) db.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	const key = randomBytes(32);
	const calls = {
		puts: [],
		hashes: [],
		links: [],
		statBatches: [],
		lstats: [],
		gets: 0,
		reads: 0,
		remoteHashes: 0,
		encryptions: 0
	};
	const hooks = {};
	const local = (target) => {
		assert.ok(target.startsWith('/vault/') && !target.split('/').includes('..'));
		return path.join(remote, ...target.slice('/vault/'.length).split('/'));
	};
	const client = {
		async mkdir(target) {
			await fs.mkdir(local(target), { recursive: true });
		},
		async lstat(target) {
			calls.lstats.push(target);
			return (await hooks.lstat?.(target)) || fs.lstat(local(target));
		},
		async put(source, target) {
			calls.puts.push(target);
			await hooks.beforePut?.(target);
			await pipeline(source, createWriteStream(local(target)));
			await hooks.afterPut?.(target);
		},
		async get() {
			calls.gets++;
			assert.fail('Backup must not download objects.');
		},
		createReadStream() {
			calls.reads++;
			assert.fail('Backup must not read objects back.');
		},
		async list(target) {
			return (await fs.readdir(local(target), { withFileTypes: true })).map((entry) => ({
				name: entry.name,
				type: entry.isFile() ? '-' : entry.isDirectory() ? 'd' : 'l'
			}));
		},
		async rename(source, target) {
			await hooks.beforeRename?.(source, target);
			await fs.rename(local(source), local(target));
		}
	};
	const deps = {
		async withStorage(_settings, callback) {
			return callback(client);
		},
		storagePath: (_settings, ...parts) => '/vault/' + parts.join('/'),
		assertStorageKey() {},
		async hashRemote() {
			calls.remoteHashes++;
			assert.fail('Full writer must use storage-side SHA256, not remote readback.');
		},
		async hashStorageFile(_client, target, _settings, { assertActive }) {
			assertActive();
			calls.hashes.push(target);
			await hooks.hash?.(target);
			return digest(await fs.readFile(local(target)));
		},
		async statStorageFiles(_client, targets, _settings, { assertActive }) {
			assertActive();
			calls.statBatches.push([...targets]);
			await hooks.statBatch?.(targets);
			const result = [];
			for (const target of targets) {
				try {
					const info = (await hooks.lstat?.(target)) || (await fs.lstat(local(target)));
					if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe storage object.');
					result.push({ size: info.size });
				} catch (error) {
					if (error.code !== 'ENOENT') throw error;
					result.push(null);
				}
			}
			assertActive();
			return result;
		},
		async linkStorageFile(_client, source, target, _settings, { assertActive }) {
			assertActive();
			calls.links.push([source, target]);
			await hooks.link?.(source, target);
			await fs.link(local(source), local(target));
		},
		async encryptFile(source, target) {
			calls.encryptions++;
			const iv = randomBytes(12);
			const cipher = createCipheriv('aes-256-gcm', key, iv);
			const bytes = Buffer.concat([cipher.update(await fs.readFile(source)), cipher.final()]);
			await fs.writeFile(target, Buffer.concat([iv, cipher.getAuthTag(), bytes]), { mode: 0o600 });
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
	const options = { cwd: app, env: {}, now: 1800000000, kind: 'full', owned: () => true };
	const run = (extra = {}) => backupRecovery(db, settings, { ...options, ...extra }, deps);
	const write = async (relative, data) => {
		const target = path.join(app, ...relative.split('/'));
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, data);
		return target;
	};
	const manifest = async (result) => {
		const plain = path.join(root, `manifest-${randomUUID()}.json`);
		await deps.decryptFile(path.join(remote, 'backups', 'manifests', `${result.id}.enc`), plain);
		return JSON.parse(await fs.readFile(plain, 'utf8'));
	};
	const unpublished = async () => {
		assert.deepEqual(await listRecovery(connection, deps), []);
		assert.deepEqual(
			(await fs.readdir(app)).filter(
				(name) => name.startsWith('.recovery-work-') || name.startsWith('.storage-sync-work-')
			),
			[]
		);
	};
	const restore = async (result) => {
		const outputDirectory = path.join(root, `restored-${randomUUID()}`);
		await restoreRecovery(
			{
				manifestFile: path.join(remote, 'backups', 'manifests', `${result.id}.enc`),
				objectsDirectory: path.join(remote, 'backups', 'objects'),
				outputDirectory
			},
			deps
		);
		return outputDirectory;
	};
	await write('uploads/audio/part.ogg', 'audio payload');
	await write('uploads/reports/report.md', 'report payload');
	db.prepare('INSERT INTO study_recordings VALUES(1,?,?)').run(
		'uploads/audio/part.ogg',
		'uploads/reports/report.md'
	);
	return {
		root,
		app,
		remote,
		db,
		client,
		deps,
		calls,
		hooks,
		local,
		options,
		run,
		write,
		manifest,
		restore,
		unpublished
	};
}

test('default full writer publishes independent v1 objects and restores after file namespace removal', async (t) => {
	const f = await fixture(t);
	await f.write('uploads/misc/extra.bin', 'attachment');
	await f.write(
		'.env',
		'ORIGIN=https://example.invalid\nOPENAI_API_KEY=never-persist\nSTORAGE_ENCRYPTION_KEY=never-persist\n'
	);
	const progress = [];
	const result = await f.run({
		env: { PORT: '4321', OPENAI_API_KEY: 'never-persist' },
		onProgress: (state) => progress.push(state)
	});
	const manifest = await f.manifest(result);
	assert.equal(manifest.version, 1);
	assert.equal(manifest.format, 'immutable-files-v1');
	validateRecoveryManifest(manifest);
	assert.equal(result.files, 6);
	assert.equal(f.calls.gets + f.calls.reads, 0);
	assert.ok(f.calls.hashes.length > 0);
	assert.ok(f.calls.hashes.every((name) => !name.includes('/backups/objects/')));
	for (const entry of manifest.files) {
		const source = path.join(f.remote, 'files', 'objects', entry.object);
		const target = path.join(f.remote, 'backups', 'objects', entry.object);
		assert.equal(
			(await fs.stat(source, { bigint: true })).ino,
			(await fs.stat(target, { bigint: true })).ino
		);
		assert.ok(
			f.db
				.prepare(
					'SELECT * FROM storage_file_objects WHERE object_key=? AND backup_linked_at IS NOT NULL'
				)
				.get(entry.object)
		);
	}
	assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM storage_file_catalog').get().count, 3);
	await fs.rm(path.join(f.remote, 'files'), { recursive: true });
	const output = await f.restore(result);
	assert.equal(
		await fs.readFile(path.join(output, 'uploads', 'audio', 'part.ogg'), 'utf8'),
		'audio payload'
	);
	assert.equal(
		await fs.readFile(path.join(output, 'uploads', 'reports', 'report.md'), 'utf8'),
		'report payload'
	);
	assert.equal(
		await fs.readFile(path.join(output, 'uploads', 'misc', 'extra.bin'), 'utf8'),
		'attachment'
	);
	assert.doesNotMatch(
		await fs.readFile(path.join(output, '.env'), 'utf8'),
		/never-persist|OPENAI|STORAGE_ENCRYPTION/
	);
	assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'environment.json'), 'utf8')), {
		PORT: '4321',
		VOICE_SAVE_DIR: 'uploads/audio'
	});
	for (const state of progress) assert.ok(safeRecoveryProgress(state));
	assert.equal(progress.at(-1).files, result.files);
});

test('unchanged file and config versions are reused without upload, encryption, downloads or checksum readback', async (t) => {
	const f = await fixture(t);
	await f.write('.env', 'PORT=3000');
	const first = await f.run();
	const old = await f.manifest(first);
	const stable = old.files.filter((entry) => entry.role !== 'database');
	f.calls.puts.length = 0;
	f.calls.hashes.length = 0;
	f.calls.links.length = 0;
	const second = await f.run({ now: f.options.now + 1 });
	const next = await f.manifest(second);
	for (const entry of stable) {
		assert.equal(next.files.find((item) => item.path === entry.path).object, entry.object);
		assert.ok(!f.calls.puts.some((name) => name.endsWith(entry.object)));
		assert.ok(!f.calls.hashes.some((name) => name.endsWith(entry.object)));
		assert.ok(!f.calls.links.some(([, name]) => name.endsWith(entry.object)));
	}
	assert.equal(f.calls.gets + f.calls.reads, 0);
	assert.ok(second.reusedObjects >= stable.length);
});

test('unchanged backups batch metadata checks without per-object SFTP requests or repeat checksums', async (t) => {
	const f = await fixture(t);
	for (let index = 0; index < 70; index++)
		await f.write(`uploads/batched-${index}.txt`, `unique batched payload ${index}`);
	await f.run();
	const objects = f.db.prepare('SELECT object_key FROM storage_file_catalog').all();
	f.calls.statBatches.length = 0;
	f.calls.lstats.length = 0;
	f.calls.hashes.length = 0;
	f.calls.links.length = 0;
	await f.run({ now: f.options.now + 1 });
	assert.equal(f.calls.statBatches.length, Math.ceil(objects.length / 32));
	assert.ok(f.calls.statBatches.every((targets) => targets.length <= 64));
	const checked = f.calls.statBatches.flat();
	for (const { object_key } of objects) {
		assert.equal(checked.filter((target) => target.endsWith('/' + object_key)).length, 2);
		assert.ok(!f.calls.lstats.some((target) => target.endsWith('/' + object_key)));
		assert.ok(!f.calls.hashes.some((target) => target.endsWith('/' + object_key)));
		assert.ok(!f.calls.links.some(([, target]) => target.endsWith('/' + object_key)));
	}
});

for (const failure of [
	'missing-source',
	'wrong-source-size',
	'wrong-backup-size',
	'partial-output',
	'cancelled'
]) {
	test(`batched metadata ${failure} prevents recovery publication`, async (t) => {
		const f = await fixture(t);
		let owned = true;
		const read = f.deps.statStorageFiles;
		f.deps.statStorageFiles = async (...args) => {
			const result = await read(...args);
			if (failure === 'missing-source') result[0] = null;
			if (failure === 'wrong-source-size') result[0] = { size: result[0].size + 1 };
			if (failure === 'wrong-backup-size') result[1] = { size: result[0].size + 1 };
			if (failure === 'partial-output') result.pop();
			if (failure === 'cancelled') owned = false;
			return result;
		};
		await assert.rejects(f.run({ owned: () => owned }), failed);
		await f.unpublished();
	});
}

test('referenced and unreferenced evicted archive-only audio is hardlinked without decryption', async (t) => {
	const f = await fixture(t);
	await fs.rm(path.join(f.app, 'uploads', 'audio', 'part.ogg'));
	for (const [name, payload] of [
		['uploads/audio/part.ogg', 'audio payload'],
		['uploads/audio/old.ogg', 'unreferenced archived payload']
	]) {
		const plain = path.join(f.root, randomUUID());
		const encrypted = plain + '.enc';
		await fs.writeFile(plain, payload);
		await f.deps.encryptFile(plain, encrypted);
		await fs.mkdir(path.join(f.remote, 'audio'), { recursive: true });
		const object = `${randomUUID()}.enc`;
		await fs.copyFile(encrypted, path.join(f.remote, 'audio', object));
		f.db
			.prepare('INSERT INTO storage_audio VALUES(?,?,?,?,?,?,?,?)')
			.run(
				name,
				object,
				digest(payload),
				digest(await fs.readFile(encrypted)),
				Buffer.byteLength(payload),
				f.options.now - 100,
				f.options.now - 50,
				recoveryDestination(connection)
			);
	}
	const decrypt = f.deps.decryptFile;
	f.deps.decryptFile = async () => assert.fail('Backup must not decrypt archived audio.');
	const result = await f.run();
	f.deps.decryptFile = decrypt;
	assert.equal(result.archivedFiles, 2);
	assert.equal(f.calls.gets + f.calls.reads, 0);
	assert.equal(
		f.db.prepare('SELECT COUNT(*) AS count FROM storage_file_catalog WHERE state IS NULL').get()
			.count,
		2
	);
	await fs.rm(path.join(f.remote, 'audio'), { recursive: true });
	await fs.rm(path.join(f.remote, 'files'), { recursive: true });
	const output = await f.restore(result);
	assert.equal(
		await fs.readFile(path.join(output, 'uploads', 'audio', 'old.ogg'), 'utf8'),
		'unreferenced archived payload'
	);
});

for (const timing of ['after-snapshot', 'before-publication']) {
	test(`source mutation ${timing} cannot publish`, async (t) => {
		const f = await fixture(t);
		if (timing === 'after-snapshot') {
			const backup = f.db.backup.bind(f.db);
			f.db.backup = async (...args) => {
				const value = await backup(...args);
				await f.write('uploads/reports/report.md', 'changed after snapshot');
				return value;
			};
		} else
			f.hooks.afterPut = async (target) => {
				if (target.endsWith('.pending'))
					await f.write('uploads/reports/report.md', 'changed at publication');
			};
		await assert.rejects(f.run(), failed);
		await f.unpublished();
	});
}

for (const change of [
	'references',
	'reference-assignment',
	'archive',
	'queue',
	'catalog',
	'object',
	'new-file',
	'environment'
]) {
	test(`${change} fence rejects mutation during publication`, async (t) => {
		const f = await fixture(t);
		f.hooks.afterPut = async (target) => {
			if (!target.endsWith('.pending')) return;
			if (change === 'references')
				f.db.prepare('UPDATE study_recordings SET text_report_path=?').run('uploads/other.md');
			if (change === 'reference-assignment') f.db.prepare('UPDATE study_recordings SET id=2').run();
			if (change === 'archive')
				f.db
					.prepare('INSERT INTO storage_audio VALUES(?,?,?,?,?,?,?,?)')
					.run(
						'uploads/new.ogg',
						`${randomUUID()}.enc`,
						'a'.repeat(64),
						'b'.repeat(64),
						1,
						f.options.now,
						null,
						recoveryDestination(connection)
					);
			if (change === 'queue')
				f.db
					.prepare(
						'INSERT INTO storage_file_queue(path,revision,queued_at,deleted) VALUES(?,?,?,?)'
					)
					.run('uploads/reports/report.md', 99, f.options.now, 0);
			if (change === 'catalog')
				f.db
					.prepare('UPDATE storage_file_catalog SET object_key=? WHERE path=?')
					.run('a'.repeat(64) + '.enc', 'uploads/reports/report.md');
			if (change === 'object')
				f.db
					.prepare(
						'UPDATE storage_file_objects SET sha256=? WHERE object_key=(SELECT object_key FROM storage_file_catalog LIMIT 1)'
					)
					.run('c'.repeat(64));
			if (change === 'new-file') await f.write('uploads/new.txt', 'new file');
			if (change === 'environment') await f.write('.env', 'PORT=9999');
		};
		await assert.rejects(f.run(), failed);
		await f.unpublished();
	});
}

for (const missing of ['audio', 'report']) {
	test(`missing referenced ${missing} fails without publication`, async (t) => {
		const f = await fixture(t);
		await fs.rm(
			path.join(
				f.app,
				...(missing === 'audio'
					? ['uploads', 'audio', 'part.ogg']
					: ['uploads', 'reports', 'report.md'])
			)
		);
		await assert.rejects(f.run(), failed);
		await f.unpublished();
	});
}

test('lease cancellation during index upload cannot publish', async (t) => {
	const f = await fixture(t);
	let owned = true;
	f.hooks.afterPut = async (target) => {
		if (target.endsWith('.pending')) owned = false;
	};
	await assert.rejects(f.run({ owned: () => owned }), failed);
	await f.unpublished();
});

test('observer failures cannot publish and leave no local work files', async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		f.run({
			onProgress: () => {
				throw new Error('private-observer-detail');
			}
		}),
		failed
	);
	await f.unpublished();
});

for (const failure of ['ssh', 'link', 'hash']) {
	test(`${failure} failure is sanitized and cannot publish`, async (t) => {
		const f = await fixture(t);
		if (failure === 'ssh') delete f.deps.hashStorageFile;
		if (failure === 'link')
			f.hooks.link = async () => {
				throw new Error('private-storage-detail');
			};
		if (failure === 'hash') f.deps.hashStorageFile = async () => 'a'.repeat(64);
		await assert.rejects(f.run(), failed);
		await f.unpublished();
	});
}

test('unknown existing backup link must match its encrypted checksum', async (t) => {
	const f = await fixture(t);
	const first = await f.run();
	const manifest = await f.manifest(first);
	const object = manifest.files.find((entry) => entry.path === 'uploads/audio/part.ogg').object;
	f.db
		.prepare('UPDATE storage_file_objects SET backup_linked_at=NULL WHERE object_key=?')
		.run(object);
	const target = path.join(f.remote, 'backups', 'objects', object);
	await fs.unlink(target);
	await fs.writeFile(
		target,
		Buffer.alloc((await fs.stat(path.join(f.remote, 'files', 'objects', object))).size)
	);
	await assert.rejects(f.run({ now: f.options.now + 1 }), failed);
	assert.equal((await listRecovery(connection, f.deps)).length, 1);
});

for (const unsafe of ['directory', 'symlink']) {
	test(`cached backup ${unsafe} is rejected`, async (t) => {
		const f = await fixture(t);
		const first = await f.run();
		const manifest = await f.manifest(first);
		const object = manifest.files.find((entry) => entry.path === 'uploads/audio/part.ogg').object;
		const remotePath = '/vault/backups/objects/' + object;
		f.hooks.lstat = async (target) =>
			target === remotePath ? { type: unsafe === 'directory' ? 'd' : 'l', size: 10 } : undefined;
		await assert.rejects(f.run({ now: f.options.now + 1 }), failed);
		assert.equal((await listRecovery(connection, f.deps)).length, 1);
	});
}

test('custom voice root preserves canonical voice references on restore', async (t) => {
	const f = await fixture(t);
	const voice = path.join(f.root, 'custom-voice');
	await fs.mkdir(voice);
	await fs.writeFile(path.join(voice, 'external.ogg'), 'external audio');
	f.db
		.prepare('UPDATE study_recordings SET audio_report_path=?')
		.run(path.join(voice, 'external.ogg'));
	const result = await f.run({ voiceSaveDir: voice });
	const manifest = await f.manifest(result);
	assert.equal(manifest.voiceDirectory, 'voice');
	assert.ok(manifest.references.some((entry) => entry.path === 'voice/external.ogg'));
	const output = await f.restore(result);
	assert.equal(
		await fs.readFile(path.join(output, 'voice', 'external.ogg'), 'utf8'),
		'external audio'
	);
});

test('omitted kind defaults to full and snapshots SQLite before any remote work', async (t) => {
	const f = await fixture(t);
	const backup = f.db.backup.bind(f.db);
	let captured = false;
	f.db.backup = async (...args) => {
		assert.equal(
			f.calls.puts.length + f.calls.hashes.length + f.calls.links.length + f.calls.encryptions,
			0
		);
		captured = true;
		return backup(...args);
	};
	const result = await f.run({ kind: undefined });
	assert.equal(captured, true);
	assert.equal(result.kind, 'full');
});

test('new writer rejects legacy database jobs instead of publishing a partial full snapshot', async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.run({ kind: 'database' }), failed);
	await f.unpublished();
});

test('database and config versions participate in the shared weekly integrity audit', async (t) => {
	const f = await fixture(t);
	const first = await f.run();
	const manifest = await f.manifest(first);
	f.calls.hashes.length = 0;
	await f.run({ now: f.options.now + 7 * 86400 });
	for (const entry of manifest.files)
		assert.ok(f.calls.hashes.includes('/vault/files/objects/' + entry.object));
});

test('existing unregistered backup links are storage-checksummed before reuse', async (t) => {
	const f = await fixture(t);
	const first = await f.run();
	const manifest = await f.manifest(first);
	const object = manifest.files.find((entry) => entry.path === 'uploads/audio/part.ogg').object;
	f.db
		.prepare('UPDATE storage_file_objects SET backup_linked_at=NULL WHERE object_key=?')
		.run(object);
	f.calls.hashes.length = 0;
	await f.run({ now: f.options.now + 1 });
	assert.ok(f.calls.hashes.includes('/vault/backups/objects/' + object));
});

test('parallel linking failures drain every worker before deleting secure work directories', async (t) => {
	const f = await fixture(t);
	for (let i = 0; i < 6; i++) await f.write(`uploads/parallel-${i}.txt`, `unique ${i}`);
	f.deps.withStorage = async (_settings, callback) => callback(Object.create(f.client));
	let active = 0;
	let started = 0;
	f.hooks.link = async (_source, target) => {
		if (!target.includes('/backups/objects/')) return;
		const key = target.split('/').at(-1);
		if (!f.db.prepare('SELECT 1 FROM storage_file_catalog WHERE object_key=?').get(key)) return;
		const ordinal = ++started;
		active++;
		try {
			await new Promise((resolve) => setTimeout(resolve, ordinal === 1 ? 20 : 70));
			assert.ok((await fs.readdir(f.app)).some((entry) => entry.startsWith('.recovery-work-')));
			if (ordinal === 1) throw new Error('private-link-error');
		} finally {
			active--;
		}
	};
	await assert.rejects(f.run(), failed);
	assert.ok(started > 1);
	assert.equal(active, 0);
	await f.unpublished();
});

test('parallel paths sharing one immutable object create only one backup hardlink', async (t) => {
	const f = await fixture(t);
	await f.run();
	await f.write('uploads/copy-a.txt', 'audio payload');
	await f.write('uploads/copy-b.txt', 'audio payload');
	const audio = f.db
		.prepare('SELECT object_key FROM storage_file_catalog WHERE path=?')
		.get('uploads/audio/part.ogg').object_key;
	await fs.unlink(path.join(f.remote, 'backups', 'objects', audio));
	f.calls.links.length = 0;
	f.deps.withStorage = async (_settings, callback) => callback(Object.create(f.client));
	await f.run({ now: f.options.now + 1 });
	assert.equal(
		f.calls.links.filter(([, target]) => target === '/vault/backups/objects/' + audio).length,
		1
	);
});

test('a coordinator transport rejecting early drains its callback before cleanup and cannot publish late', async (t) => {
	const f = await fixture(t);
	let encrypting = false;
	let rejected = false;
	const encrypt = f.deps.encryptFile;
	f.deps.encryptFile = async (source, target) => {
		if (source.endsWith('database.sqlite')) {
			encrypting = true;
			await new Promise((resolve) => setTimeout(resolve, 80));
			assert.ok((await fs.readdir(f.app)).some((entry) => entry.startsWith('.recovery-work-')));
			encrypting = false;
		}
		return encrypt(source, target);
	};
	f.deps.withStorage = async (_settings, callback) => {
		const ready =
			f.db.prepare('SELECT COUNT(*) AS count FROM storage_file_objects').get().count > 0 &&
			!f.db.prepare('SELECT 1 FROM storage_file_queue LIMIT 1').get();
		const pending = callback(f.client);
		if (ready && !rejected) {
			rejected = true;
			pending.catch(() => {});
			await new Promise((resolve) => setTimeout(resolve, 25));
			throw new Error('private-early-transport-failure');
		}
		return pending;
	};
	await assert.rejects(f.run(), failed);
	assert.equal(rejected, true);
	assert.equal(encrypting, false);
	await f.unpublished();
});

for (const concurrency of [1, 2, 4]) {
	test(
		`immutable metadata preparation and v1 restore use ${concurrency} bounded local slots`,
		{ timeout: 10000 },
		async (t) => {
			const f = await fixture(t, { ...connection, parallelConnections: concurrency });
			await f.write('.env', 'PORT=4321\n');
			let encryptRelease;
			const encryptGate = new Promise((resolve) => {
				encryptRelease = resolve;
			});
			let encryptActive = 0;
			let encryptPeak = 0;
			let encryptArrivals = 0;
			const encrypt = f.deps.encryptFile;
			f.deps.withStorage = async (_settings, callback) => callback(Object.create(f.client));
			f.deps.encryptFile = async (source, target) => {
				if (!['database.sqlite', 'environment.json', 'app.env'].includes(path.basename(source)))
					return encrypt(source, target);
				encryptPeak = Math.max(encryptPeak, ++encryptActive);
				if (++encryptArrivals === Math.min(concurrency, 3)) encryptRelease();
				try {
					await encryptGate;
					return await encrypt(source, target);
				} finally {
					encryptActive--;
				}
			};
			const backup = await f.run();
			assert.equal(encryptPeak, Math.min(concurrency, 3));
			assert.equal(encryptActive, 0);
			const manifest = await f.manifest(backup);
			let release;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			let active = 0;
			let peak = 0;
			let arrivals = 0;
			const decrypt = f.deps.decryptFile;
			const outputDirectory = path.join(f.root, 'bounded-restore');
			await restoreRecovery(
				{
					manifestFile: path.join(f.remote, 'backups', 'manifests', `${backup.id}.enc`),
					objectsDirectory: path.join(f.remote, 'backups', 'objects'),
					outputDirectory,
					parallelConnections: concurrency
				},
				{
					...f.deps,
					async decryptFile(source, target) {
						if (path.basename(path.dirname(source)) !== 'objects') return decrypt(source, target);
						peak = Math.max(peak, ++active);
						if (++arrivals === Math.min(concurrency, manifest.files.length)) release();
						try {
							await gate;
							return await decrypt(source, target);
						} finally {
							active--;
						}
					}
				}
			);
			assert.equal(peak, Math.min(concurrency, manifest.files.length));
			assert.equal(active, 0);
			assert.equal(
				await fs.readFile(path.join(outputDirectory, 'uploads', 'audio', 'part.ogg'), 'utf8'),
				'audio payload'
			);
		}
	);
}

for (const mode of ['failure', 'cancel']) {
	test(
		`v1 restore ${mode} drains all started decryptions before rejecting`,
		{ timeout: 10000 },
		async (t) => {
			const f = await fixture(t);
			const backup = await f.run();
			let release;
			const sibling = new Promise((resolve) => {
				release = resolve;
			});
			t.after(release);
			let ready;
			const started = new Promise((resolve) => {
				ready = resolve;
			});
			let failed;
			const failing = new Promise((resolve) => {
				failed = resolve;
			});
			let active = 0;
			let arrivals = 0;
			let owned = true;
			let settled = false;
			const decrypt = f.deps.decryptFile;
			const outputDirectory = path.join(f.root, 'failed-restore');
			const operation = restoreRecovery(
				{
					manifestFile: path.join(f.remote, 'backups', 'manifests', `${backup.id}.enc`),
					objectsDirectory: path.join(f.remote, 'backups', 'objects'),
					outputDirectory,
					parallelConnections: 2,
					owned: () => owned
				},
				{
					...f.deps,
					async decryptFile(source, target) {
						if (path.basename(path.dirname(source)) !== 'objects') return decrypt(source, target);
						const ordinal = ++arrivals;
						active++;
						if (ordinal === 2) ready();
						try {
							await started;
							if (ordinal === 1) {
								failed();
								if (mode === 'failure') throw new Error('private decrypt failure');
								owned = false;
							} else await sibling;
							return await decrypt(source, target);
						} finally {
							active--;
						}
					}
				}
			).finally(() => {
				settled = true;
			});
			const rejected = assert.rejects(operation, {
				message: 'Recovery restore failed. Output was not published.'
			});
			await failing;
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(settled, false);
			assert.ok((await fs.readdir(f.root)).some((name) => name.startsWith('.recovery-work-')));
			release();
			await rejected;
			assert.equal(active, 0);
			assert.equal(arrivals, 2);
			await assert.rejects(fs.stat(outputDirectory), { code: 'ENOENT' });
			assert.ok(!(await fs.readdir(f.root)).some((name) => name.startsWith('.recovery-work-')));
		}
	);
}

for (const concurrency of [1, 4, 8, 16]) {
	test(`full recovery respects ${concurrency} connections and its progress survives sanitization`, async (t) => {
		const f = await fixture(t, { ...connection, parallelConnections: concurrency });
		for (let i = 0; i < concurrency; i++)
			await f.write(`uploads/progress-${i}.txt`, `progress payload ${i}`);
		let sessions = 0;
		let peakSessions = 0;
		f.deps.withStorage = async (settings, callback) => {
			assert.equal(settings.parallelConnections, concurrency);
			peakSessions = Math.max(peakSessions, ++sessions);
			try {
				return await callback(Object.create(f.client));
			} finally {
				sessions--;
			}
		};
		t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: f.options.now * 1000 });
		const snapshots = [];
		let concurrentUploads = 0;
		let uploadArrivals = 0;
		let verificationArrivals = 0;
		let releaseUploads;
		let releaseVerifications;
		const uploadsReady = new Promise((resolve) => {
			releaseUploads = resolve;
		});
		const verificationsReady = new Promise((resolve) => {
			releaseVerifications = resolve;
		});
		f.hooks.beforePut = async (target) => {
			if (!target.includes('/files/objects/') || uploadArrivals >= concurrency) return;
			uploadArrivals++;
			concurrentUploads++;
			if (uploadArrivals === concurrency) {
				assert.equal(concurrentUploads, concurrency);
				t.mock.timers.tick(2000);
				releaseUploads();
			}
			await uploadsReady;
			concurrentUploads--;
		};
		f.hooks.hash = async (target) => {
			if (!target.includes('/files/objects/') || verificationArrivals >= concurrency) return;
			verificationArrivals++;
			if (verificationArrivals === concurrency) {
				t.mock.timers.tick(2000);
				releaseVerifications();
			}
			await verificationsReady;
		};
		const result = await f.run({ onProgress: (state) => snapshots.push(state) });
		assert.equal(uploadArrivals, concurrency);
		assert.equal(verificationArrivals, concurrency);
		assert.equal(peakSessions, concurrency);
		assert.equal(sessions, 0);
		assert.ok(snapshots.filter((state) => state.phase === 'collecting').length >= 2);
		for (const state of snapshots) assert.deepEqual(safeRecoveryProgress(state), state);
		const complete = snapshots.at(-1);
		assert.equal(complete.phase, 'cleanup');
		assert.equal(complete.files, result.files);
		assert.equal(complete.totalFiles, result.files);
		assert.equal(complete.uploading + complete.verifying, 0);
		assert.equal(complete.uploadedObjects + complete.reusedObjects, complete.bundles);
		assert.equal(f.calls.gets + f.calls.reads + f.calls.remoteHashes, 0);
		const restored = await f.restore(result);
		assert.equal(
			await fs.readFile(path.join(restored, 'uploads', 'progress-0.txt'), 'utf8'),
			'progress payload 0'
		);
	});
}
