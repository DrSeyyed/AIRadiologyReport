import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { storageFilePool } from '../src/lib/server/storage-file-pool.js';

for (const selected of [undefined, 1, 4, 8, 16]) {
	for (const count of [0, 2, 20]) {
		test(`file pool uses ${selected ?? 'default 4'} connections for ${count} items including its coordinator`, async () => {
			const connection = selected === undefined ? {} : { parallelConnections: selected };
			const expected = Math.min(selected ?? 4, count);
			let opened = 0;
			let closed = 0;
			let active = 0;
			let peak = 0;
			const processed = [];
			const coordinator = {};
			const clients = new Set();
			await storageFilePool(
				{
					async withStorage(settings, action) {
						assert.equal(settings, connection);
						opened++;
						try {
							return await action({});
						} finally {
							closed++;
						}
					}
				},
				connection,
				Array.from({ length: count }, (_, index) => index),
				async (client, item) => {
					clients.add(client);
					peak = Math.max(peak, ++active);
					await setImmediate();
					processed.push(item);
					active--;
				},
				() => {},
				coordinator
			);
			assert.equal(peak, expected);
			assert.equal(opened, Math.max(0, expected - 1));
			assert.equal(closed, opened);
			assert.equal(active, 0);
			assert.equal(clients.size, expected);
			assert.equal(clients.has(coordinator), count > 0);
			assert.deepEqual(
				processed.sort((a, b) => a - b),
				Array.from({ length: count }, (_, index) => index)
			);
		});
	}
}

test('file pool rejects invalid connection limits before opening sessions or doing work', async () => {
	for (const parallelConnections of [0, 17, -1, 1.5, '4', null, NaN, Infinity]) {
		await assert.rejects(
			storageFilePool(
				{
					withStorage() {
						assert.fail('Must not open a session');
					}
				},
				{ parallelConnections },
				[1],
				() => assert.fail('Must not process an item'),
				() => assert.fail('Must validate before checking ownership')
			),
			/1–16/
		);
	}
});

test('file pool still serializes transports that return the same client at the highest limit', async () => {
	const client = {};
	let active = 0;
	let processed = 0;
	await storageFilePool(
		{ withStorage: (_settings, action) => action(client) },
		{ parallelConnections: 16 },
		Array.from({ length: 20 }),
		async () => {
			assert.equal(active++, 0);
			await setImmediate();
			processed++;
			active--;
		},
		() => {},
		client
	);
	assert.equal(processed, 20);
	assert.equal(active, 0);
});

for (const cancellation of [false, true]) {
	test(`file pool drains all ${cancellation ? 'cancelled' : 'failed'} workers before rejecting`, async () => {
		let active = 0;
		let closed = 0;
		let stopped = false;
		const error = new Error(cancellation ? 'Cancelled' : 'Transfer failed');
		await assert.rejects(
			storageFilePool(
				{
					async withStorage(_settings, action) {
						try {
							return await action({});
						} finally {
							closed++;
						}
					}
				},
				{ parallelConnections: 16 },
				Array.from({ length: 40 }, (_, index) => index),
				async (_client, item) => {
					active++;
					try {
						await setImmediate();
						if (item === 0) {
							stopped = true;
							if (!cancellation) throw error;
						}
					} finally {
						active--;
					}
				},
				() => {
					if (cancellation && stopped) throw error;
				}
			),
			error
		);
		assert.equal(active, 0);
		assert.equal(closed, 16);
	});
}
