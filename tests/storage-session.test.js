import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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

test('upload progress reports consumed bytes without dropping or duplicating stream content', async (t) => {
	const work = await mkdtemp(join(tmpdir(), 'storage-progress-'));
	t.after(() => rm(work, { recursive: true, force: true }));
	const local = join(work, 'audio.enc');
	const data = Buffer.alloc(300_000, 7);
	await writeFile(local, data);
	const progress = [];
	const client = {
		async put(stream) {
			assert.deepEqual(Buffer.concat(await Array.fromAsync(stream)), data);
		}
	};
	await uploadStorageFile(
		client,
		local,
		'/audio.enc',
		{},
		{ onProgress: (bytes) => progress.push(bytes) }
	);
	assert.ok(progress.length > 1);
	assert.ok(progress.every((bytes) => Number.isInteger(bytes) && bytes > 0));
	assert.equal(
		progress.reduce((sum, bytes) => sum + bytes, 0),
		data.length
	);
});

test('pipe consumption updates upload progress and keeps a moving transfer alive beyond its timeout', async (t) => {
	const work = await mkdtemp(join(tmpdir(), 'storage-progress-'));
	t.after(() => rm(work, { recursive: true, force: true }));
	const local = join(work, 'audio.enc');
	const data = Buffer.alloc(300_000, 7);
	await writeFile(local, data);
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const received = [];
	let bytes = 0;
	let elapsed = 0;
	const client = {
		put(stream) {
			return pipeline(
				stream,
				new Writable({
					write(chunk, encoding, callback) {
						received.push(Buffer.from(chunk));
						t.mock.timers.tick(20_000);
						elapsed += 20_000;
						setImmediate(callback);
					}
				})
			);
		}
	};
	await uploadStorageFile(
		client,
		local,
		'/audio.enc',
		{ uploadTimeoutSeconds: 30 },
		{
			onProgress: (count) => {
				bytes += count;
			}
		}
	);
	assert.deepEqual(Buffer.concat(received), data);
	assert.equal(bytes, data.length);
	assert.ok(elapsed > 30_000);
});

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
