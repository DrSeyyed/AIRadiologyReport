import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import Database from 'better-sqlite3';
import { encryptFile } from '../src/lib/server/storage-crypto.js';
import { resetStorageData } from '../src/lib/server/storage-reset.js';
import { storageDestination } from '../src/lib/server/storage-settings.js';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

async function fixture(t, limit = 3) {
	const previousKey = process.env.STORAGE_ENCRYPTION_KEY;
	process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
	const directory = mkdtempSync(join(process.cwd(), '.storage-reset-test-'));
	const db = new Database(':memory:');
	db.exec(`
		CREATE TABLE storage_audio(path TEXT PRIMARY KEY, destination TEXT, object_key TEXT,
			sha256 TEXT, remote_sha256 TEXT, bytes INTEGER);
		CREATE TABLE storage_reset_requests(job_id INTEGER PRIMARY KEY, phase TEXT,
			total INTEGER DEFAULT 0, restored INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0);
		CREATE TABLE storage_jobs(id INTEGER PRIMARY KEY);
		INSERT INTO storage_reset_requests(job_id,phase) VALUES(1,'recovering');
		INSERT INTO storage_jobs VALUES(1);
	`);
	t.after(() => {
		db.close();
		rmSync(directory, { recursive: true, force: true });
		if (previousKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
		else process.env.STORAGE_ENCRYPTION_KEY = previousKey;
	});
	const connection = {
		host: 'storage.invalid',
		port: 22,
		username: 'synthetic',
		root: '/radiology',
		fingerprint: `SHA256:${'a'.repeat(43)}`,
		parallelConnections: limit
	};
	const objects = new Map();
	const unsafe = new Set();
	const folders = new Set(['/radiology/audio']);
	const originals = [];
	for (let i = 0; i < 3; i++) {
		const path = join(directory, `audio-${i}.ogg`);
		const content = Buffer.from(`synthetic audio ${i}`);
		writeFileSync(path, content);
		const encrypted = join(directory, 'encrypted');
		await encryptFile(path, encrypted);
		const data = readFileSync(encrypted);
		const key = `${randomUUID()}.enc`;
		objects.set(`/radiology/audio/${key}`, data);
		db.prepare('INSERT INTO storage_audio VALUES(?,?,?,?,?,?)').run(
			path,
			storageDestination(connection),
			key,
			sha256(content),
			sha256(data),
			content.length
		);
		unlinkSync(path);
		unlinkSync(encrypted);
		originals.push({ path, content });
	}
	let active = 0;
	let maximumSessions = 0;
	let destroyed = 0;
	let hook;
	let inspectionHook;
	let owned = true;
	const deleted = [];
	const downloads = [];
	const transport = async (config, callback) => {
		maximumSessions = Math.max(maximumSessions, ++active);
		const client = {
			destroy() {
				destroyed++;
			},
			async lstat(path) {
				if (folders.has(path)) return { isDirectory: true, isSymbolicLink: false };
				if (objects.has(path))
					return { isFile: true, isSymbolicLink: unsafe.has(path), size: objects.get(path).length };
				throw Object.assign(new Error('missing'), { code: 2 });
			},
			async list(path) {
				await inspectionHook?.(path);
				return [
					...[...folders]
						.filter((value) => posix.dirname(value) === path)
						.map((value) => ({ name: posix.basename(value), type: 'd' })),
					...[...objects.keys()]
						.filter((value) => posix.dirname(value) === path)
						.map((value) => ({ name: posix.basename(value), type: '-' }))
				];
			},
			async get(remote, local) {
				downloads.push(local);
				await hook?.(remote, local);
				await writeFile(local, objects.get(remote));
			},
			async delete(path) {
				for (const original of originals)
					assert.deepEqual(readFileSync(original.path), original.content);
				assert.equal(
					db.prepare('SELECT phase FROM storage_reset_requests').get().phase,
					'cleaning'
				);
				assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 0);
				deleted.push(path);
				objects.delete(path);
			},
			async rmdir(path) {
				assert.equal((await client.list(path)).length, 0);
				folders.delete(path);
			}
		};
		try {
			return await Promise.race([
				callback(client),
				new Promise((_, reject) =>
					config.signal.addEventListener('abort', () => reject(new Error('aborted')), {
						once: true
					})
				)
			]);
		} finally {
			active--;
		}
	};
	return {
		db,
		connection,
		directory,
		objects,
		folders,
		originals,
		deleted,
		downloads,
		unsafe,
		get maximumSessions() {
			return maximumSessions;
		},
		get destroyed() {
			return destroyed;
		},
		get active() {
			return active;
		},
		set hook(value) {
			hook = value;
		},
		set inspectionHook(value) {
			inspectionHook = value;
		},
		set owned(value) {
			owned = value;
		},
		run: () =>
			resetStorageData(db, connection, {
				jobId: 1,
				roots: [directory],
				transport,
				owned: () => owned
			})
	};
}

