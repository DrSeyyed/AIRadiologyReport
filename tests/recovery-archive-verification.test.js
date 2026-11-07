import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { verifyRecoveryArchives } from '../src/lib/server/recovery-archive-verification.js';

const rows = (count) =>
	Array.from({ length: count }, (_, id) => ({
		object_key: `${id}.enc`,
		remote_sha256: `digest-${id}`
	}));
const storagePath = (_connection, folder, key) => `/${folder}/${key}`;
const expected = (target) => `digest-${target.split('/').at(-1).split('.')[0]}`;

for (const mode of ['distinct', 'coordinator shared', 'worker shared']) {
	test(
		`archive verification reuses bounded sessions and serializes ${mode} clients`,
		{ timeout: 2000 },
		async () => {
			const coordinator = {};
			const shared = {};
			const activeClients = new Set();
			const seen = [];
			const reads = new Map();
			const connection = { readTimeoutSeconds: 7, operationTimeoutMs: 123456 };
			let active = 0;
			let peak = 0;
			let opened = 0;
			let closed = 0;
			let release;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			const concurrency = mode === 'distinct' ? 4 : mode === 'worker shared' ? 2 : 1;
			const deps = {
				storagePath,
				async withStorage(settings, callback) {
					assert.equal(settings, connection);
					opened++;
					try {
						return await callback(
							mode === 'distinct' ? {} : mode === 'coordinator shared' ? coordinator : shared
						);
					} finally {
						closed++;
					}
				},
				async hashRemote(client, target, settings) {
					assert.equal(settings, connection);
					assert.equal(
						activeClients.has(client),
						false,
						'never overlap requests on a shared client'
					);
					activeClients.add(client);
					seen.push(target);
					reads.set(client, (reads.get(client) || 0) + 1);
					peak = Math.max(peak, ++active);
					if (active === concurrency) release();
					try {
						await gate;
						await nextTurn();
						return expected(target);
					} finally {
						active--;
						activeClients.delete(client);
					}
				}
			};
			await verifyRecoveryArchives(deps, connection, coordinator, rows(12), async () => {});
			assert.equal(peak, concurrency);
			assert.equal(opened, 3, 'sessions are opened per worker, not per file');
			assert.equal(closed, opened);
			assert.equal(active, 0);
			assert.equal(new Set(seen).size, 12);
			assert.equal(seen.length, 12);
			for (const count of reads.values()) assert.ok(count > 1, 'reuse each active session');
		}
	);
}

for (const count of [0, 1, 2, 3]) {
	test(`${count} archived files use only the sessions needed`, async () => {
		let opened = 0;
		let checked = 0;
		await verifyRecoveryArchives(
			{
				storagePath,
				async withStorage(_settings, callback) {
					opened++;
					return callback({});
				},
				async hashRemote(_client, target) {
					checked++;
					return expected(target);
				}
			},
			{},
			{},
			rows(count),
			async () => {}
		);
		assert.equal(opened, Math.max(0, count - 1));
		assert.equal(checked, count);
	});
}

for (const mode of ['checksum', 'timeout', 'lease loss']) {
	test(
		`${mode} stops new archive checks and drains active callbacks before returning`,
		{ timeout: 2000 },
		async () => {
			let release;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			let started;
			const ready = new Promise((resolve) => {
				started = resolve;
			});
			let active = 0;
			let checked = 0;
			let closed = 0;
			let opened = 0;
			let owned = true;
			let settled = false;
			const operation = verifyRecoveryArchives(
				{
					storagePath,
					async withStorage(_connection, callback) {
						const id = ++opened;
						const running = callback({});
						running.catch(() => {});
						try {
							if (mode === 'timeout' && id === 1) {
								await ready;
								throw new Error('transport deadline');
							}
							return await running;
						} finally {
							closed++;
						}
					},
					async hashRemote(_client, target) {
						active++;
						if (++checked === 4) started();
						try {
							await ready;
							if (target === '/audio/0.enc' && mode !== 'timeout') {
								if (mode === 'checksum') return 'corrupt';
								owned = false;
								return expected(target);
							}
							await gate;
							return expected(target);
						} finally {
							active--;
						}
					}
				},
				{},
				{},
				rows(20),
				async () => {
					if (!owned) throw new Error('lease lost');
				}
			);
			const rejected = assert
				.rejects(
					operation,
					mode === 'checksum'
						? /archive changed/
						: mode === 'timeout'
							? /transport deadline/
							: /lease lost/
				)
				.then(() => {
					settled = true;
				});
			try {
				await ready;
				await nextTurn();
				assert.equal(settled, false, 'do not return while callbacks still read remote data');
				assert.equal(checked, 4, 'do not schedule remaining files after failure');
			} finally {
				release();
			}
			await rejected;
			assert.equal(active, 0);
			assert.equal(closed, 3);
		}
	);
}

test('verification checks ownership before requesting archive bytes', async () => {
	let checked = 0;
	await assert.rejects(
		verifyRecoveryArchives(
			{
				storagePath,
				withStorage: async (_connection, callback) => callback({}),
				hashRemote: async () => {
					checked++;
					return '';
				}
			},
			{},
			{},
			rows(10),
			async () => {
				throw new Error('cancelled');
			}
		),
		/cancelled/
	);
	assert.equal(checked, 0);
});

test('callbacks starting after a transport failure cannot start late archive reads', async () => {
	let checked = 0;
	const late = [];
	await assert.rejects(
		verifyRecoveryArchives(
			{
				storagePath,
				async withStorage(_connection, callback) {
					late.push(() => callback({}).catch(() => {}));
					throw new Error('connect deadline');
				},
				async hashRemote(_client, target) {
					checked++;
					return expected(target);
				}
			},
			{},
			{},
			rows(10),
			async () => {}
		),
		/connect deadline/
	);
	const before = checked;
	await Promise.all(late.map((callback) => callback()));
	assert.equal(checked, before);
});
