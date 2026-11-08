import test from 'node:test';
import assert from 'node:assert/strict';
import {
	deleteRecoveryPoints,
	validateBackupDeletionIds,
	safeBackupDeletionProgress
} from '../src/lib/server/storage-backup-deletion.js';

const older = '1800000000-11111111-1111-1111-1111-111111111111';
const newest = '1800000100-22222222-2222-2222-2222-222222222222';
const connection = { root: '/radiology' };
const index = (id, kind = 'full') => `/radiology/backups/indexes/${id}.${kind}.json`;
const manifest = (id) => `/radiology/backups/manifests/${id}.enc`;
function fixture() {
	const points = [
		{ id: older, kind: 'database' },
		{ id: newest, kind: 'full' }
	];
	const entries = new Map([
		...['backups', 'backups/indexes', 'backups/manifests'].map((path) => [
			`/radiology/${path}`,
			'd'
		]),
		...points.flatMap(({ id, kind }) => [
			[index(id, kind), '-'],
			[manifest(id), '-']
		]),
		['/radiology/backups/objects/shared.enc', '-'],
		['/radiology/files/objects/current.enc', '-'],
		['/radiology/audio/current.enc', '-']
	]);
	const removed = [];
	const progress = [];
	let plan;
	const client = {
		async lstat(path) {
			if (!entries.has(path)) throw Object.assign(new Error('missing'), { code: 2 });
			return {
				isDirectory: entries.get(path) === 'd',
				isFile: entries.get(path) === '-',
				isSymbolicLink: entries.get(path) === 'l'
			};
		},
		async list() {
			return points.map(({ id, kind }) => ({
				name: `${id}.${kind}.json`,
				type: entries.get(index(id, kind))
			}));
		},
		async delete(path) {
			assert.ok(plan, 'plan must be persisted before deletion');
			removed.push(path);
			entries.delete(path);
		}
	};
	const injected = { withStorage: async (_connection, callback) => callback(client) };
	const options = {
		backupIds: [newest],
		onPlan(value) {
			plan = structuredClone(value);
		},
		onProgress(value) {
			progress.push(value);
		}
	};
	return {
		entries,
		removed,
		client,
		injected,
		options,
		progress,
		get plan() {
			return plan;
		}
	};
}

test('explicit deletion can remove newest, retaining every shared object and other recovery point', async () => {
	const f = fixture();
	assert.deepEqual(await deleteRecoveryPoints(connection, f.options, f.injected), {
		deleted: 1,
		total: 1,
		objectsRetained: true
	});
	assert.deepEqual(f.removed, [index(newest), manifest(newest)]);
	assert.ok(f.entries.has(index(older, 'database')));
	assert.ok(f.entries.has(manifest(older)));
	assert.ok(f.entries.has('/radiology/backups/objects/shared.enc'));
	assert.ok(f.entries.has('/radiology/files/objects/current.enc'));
	assert.ok(f.entries.has('/radiology/audio/current.enc'));
	assert.deepEqual(f.progress, [
		{ deleted: 0, total: 1 },
		{ deleted: 1, total: 1 }
	]);
});

test('deletion validates whole selection before changing storage', async () => {
	for (const ids of [
		[],
		[newest, newest],
		['../escape'],
		[newest.replace('22222222', 'ABCDEFAB')],
		Array(101).fill(newest),
		[123]
	])
		assert.throws(() => validateBackupDeletionIds(ids));
	for (const unsafe of [
		index(newest),
		manifest(newest),
		'/radiology/backups/indexes',
		'/radiology/backups/manifests',
		'/radiology/backups'
	]) {
		const f = fixture();
		f.entries.set(unsafe, 'l');
		await assert.rejects(
			deleteRecoveryPoints(connection, f.options, f.injected),
			/Backup deletion stopped/
		);
		assert.deepEqual(f.removed, []);
		assert.equal(f.plan, undefined);
	}
	const f = fixture();
	f.entries.delete(manifest(newest));
	await assert.rejects(deleteRecoveryPoints(connection, f.options, f.injected));
	assert.deepEqual(f.removed, []);
});

