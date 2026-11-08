import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { auditStorageData, safeStorageAuditProgress } from '../src/lib/server/storage-audit.js';
import { ensureStorageFileState } from '../src/lib/server/storage-file-state.js';
import { storageDestination } from '../src/lib/server/storage-settings.js';
import { hashStorageFile } from '../src/lib/server/storage-shell.js';

const connection = {
	host: 'storage.invalid',
	port: 22,
	username: 'backup',
	root: '/vault',
	fingerprint: 'test-fingerprint',
	parallelConnections: 3,
	verificationTimeoutSeconds: 1
};
const now = 1800000000;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const failed = { message: 'Storage integrity audit failed.' };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t, settings = connection) {
	const db = new Database(':memory:');
	t.after(() => db.close());
	ensureStorageFileState(db);
	db.exec(`CREATE TABLE storage_audio (
		path TEXT PRIMARY KEY, object_key TEXT, sha256 TEXT, remote_sha256 TEXT,
		bytes INTEGER, archived_at INTEGER, evicted_at INTEGER, destination TEXT)`);
	const destination = storageDestination(settings);
	const remote = new Map();
	const hashes = [];
	const stats = [];
	const progress = [];
	const clients = [];
	const hooks = {};
	let sessions = 0;
	let active = 0;
	let maximum = 0;
	let closed = 0;
	function addObject(key, { backup = false, verified = now - 1, data = `encrypted ${key}` } = {}) {
		const row = {
			destination,
			object_key: key,
			sha256: digest(`plain ${key}`),
			remote_sha256: digest(data),
			bytes: 1,
			encrypted_bytes: Buffer.byteLength(data),
			created_at: now - 10,
			verified_at: verified,
			backup_linked_at: backup ? now - 5 : null
		};
		db.prepare(
			'INSERT INTO storage_file_objects VALUES(@destination,@object_key,@sha256,@remote_sha256,@bytes,@encrypted_bytes,@created_at,@verified_at,@backup_linked_at)'
		).run(row);
		remote.set(`/vault/files/objects/${key}`, {
			size: row.encrypted_bytes,
			digest: row.remote_sha256,
			type: '-'
		});
		if (backup)
			remote.set(`/vault/backups/objects/${key}`, { ...remote.get(`/vault/files/objects/${key}`) });
		return row;
	}
	function addArchive(key, path = key) {
		const bytes = 10;
		const remoteSha = digest(key);
		db.prepare('INSERT INTO storage_audio VALUES(?,?,?,?,?,?,?,?)').run(
			path,
			key,
			digest('plain'),
			remoteSha,
			bytes,
			now - 10,
			now - 5,
			destination
		);
		remote.set(`/vault/audio/${key}`, { size: bytes + 35, digest: remoteSha, type: '-' });
	}
	const injected = {
		async withStorage(config, callback) {
			sessions++;
			const client = {
				destroyed: false,
				destroy() {
					this.destroyed = true;
				},
				async lstat(target) {
					stats.push(target);
					if (hooks.stat) {
						const info = await hooks.stat(target);
						if (info !== undefined) return info;
					}
					if (remote.has(target)) return { ...remote.get(target) };
					if (
						[
							'/vault/files',
							'/vault/files/objects',
							'/vault/backups',
							'/vault/backups/objects',
							'/vault/audio'
						].includes(target)
					)
						return { type: 'd' };
					throw new Error('Missing private file at secret-host');
				},
				get() {
					assert.fail('Audit cannot download.');
				},
				put() {
					assert.fail('Audit cannot upload.');
				},
				delete() {
					assert.fail('Audit cannot delete.');
				}
			};
			clients.push(client);
			try {
				return await callback(client);
			} finally {
				closed++;
			}
		},
		async hashStorageFile(client, target, config, options) {
			options.assertActive();
			hashes.push(target);
			active++;
			maximum = Math.max(maximum, active);
			try {
				if (hooks.hash) return await hooks.hash(client, target, config, options);
				await delay(2);
				return remote.get(target).digest;
			} finally {
				active--;
			}
		}
	};
	const run = (options = {}, overrides = {}) =>
		auditStorageData(
			db,
			settings,
			{
				now,
				onProgress: (value) => progress.push(value),
				...options
			},
			{ ...injected, ...overrides }
		);
	const verified = (key) =>
		db
			.prepare('SELECT verified_at FROM storage_file_objects WHERE destination=? AND object_key=?')
			.get(destination, key).verified_at;
	return {
		db,
		remote,
		hashes,
		stats,
		progress,
		clients,
		hooks,
		addObject,
		addArchive,
		run,
		verified,
		counts: () => ({ sessions, active, maximum, closed })
	};
}