for (const limit of [1, 3, 16]) {
	test(`reset restores originals with saved limit ${limit} including coordinator before ordered cleanup`, async (t) => {
		const f = await fixture(t, limit);
		let downloading = 0;
		let maximumDownloads = 0;
		const downloadsEntered = Promise.withResolvers();
		f.hook = async () => {
			maximumDownloads = Math.max(maximumDownloads, ++downloading);
			if (downloading === Math.min(limit, 3)) downloadsEntered.resolve();
			await downloadsEntered.promise;
			downloading--;
		};
		for (const folder of [
			'backups',
			'backups/indexes',
			'backups/manifests',
			'backups/objects',
			'files',
			'files/objects'
		])
			f.folders.add(`/radiology/${folder}`);
		let inspecting = 0;
		let maximumInspection = 0;
		const inspectionsEntered = Promise.withResolvers();
		f.inspectionHook = async (path) => {
			if (['/radiology/backups', '/radiology/files'].includes(path)) return;
			maximumInspection = Math.max(maximumInspection, ++inspecting);
			if (inspecting === Math.min(limit, 5)) inspectionsEntered.resolve();
			await inspectionsEntered.promise;
			inspecting--;
		};
		const id = `1800000000-${randomUUID()}`;
		const ordered = [
			`/radiology/backups/indexes/${id}.full.json`,
			`/radiology/backups/manifests/${id}.enc`,
			`/radiology/backups/objects/${'b'.repeat(64)}.enc`,
			`/radiology/files/objects/${'c'.repeat(64)}.enc`
		];
		for (const path of ordered) f.objects.set(path, Buffer.from('synthetic metadata'));
		assert.deepEqual(await f.run(), { reset: true, restored: 3, total: 3, deleted: 7 });
		assert.equal(maximumDownloads, Math.min(limit, 3));
		assert.equal(maximumInspection, Math.min(limit, 5));
		assert.equal(f.maximumSessions, Math.min(limit, 5));
		assert.equal(f.active, 0);
		assert.deepEqual(f.deleted.slice(0, 4), ordered);
		assert.equal(f.objects.size, 0);
		assert.equal(f.folders.size, 0);
		assert.ok(readdirSync(f.directory).every((name) => !name.startsWith('.storage-reset-')));
	});
}

for (const mode of ['failure', 'cancellation']) {
	test(
		`reset ${mode} aborts every session, drains late downloads, and remains retryable without cleanup`,
		{ timeout: 5000 },
		async (t) => {
			const f = await fixture(t);
			const entered = Promise.withResolvers();
			const trigger = Promise.withResolvers();
			const release = Promise.withResolvers();
			let started = 0;
			f.hook = async () => {
				const index = started++;
				if (started === 3) entered.resolve();
				if (mode === 'failure' && index === 0) {
					await trigger.promise;
					throw new Error('sensitive remote path');
				}
				await release.promise;
			};
			const running = f.run();
			let settled = false;
			running.catch(() => {
				settled = true;
			});
			await entered.promise;
			if (mode === 'cancellation') f.owned = false;
			else trigger.resolve();
			if (mode === 'cancellation') await new Promise((resolve) => setTimeout(resolve, 300));
			else await new Promise((resolve) => setImmediate(resolve));
			assert.equal(f.destroyed, 3);
			assert.equal(settled, false, 'must wait for all callback downloads before returning');
			assert.deepEqual(f.deleted, []);
			assert.equal(
				f.db.prepare('SELECT phase FROM storage_reset_requests').get().phase,
				'recovering'
			);
			assert.equal(f.db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 3);
			assert.ok(f.downloads.slice(1).every((path) => existsSync(join(path, '..'))));
			release.resolve();
			await assert.rejects(running, (error) => !error.message.includes('sensitive remote path'));
			assert.equal(f.active, 0);
			assert.deepEqual(f.deleted, []);
			assert.ok(f.originals.every(({ path }) => !existsSync(path)));
			assert.ok(readdirSync(f.directory).every((name) => !name.startsWith('.storage-reset-')));
			f.hook = undefined;
			f.owned = true;
			assert.equal((await f.run()).reset, true);
		}
	);
}

test('parallel reset refuses corrupt or symbolic-link objects before destructive cleanup', async (t) => {
	for (const mode of ['corrupt', 'changed original', 'remote symlink']) {
		const f = await fixture(t);
		if (mode === 'corrupt') {
			const remote = [...f.objects.keys()][2];
			f.objects.set(remote, Buffer.alloc(f.objects.get(remote).length));
		} else if (mode === 'remote symlink') f.unsafe.add([...f.objects.keys()][2]);
		else writeFileSync(f.originals[2].path, 'must not overwrite');
		await assert.rejects(f.run());
		assert.deepEqual(f.deleted, []);
		assert.equal(f.objects.size, 3);
		assert.equal(f.db.prepare('SELECT COUNT(*) n FROM storage_audio').get().n, 3);
		assert.equal(
			f.db.prepare('SELECT phase FROM storage_reset_requests').get().phase,
			'recovering'
		);
		if (mode === 'changed original')
			assert.equal(readFileSync(f.originals[2].path, 'utf8'), 'must not overwrite');
	}
});
