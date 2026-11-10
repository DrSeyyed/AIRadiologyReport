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
	const injected = { withStorage: async (_connection, callback) => callback({ ...client }) };
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
	let settled = false;
	running.catch(() => {
		settled = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(settled, false, 'must drain the late preflight before returning');
	release();
	await assert.rejects(running);
	clearTimeout(keepAlive);
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

for (const limit of [1, 3, 16]) {
	test(`deletion uses saved limit ${limit}, drains full preflight and plan before independent removals`, async () => {
		const f = fixture();
		f.options.backupIds = [older, newest];
		let sessions = 0;
		let maximumSessions = 0;
		let inspecting = 0;
		let maximumInspection = 0;
		let deleting = 0;
		let maximumDeletion = 0;
		let persisted = false;
		const inspected = new Set();
		const indexesRemoved = new Set();
		const planEntered = Promise.withResolvers();
		const planReleased = Promise.withResolvers();
		const persist = f.options.onPlan;
		f.options.onPlan = async (plan) => {
			assert.equal(inspected.size, 4);
			assert.deepEqual(f.removed, []);
			planEntered.resolve();
			await planReleased.promise;
			persist(plan);
			persisted = true;
		};
		f.injected.withStorage = async (_config, callback) => {
			maximumSessions = Math.max(maximumSessions, ++sessions);
			try {
				return await callback({
					...f.client,
					async lstat(path) {
						if (!persisted && /\.(enc|json)$/.test(path)) {
							maximumInspection = Math.max(maximumInspection, ++inspecting);
							await new Promise((resolve) => setImmediate(resolve));
							inspecting--;
							inspected.add(path);
						}
						return f.client.lstat(path);
					},
					async delete(path) {
						assert.ok(persisted, 'durable onPlan must finish first');
						if (path === manifest(older)) assert.ok(indexesRemoved.has(index(older, 'database')));
						if (path === manifest(newest)) assert.ok(indexesRemoved.has(index(newest)));
						maximumDeletion = Math.max(maximumDeletion, ++deleting);
						await new Promise((resolve) => setImmediate(resolve));
						await f.client.delete(path);
						indexesRemoved.add(path);
						deleting--;
					}
				});
			} finally {
				sessions--;
			}
		};
		const running = deleteRecoveryPoints(
			{ ...connection, parallelConnections: limit },
			f.options,
			f.injected
		);
		await planEntered.promise;
		assert.deepEqual(f.removed, []);
		assert.equal(sessions, 1, 'preflight sessions close before durable plan');
		planReleased.resolve();
		assert.deepEqual(await running, { deleted: 2, total: 2, objectsRetained: true });
		assert.equal(maximumSessions, Math.min(limit, 4));
		assert.equal(maximumInspection, Math.min(limit, 4));
		assert.equal(maximumDeletion, Math.min(limit, 2));
		assert.equal(sessions, 0);
		assert.deepEqual(f.progress, [
			{ deleted: 0, total: 2 },
			{ deleted: 1, total: 2 },
			{ deleted: 2, total: 2 }
		]);
	});
}

test('parallel point failure aborts all active sessions and drains late index completion before exact-plan retry', async () => {
	const f = fixture();
	f.options.backupIds = [older, newest];
	const entered = Promise.withResolvers();
	const failure = Promise.withResolvers();
	const late = Promise.withResolvers();
	let started = 0;
	let destroyed = 0;
	let sessions = 0;
	let failing = true;
	f.injected.withStorage = async (_config, callback) => {
		sessions++;
		try {
			return await callback({
				...f.client,
				destroy() {
					destroyed++;
				},
				async delete(path) {
					if (failing && path.endsWith('.json')) {
						if (++started === 2) entered.resolve();
						if (path === index(older, 'database')) {
							await failure.promise;
							throw new Error('sensitive deletion error');
						}
						await late.promise;
					}
					return f.client.delete(path);
				}
			});
		} finally {
			sessions--;
		}
	};
	const running = deleteRecoveryPoints(
		{ ...connection, parallelConnections: 2 },
		f.options,
		f.injected
	);
	let settled = false;
	running.catch(() => {
		settled = true;
	});
	await entered.promise;
	failure.resolve();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(destroyed, 2);
	assert.equal(settled, false);
	late.resolve();
	await assert.rejects(running, (error) => !error.message.includes('sensitive'));
	assert.equal(sessions, 0);
	assert.deepEqual(f.removed, [index(newest)]);
	assert.ok(f.entries.has(manifest(newest)));
	assert.ok(f.entries.has(manifest(older)));
	failing = false;
	await deleteRecoveryPoints(
		{ ...connection, parallelConnections: 2 },
		{
			...f.options,
			plan: f.plan,
			onPlan() {
				assert.fail('retry must reuse exact persisted plan');
			}
		},
		f.injected
	);
	assert.equal(f.removed.length, 4);
	assert.equal(sessions, 0);
});

for (const mode of ['failure', 'cancellation']) {
	test(
		`parallel selection preflight ${mode} aborts and drains all sessions without plan or mutation`,
		{ timeout: 5000 },
		async () => {
			const f = fixture();
			f.options.backupIds = [older, newest];
			let active = true;
			f.options.owned = () => active;
			const entered = Promise.withResolvers();
			const trigger = Promise.withResolvers();
			const release = Promise.withResolvers();
			let started = 0;
			let destroyed = 0;
			let sessions = 0;
			f.injected.withStorage = async (config, callback) => {
				sessions++;
				try {
					return await Promise.race([
						callback({
							...f.client,
							destroy() {
								destroyed++;
							},
							async lstat(path) {
								if (/\.(enc|json)$/.test(path)) {
									const index = started++;
									if (started === 3) entered.resolve();
									if (mode === 'failure' && index === 0) {
										await trigger.promise;
										return { isSymbolicLink: true };
									}
									await release.promise;
								}
								return f.client.lstat(path);
							}
						}),
						new Promise((_, reject) =>
							config.signal.addEventListener('abort', () => reject(new Error('aborted')), {
								once: true
							})
						)
					]);
				} finally {
					sessions--;
				}
			};
			const running = deleteRecoveryPoints(
				{ ...connection, parallelConnections: 3 },
				f.options,
				f.injected
			);
			let settled = false;
			running.catch(() => {
				settled = true;
			});
			await entered.promise;
			if (mode === 'failure') trigger.resolve();
			else active = false;
			if (mode === 'cancellation') await new Promise((resolve) => setTimeout(resolve, 150));
			else await new Promise((resolve) => setImmediate(resolve));
			assert.equal(destroyed, 3);
			assert.equal(settled, false);
			assert.equal(f.plan, undefined);
			assert.deepEqual(f.removed, []);
			release.resolve();
			await assert.rejects(running, /Backup deletion stopped/);
			assert.equal(sessions, 0);
			assert.equal(started, 3, 'must not start the fourth item after stopping');
			assert.equal(f.plan, undefined);
			assert.deepEqual(f.removed, []);
		}
	);
}