function assertProgress(value) {
	assert.deepEqual(
		Object.keys(value).sort(),
		['checked', 'total', 'verifiedBytes', 'elapsedSeconds', 'lastActivityAt'].sort()
	);
	for (const number of Object.values(value)) assert.ok(Number.isSafeInteger(number) && number >= 0);
}

test('audits every recent tracked object without cadence or batch limits, only on this destination', async (t) => {
	const f = fixture(t);
	for (let index = 0; index < 105; index++) f.addObject(`${index}.enc`);
	f.db
		.prepare(
			'INSERT INTO storage_file_objects SELECT ?,object_key,sha256,remote_sha256,bytes,encrypted_bytes,created_at,verified_at,backup_linked_at FROM storage_file_objects LIMIT 1'
		)
		.run('other-destination');
	const result = await f.run();
	assert.equal(result.total, 105);
	assert.equal(result.checked, 105);
	assert.equal(f.hashes.length, 105);
	assert.equal(
		f.db.prepare('SELECT COUNT(*) AS n FROM storage_file_objects WHERE verified_at=?').get(now).n,
		105
	);
	assert.equal(f.progress.length, 2, 'short audits emit only initial and final progress');
	assert.equal(f.progress[0].checked, 0);
	assert.deepEqual(f.progress.at(-1), result);
	assertProgress(result);
	assert.equal(
		result.verifiedBytes,
		[...f.remote.values()].reduce((sum, info) => sum + info.size, 0)
	);
});

test('zero-object and uninitialized databases succeed without connecting or changing schema', async (t) => {
	const f = fixture(t);
	assert.equal((await f.run()).total, 0);
	assert.equal(f.counts().sessions, 0);
	const db = new Database(':memory:');
	t.after(() => db.close());
	const result = await auditStorageData(db, connection, { now });
	assert.equal(result.checked, 0);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n, 0);
});

test('includes backup copies and archived audio, deduplicating repeated archive paths', async (t) => {
	const f = fixture(t);
	f.addObject('file.enc', { backup: true });
	f.addArchive('legacy.enc', 'first-local-path');
	f.addArchive('legacy.enc', 'second-local-path');
	f.db
		.prepare('INSERT INTO storage_audio VALUES(?,?,?,?,?,?,?,?)')
		.run('foreign', 'foreign.enc', digest('plain'), digest('remote'), 10, now, null, 'elsewhere');
	const result = await f.run();
	assert.equal(result.total, 3);
	assert.equal(result.checked, 3);
	assert.deepEqual(
		f.hashes.sort(),
		[
			'/vault/files/objects/file.enc',
			'/vault/backups/objects/file.enc',
			'/vault/audio/legacy.enc'
		].sort()
	);
	assert.equal(f.verified('file.enc'), now);
});

for (const kind of ['corrupt', 'missing', 'symlink', 'directory', 'size', 'ancestor-symlink']) {
	test(`rejects ${kind} safely without falsely marking a partial object`, async (t) => {
		const f = fixture(t, { ...connection, parallelConnections: 1 });
		f.addObject('file.enc', { backup: true });
		const target = '/vault/backups/objects/file.enc';
		if (kind === 'corrupt') f.remote.get(target).digest = digest('corrupt');
		if (kind === 'missing') f.remote.delete(target);
		if (kind === 'symlink') f.remote.get(target).type = 'l';
		if (kind === 'directory') f.remote.get(target).type = 'd';
		if (kind === 'size') f.remote.get(target).size++;
		if (kind === 'ancestor-symlink')
			f.hooks.stat = (path) => (path === '/vault/backups' ? { type: 'l' } : undefined);
		await assert.rejects(f.run(), failed);
		assert.equal(f.verified('file.enc'), now - 1);
		if (kind !== 'corrupt')
			assert.ok(!f.hashes.includes(target), 'type/size must be checked before hashing');
		assert.equal(f.counts().closed, f.counts().sessions);
	});
}

test('rejects conflicting duplicate archive identities before remote work', async (t) => {
	const f = fixture(t);
	f.addArchive('legacy.enc', 'a');
	f.addArchive('legacy.enc', 'b');
	f.db.prepare('UPDATE storage_audio SET bytes=bytes+1 WHERE path=?').run('b');
	await assert.rejects(f.run(), failed);
	assert.equal(f.counts().sessions, 0);
});

