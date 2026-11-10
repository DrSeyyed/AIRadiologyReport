import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { testStorageConnection } from '../src/lib/server/storage-worker.js';

function fixture(hooks = {}) {
	const objects = new Map();
	const paths = new Set();
	const locals = new Set();
	const state = { opened: 0, closed: 0, active: 0, peak: 0, mkdir: 0, puts: 0, deletes: 0, aborted: 0 };
	async function transport(settings, action) {
		state.opened++;
		state.peak = Math.max(state.peak, ++state.active);
		let stopped = false;
		const client = {
			client: { destroy() { stopped = true; state.aborted++; hooks.destroy?.(); } },
			async mkdir() { state.mkdir++; },
			async put(source, remote) {
				locals.add(source.path);
				const data = Buffer.concat(await Array.fromAsync(source));
				state.puts++;
				await hooks.put?.(state, source.path);
				await setImmediate();
				if (stopped) throw new Error('Synthetic closed connection');
				assert.equal(paths.has(remote), false);
				paths.add(remote);
				objects.set(remote, data);
			},
			async lstat(remote) {
				return objects.has(remote) ? { isFile: true } : { isDirectory: true };
			},
			createReadStream(remote) { return Readable.from([objects.get(remote)]); },
			async delete(remote) { state.deletes++; objects.delete(remote); }
		};
		try { return await action(client); }
		finally { state.active--; state.closed++; }
	}
	return { state, objects, paths, locals, transport };
}

for (const parallelConnections of [undefined, 1, 4, 16]) {
	test(`connection probe verifies every configured ${parallelConnections ?? 'default 4'} session concurrently`, async () => {
		const f = fixture();
		const connection = { root: '/synthetic', parallelConnections };
		assert.deepEqual(await testStorageConnection(connection, f.transport), { verified: true });
		const expected = parallelConnections ?? 4;
		assert.equal(f.state.peak, expected);
		assert.equal(f.state.opened, expected);
		assert.equal(f.state.closed, expected);
		assert.equal(f.state.puts, expected);
		assert.equal(f.state.deletes, expected);
		assert.equal(f.state.mkdir, 1);
		assert.equal(f.paths.size, expected);
		assert.equal(f.objects.size, 0);
		assert.equal(f.state.active, 0);
		for (const local of f.locals) assert.equal(existsSync(local), false);
	});
}

test('connection probe rejects invalid bounds and lost ownership without opening sessions', async () => {
	for (const parallelConnections of [0, 17, '4', null])
		await assert.rejects(testStorageConnection({ parallelConnections }, () => assert.fail('Unexpected session')), /1–16/);
	await assert.rejects(testStorageConnection({ root: '/synthetic' }, () => assert.fail('Unexpected session'),
		{ owned: () => false }), /Storage read\/write verification failed/);
});

for (const mode of ['failure', 'cancellation', 'ownership']) {
	test(`connection probe drains all sessions and removes its spool after ${mode}`, async () => {
		const controller = new AbortController();
		let release;
		let owned = true;
		const gate = new Promise((resolve) => { release = resolve; });
		const f = fixture({
			async put(state, local) {
				assert.equal(existsSync(local), true);
				if (state.puts === 4) {
					if (mode === 'failure') throw new Error('Sensitive remote endpoint must not leak');
					if (mode === 'cancellation') controller.abort();
					if (mode === 'ownership') owned = false;
				}
				await gate;
				assert.equal(existsSync(local), true);
			},
			destroy: () => release()
		});
		await assert.rejects(testStorageConnection({ root: '/synthetic', parallelConnections: 4 }, f.transport,
			{ signal: controller.signal, owned: () => owned }), /^Error: Storage read\/write verification failed\.$/);
		assert.equal(f.state.opened, 4);
		assert.equal(f.state.closed, 4);
		assert.equal(f.state.active, 0);
		assert.equal(f.state.aborted, 4);
		assert.equal(f.objects.size, 0);
		for (const local of f.locals) assert.equal(existsSync(local), false);
		await setImmediate();
		assert.equal(f.objects.size, 0);
	});
}