test('unknown selections, ambiguous indexes and missing durable plan callback cannot remove metadata', async () => {
	for (const mode of ['unknown', 'ambiguous', 'no persistence', 'invalid persisted plan']) {
		const f = fixture();
		if (mode === 'unknown')
			f.options.backupIds = ['1800000200-33333333-3333-3333-3333-333333333333'];
		if (mode === 'ambiguous')
			f.client.list = async () => [
				{ name: `${newest}.full.json`, type: '-' },
				{ name: `${newest}.database.json`, type: '-' }
			];
		if (mode === 'no persistence') delete f.options.onPlan;
		if (mode === 'invalid persisted plan') f.options.plan = [{ id: newest, kind: '../escape' }];
		await assert.rejects(deleteRecoveryPoints(connection, f.options, f.injected));
		assert.deepEqual(f.removed, []);
	}
});

test('partial deletion retries from durable plan when completion index has already disappeared', async () => {
	const f = fixture();
	const remove = f.client.delete;
	f.client.delete = async (path) => {
		if (path === manifest(newest)) throw new Error('sensitive transport details');
		return remove(path);
	};
	await assert.rejects(
		deleteRecoveryPoints(connection, f.options, f.injected),
		(error) => !error.message.includes('sensitive')
	);
	assert.deepEqual(f.removed, [index(newest)]);
	assert.ok(f.entries.has(manifest(newest)));
	f.client.delete = remove;
	const options = {
		...f.options,
		plan: f.plan,
		onPlan() {
			assert.fail('must reuse plan');
		}
	};
	await deleteRecoveryPoints(connection, options, f.injected);
	assert.deepEqual(f.removed, [index(newest), manifest(newest)]);
	assert.deepEqual(await deleteRecoveryPoints(connection, options, f.injected), {
		deleted: 1,
		total: 1,
		objectsRetained: true
	});
});

test('lost ownership after plan persistence or index deletion prevents further destructive requests', async () => {
	for (const phase of ['planned', 'index removed']) {
		const f = fixture();
		let active = true;
		f.options.owned = () => active;
		if (phase === 'planned') {
			const persist = f.options.onPlan;
			f.options.onPlan = (plan) => {
				persist(plan);
				active = false;
			};
		} else {
			const remove = f.client.delete;
			f.client.delete = async (path) => {
				await remove(path);
				active = false;
			};
		}
		await assert.rejects(deleteRecoveryPoints(connection, f.options, f.injected));
		assert.deepEqual(f.removed, phase === 'planned' ? [] : [index(newest)]);
		assert.ok(f.entries.has(manifest(newest)));
	}
});

test('late metadata completion after cancellation cannot resume deletion', async () => {
	const f = fixture();
	let release;
	let started;
	const entered = new Promise((resolve) => {
		started = resolve;
	});
	const pending = new Promise((resolve) => {
		release = resolve;
	});
	const stat = f.client.lstat;
	let active = true;
	f.options.owned = () => active;
	f.client.lstat = async (path) => {
		if (path === manifest(newest)) {
			started();
			await pending;
		}
		return stat(path);
	};
	f.injected.withStorage = (config, callback) =>
		Promise.race([
			callback(f.client),
			new Promise((_, reject) =>
				config.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
			)
		]);
	const running = deleteRecoveryPoints(connection, f.options, f.injected);
	await entered;
	active = false;
	// Keep the event loop alive while the helper's unref'ed cancellation monitor fires.
	const keepAlive = setTimeout(() => {}, 1000);
	await assert.rejects(running);
	clearTimeout(keepAlive);
	release();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(f.removed, []);
});

test('deletion progress never serializes arbitrary remote data', () => {
	assert.deepEqual(safeBackupDeletionProgress({ deleted: 1, total: 2, secret: 'no' }), {
		deleted: 1,
		total: 2
	});
	for (const value of [
		null,
		{},
		{ deleted: -1, total: 2 },
		{ deleted: 2, total: 1 },
		{ deleted: 0, total: 101 },
		{ deleted: '1', total: 2 }
	])
		assert.equal(safeBackupDeletionProgress(value), null);
});