test('bounds concurrent hashes and drains every parallel session', async (t) => {
	const f = fixture(t);
	for (let index = 0; index < 12; index++) f.addObject(`${index}.enc`);
	f.hooks.hash = async (_client, target) => {
		await delay(15);
		return f.remote.get(target).digest;
	};
	await f.run();
	assert.deepEqual(f.counts(), { sessions: 3, active: 0, maximum: 3, closed: 3 });
});

test('ownership loss promptly aborts silent hashes, drains workers and guards late completion', async (t) => {
	const f = fixture(t);
	for (let index = 0; index < 6; index++) f.addObject(`${index}.enc`);
	let owned = true;
	const finish = [];
	f.hooks.hash = (_client, target) =>
		new Promise((resolve) => finish.push(() => resolve(f.remote.get(target).digest)));
	const running = f.run({ owned: () => owned });
	while (finish.length < 3) await delay(2);
	owned = false;
	await assert.rejects(
		Promise.race([
			running,
			delay(1500).then(() => {
				throw new Error('Cancellation stalled');
			})
		]),
		failed
	);
	assert.ok(f.clients.every((client) => client.destroyed));
	assert.equal(f.counts().closed, 3);
	assert.equal(f.hashes.length, 3);
	for (const resolve of finish) resolve();
	await delay(5);
	assert.equal(f.counts().active, 0);
	assert.equal(
		f.db.prepare('SELECT COUNT(*) AS n FROM storage_file_objects WHERE verified_at=?').get(now).n,
		0
	);
});

test('AbortSignal cancels an active audit without waiting for the hash deadline', async (t) => {
	const f = fixture(t);
	f.addObject('a');
	const controller = new AbortController();
	f.hooks.hash = async (_client, target) => {
		controller.abort();
		return f.remote.get(target).digest;
	};
	await assert.rejects(f.run({ signal: controller.signal }), failed);
	assert.equal(f.verified('a'), now - 1);
});

test('checks ownership before verified_at update, including final progress callbacks', async (t) => {
	const f = fixture(t);
	f.addObject('a');
	let owned = true;
	await assert.rejects(
		f.run({
			owned: () => owned,
			onProgress: (value) => {
				if (value.checked) owned = false;
			}
		}),
		failed
	);
	assert.equal(f.verified('a'), now - 1);
});

test('identity changes during hashing roll back verification updates', async (t) => {
	const f = fixture(t);
	f.addObject('a');
	f.addObject('b', { backup: true });
	f.hooks.hash = async (_client, target) => {
		if (target.endsWith('/b'))
			f.db
				.prepare('UPDATE storage_file_objects SET backup_linked_at=NULL WHERE object_key=?')
				.run('b');
		return f.remote.get(target).digest;
	};
	await assert.rejects(f.run(), failed);
	assert.equal(f.verified('a'), now - 1);
	assert.equal(f.verified('b'), now - 1);
});

test('server-side hash keeps the existing total command deadline and sanitizes failures', async (t) => {
	const f = fixture(t);
	f.addObject('a');
	await assert.rejects(
		f.run(
			{},
			{
				withStorage: async (_config, callback) =>
					callback({
						lstat: async (target) => (target.endsWith('/a') ? f.remote.get(target) : { type: 'd' }),
						client: { exec() {}, destroy() {} }
					}),
				hashStorageFile
			}
		),
		failed
	);
	assert.equal(f.verified('a'), now - 1);
});

test('progress is throttled during long hashes, monotonic and exposes no object paths', async (t) => {
	const f = fixture(t);
	f.addObject('private-name');
	f.hooks.hash = async (_client, target, _config, options) => {
		for (let index = 0; index < 22; index++) {
			options.onProgress(100);
			await delay(100);
		}
		return f.remote.get(target).digest;
	};
	const result = await f.run();
	assert.equal(f.progress.length, 3);
	assert.equal(f.progress[1].checked, 0);
	assert.ok(result.elapsedSeconds >= 2);
	for (let index = 0; index < f.progress.length; index++) {
		const value = f.progress[index];
		assertProgress(value);
		assert.ok(!JSON.stringify(value).includes('private-name'));
		if (index)
			for (const key of ['checked', 'verifiedBytes', 'elapsedSeconds', 'lastActivityAt'])
				assert.ok(value[key] >= f.progress[index - 1][key]);
	}
});

test('observer failures are sanitized and cannot publish verification', async (t) => {
	const f = fixture(t);
	f.addObject('a');
	await assert.rejects(
		f.run({
			onProgress: () => {
				throw new Error('password=private-secret');
			}
		}),
		failed
	);
	assert.equal(f.verified('a'), now - 1);
});

