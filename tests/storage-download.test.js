import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { downloadStorageFile } from '../src/lib/server/storage-download.js';

const nextTurn = () => new Promise(setImmediate);

for (const seconds of [2, 45]) {
	test(`backup download aborts after configured ${seconds} seconds without data`, async (t) => {
		const work = await mkdtemp(join(tmpdir(), 'storage-read-'));
		t.after(() => rm(work, { recursive: true, force: true }));
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const source = new Readable({ read() {} });
		let settled = false;
		const pending = assert
			.rejects(
				downloadStorageFile({ createReadStream: () => source }, '/vault/file', join(work, 'file'), {
					verificationTimeoutSeconds: seconds
				}),
				/inactivity/
			)
			.then(() => {
				settled = true;
			});
		await nextTurn();
		t.mock.timers.tick(seconds * 1000 - 1);
		await nextTurn();
		assert.equal(settled, false);
		t.mock.timers.tick(1);
		await pending;
		assert.equal(source.destroyed, true);
	});
}

test('backup download resets inactivity on data and permits transfers longer than the selected timeout', async (t) => {
	const work = await mkdtemp(join(tmpdir(), 'storage-read-'));
	t.after(() => rm(work, { recursive: true, force: true }));
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const source = new Readable({ read() {} });
	const target = join(work, 'file');
	const chunks = [];
	const pending = downloadStorageFile(
		{ createReadStream: () => source },
		'/vault/file',
		target,
		{
			verificationTimeoutSeconds: 45
		},
		{ onProgress: (bytes) => chunks.push(bytes) }
	);
	await nextTurn();
	for (let index = 0; index < 3; index++) {
		t.mock.timers.tick(25_000);
		source.push(Buffer.from('chunk'));
		await nextTurn();
	}
	source.push(null);
	await pending;
	assert.equal(await readFile(target, 'utf8'), 'chunkchunkchunk');
	assert.deepEqual(chunks, [5, 5, 5]);
});
