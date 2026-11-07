import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageRequest, assertStorageSession } from '../src/lib/server/storage-session.js';
import { uploadStorageFile } from '../src/lib/server/storage-upload.js';

const nextTurn = () => new Promise(setImmediate);

for (const afterEof of [false, true]) {
	test(`upload timeout rejects independently of SFTP promise ${afterEof ? 'after EOF' : 'before consumption'}`, async (t) => {
		const work = await mkdtemp(join(tmpdir(), 'storage-stall-'));
		t.after(() => rm(work, { recursive: true, force: true }));
		const local = join(work, 'audio.enc');
		await writeFile(local, 'encrypted test bytes');
		t.mock.timers.enable({ apis: ['setTimeout'] });
		let ready;
		const started = new Promise((resolve) => {
			ready = resolve;
		});
		let upload;
		let destroyed = 0;
		const client = {
			client: {
				destroy() {
					destroyed++;
				}
			},
			async put(stream) {
				upload = stream;
				stream.on('error', () => {});
				if (afterEof) for await (const chunk of stream) assert.ok(chunk.length);
				ready();
				return new Promise(() => {});
			}
		};
		let settled = false;
		const rejected = assert
			.rejects(
				uploadStorageFile(client, local, '/audio.enc', { uploadTimeoutSeconds: 30 }),
				/stalled for 30 seconds/
			)
			.then(() => {
				settled = true;
			});
		await started;
		t.mock.timers.tick(29_999);
		await nextTurn();
		assert.equal(settled, false);
		t.mock.timers.tick(1);
		await rejected;
		assert.equal(upload.destroyed, true);
		assert.equal(destroyed, 1);
		assert.throws(() => assertStorageSession(client), /stopped/);
	});
}

test('an upload promise rejecting after its deadline remains safely handled', async (t) => {
	const work = await mkdtemp(join(tmpdir(), 'storage-stall-'));
	t.after(() => rm(work, { recursive: true, force: true }));
	const local = join(work, 'audio.enc');
	await writeFile(local, 'encrypted test bytes');
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let rejectPut;
	const client = {
		put(stream) {
			stream.on('error', () => {});
			return new Promise((resolve, reject) => {
				rejectPut = reject;
			});
		}
	};
	const rejected = assert.rejects(
		uploadStorageFile(client, local, '/audio.enc', { uploadTimeoutSeconds: 1 }),
		/stalled/
	);
	await nextTurn();
	t.mock.timers.tick(1_000);
	await rejected;
	rejectPut(new Error('late SFTP failure'));
	await nextTurn();
});

test('metadata request timeout destroys the SSH socket and blocks later requests on that client', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let destroyed = 0;
	const client = {
		client: {
			destroy() {
				destroyed++;
			}
		}
	};
	const rejected = assert.rejects(
		storageRequest(client, () => new Promise(() => {})),
		/timed out/
	);
	await nextTurn();
	t.mock.timers.tick(20_000);
	await rejected;
	assert.equal(destroyed, 1);
	await assert.rejects(
		storageRequest(client, () => assert.fail('must not reuse stopped session')),
		/stopped/
	);
});

test('successful metadata requests clear their timer without disconnecting the session', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let destroyed = 0;
	const client = {
		client: {
			destroy() {
				destroyed++;
			}
		}
	};
	assert.equal(await storageRequest(client, async () => 42), 42);
	t.mock.timers.tick(60_000);
	assert.equal(destroyed, 0);
	assert.equal(await storageRequest(client, async () => 43), 43);
});