test('rejects lost ownership and invalid parallel bounds before remote work', async (t) => {
	for (const owned of [() => false, null]) {
		const f = fixture(t);
		f.addObject('a');
		await assert.rejects(f.run({ owned }), failed);
		assert.equal(f.counts().sessions, 0);
	}
	const f = fixture(t, { ...connection, parallelConnections: 17 });
	await assert.rejects(f.run(), failed);
});

test('cancellation interrupts a silent lstat before hashing', async (t) => {
	const f = fixture(t);
	f.addObject('a');
	let resolveStat;
	f.hooks.stat = () =>
		new Promise((resolve) => {
			resolveStat = resolve;
		});
	const controller = new AbortController();
	const running = f.run({ signal: controller.signal });
	while (!resolveStat) await delay(2);
	controller.abort();
	await assert.rejects(running, failed);
	resolveStat({ type: 'd' });
	assert.equal(f.hashes.length, 0);
	assert.equal(f.counts().closed, 1);
});

test('a concurrent failure cancels and drains silent sibling workers', async (t) => {
	const f = fixture(t);
	for (const key of ['a', 'b', 'c']) f.addObject(key);
	const finish = [];
	f.hooks.hash = async (_client, target) => {
		if (target.endsWith('/a')) {
			while (finish.length < 2) await delay(2);
			throw new Error('private connection failure');
		}
		return new Promise((resolve) => finish.push(() => resolve(f.remote.get(target).digest)));
	};
	await assert.rejects(f.run(), failed);
	assert.equal(f.counts().closed, 3);
	assert.ok(f.clients.every((client) => client.destroyed));
	for (const resolve of finish) resolve();
	await delay(2);
	assert.equal(f.counts().active, 0);
	assert.equal(f.verified('a'), now - 1);
});

test('transport failure aborts an already-running callback and prevents late work', async (t) => {
	const f = fixture(t, { ...connection, parallelConnections: 1 });
	f.addObject('a');
	let release;
	f.hooks.hash = (_client, target) =>
		new Promise((resolve) => {
			release = () => resolve(f.remote.get(target).digest);
		});
	const original = f.run(
		{},
		{
			withStorage: async (_config, callback) => {
				const client = {
					lstat: async (target) => (target.endsWith('/a') ? f.remote.get(target) : { type: 'd' }),
					destroy() {}
				};
				void callback(client).catch(() => {});
				while (!release) await delay(2);
				throw new Error('private transport failure');
			}
		}
	);
	await assert.rejects(original, failed);
	release();
	await delay(2);
	assert.equal(f.verified('a'), now - 1);
	assert.equal(f.counts().active, 0);
});

test('sanitizes persisted progress by strict allowlist without coercion', () => {
	assert.deepEqual(
		safeStorageAuditProgress({
			checked: 4,
			total: 8,
			verifiedBytes: 12,
			elapsedSeconds: 1,
			lastActivityAt: now,
			path: 'secret',
			error: 'secret'
		}),
		{
			checked: 4,
			total: 8,
			verifiedBytes: 12,
			elapsedSeconds: 1,
			lastActivityAt: now
		}
	);
	for (const value of [
		undefined,
		null,
		'secret',
		[],
		{
			checked: -1,
			total: NaN,
			verifiedBytes: Infinity,
			elapsedSeconds: 1.5,
			lastActivityAt: '100'
		},
		{ checked: Number.MAX_SAFE_INTEGER + 1 }
	]) {
		assert.equal(safeStorageAuditProgress(value), null);
	}
});

test('rejects incomplete or malformed audit results instead of manufacturing success', () => {
	const valid = {
		checked: 0,
		total: 0,
		verifiedBytes: 0,
		elapsedSeconds: 0,
		lastActivityAt: 0
	};
	assert.deepEqual(safeStorageAuditProgress(valid), valid);
	assert.equal(safeStorageAuditProgress({ checked: 'not safe', secret: 'credential' }), null);
	assert.equal(safeStorageAuditProgress({ ...valid, checked: 1, total: 0 }), null);
	assert.equal(safeStorageAuditProgress(Object.create(valid)), null);
	for (const field of Object.keys(valid)) {
		const incomplete = { ...valid };
		delete incomplete[field];
		assert.equal(safeStorageAuditProgress(incomplete), null, `missing ${field}`);
		for (const malformed of [
			undefined,
			null,
			false,
			'0',
			-1,
			0.5,
			NaN,
			Infinity,
			Number.MAX_SAFE_INTEGER + 1
		]) {
			assert.equal(
				safeStorageAuditProgress({ ...valid, [field]: malformed }),
				null,
				`invalid ${field}`
			);
		}
	}
});
