import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { bundleTransfers } from '../src/lib/server/recovery-bundle-transfers.js';
import { fileDigest, unpackBundles } from '../src/lib/server/recovery-bundles.js';
import { verifyRecoveryArchives } from '../src/lib/server/recovery-archive-verification.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const deferred = () => {
	let resolve;
	const promise = new Promise((ready) => {
		resolve = ready;
	});
	return { promise, resolve };
};
async function workspace(t) {
	const root = path.join(process.cwd(), 'tests', `.recovery-concurrency-${randomUUID()}`);
	await fs.mkdir(root);
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	return root;
}
const progress = { track: (_phase, operation) => operation(), add() {} };

for (const limit of [1, 2, 8, 16]) {
	test(
		`archive validation uses ${limit} configured sessions including coordinator`,
		{ timeout: 5000 },
		async () => {
			const gate = deferred();
			let active = 0;
			let peak = 0;
			let sessions = 1;
			let peakSessions = 1;
			let arrivals = 0;
			const rows = Array.from({ length: limit + 3 }, (_, index) => ({
				object_key: `${index}.enc`,
				remote_sha256: 'valid'
			}));
			await verifyRecoveryArchives(
				{
					storagePath: (_settings, ...parts) => '/' + parts.join('/'),
					async withStorage(_settings, operation) {
						peakSessions = Math.max(peakSessions, ++sessions);
						try {
							return await operation({});
						} finally {
							sessions--;
						}
					},
					async hashRemote() {
						peak = Math.max(peak, ++active);
						if (++arrivals === limit) gate.resolve();
						try {
							await gate.promise;
							return 'valid';
						} finally {
							active--;
						}
					}
				},
				{ parallelConnections: limit },
				{},
				rows,
				async () => {}
			);
			assert.equal(peak, limit);
			assert.equal(peakSessions, limit);
			assert.equal(sessions, 1);
			assert.equal(active, 0);
			assert.equal(arrivals, rows.length);
		}
	);
}

for (const limit of [1, 2, 4, 16]) {
	test(
		`legacy bundle transfers use ${limit} total slots including coordinator`,
		{ timeout: 5000 },
		async (t) => {
			const root = await workspace(t);
			const source = path.join(root, 'source');
			await fs.writeFile(source, 'payload');
			const expected = await fileDigest(source);
			const gate = deferred();
			let active = 0;
			let peak = 0;
			let sessions = 1;
			let peakSessions = 1;
			let arrivals = 0;
			const busy = new Set();
			const client = () => ({
				async put(stream) {
					assert.equal(busy.has(this), false);
					busy.add(this);
					peak = Math.max(peak, ++active);
					if (++arrivals === limit) gate.resolve();
					try {
						await gate.promise;
						for await (const chunk of stream) assert.ok(Buffer.isBuffer(chunk));
					} finally {
						active--;
						busy.delete(this);
					}
				}
			});
			const coordinator = client();
			const transfers = bundleTransfers(
				{
					async withStorage(_settings, operation) {
						peakSessions = Math.max(peakSessions, ++sessions);
						try {
							return await operation(client());
						} finally {
							sessions--;
						}
					},
					encryptFile: fs.copyFile,
					storagePath: (_settings, ...parts) => '/' + parts.join('/'),
					async hashRemote(worker) {
						assert.equal(busy.has(worker), false);
						return expected;
					}
				},
				{ parallelConnections: limit },
				coordinator,
				root,
				async () => {},
				progress
			);
			try {
				for (let index = 0; index < limit; index++)
					await transfers.upload(source, { sha256: `digest-${index}` });
				await transfers.finish();
			} finally {
				gate.resolve();
				await transfers.settle();
			}
			assert.equal(peak, limit);
			assert.equal(peakSessions, limit);
			assert.equal(sessions, 1);
			assert.equal(active, 0);
			assert.deepEqual(await fs.readdir(root), ['source']);
		}
	);
}

for (const mode of ['failure', 'cancel']) {
	test(
		`legacy bundle ${mode} drains siblings before cleanup or rejection`,
		{ timeout: 5000 },
		async (t) => {
			const root = await workspace(t);
			const source = path.join(root, 'source');
			await fs.writeFile(source, 'payload');
			const expected = await fileDigest(source);
			const ready = deferred();
			const sibling = deferred();
			const failed = deferred();
			let owned = true;
			let active = 0;
			let started = 0;
			let settled = false;
			const client = () => ({
				async put(stream) {
					const ordinal = ++started;
					active++;
					if (ordinal === 2) ready.resolve();
					try {
						await ready.promise;
						if (ordinal === 1) {
							if (mode === 'cancel') owned = false;
							failed.resolve();
							if (mode === 'failure') throw new Error('upload failed');
						} else await sibling.promise;
						for await (const chunk of stream) assert.ok(Buffer.isBuffer(chunk));
					} finally {
						active--;
					}
				}
			});
			const transfers = bundleTransfers(
				{
					withStorage: (_settings, operation) => operation(client()),
					encryptFile: fs.copyFile,
					storagePath: (_settings, ...parts) => '/' + parts.join('/'),
					hashRemote: async () => expected
				},
				{ parallelConnections: 2 },
				client(),
				root,
				async () => {
					if (!owned) throw new Error('lease lost');
				},
				progress
			);
			const operation = (async () => {
				try {
					await transfers.upload(source, { sha256: 'first' });
					await transfers.upload(source, { sha256: 'second' });
					await transfers.finish();
				} finally {
					await transfers.settle();
				}
			})().finally(() => {
				settled = true;
			});
			const rejected = assert.rejects(
				operation,
				mode === 'failure' ? /upload failed/ : /lease lost/
			);
			await failed.promise;
			await nextTurn();
			assert.equal(settled, false);
			assert.equal(active, 1);
			assert.ok((await fs.readdir(root)).some((name) => name.endsWith('.bundle.enc')));
			sibling.resolve();
			await rejected;
			assert.equal(active, 0);
			assert.equal(started, 2);
			assert.deepEqual(await fs.readdir(root), ['source']);
		}
	);
}

for (const limit of [1, 2, 4]) {
	test(
		`v2 unpack uses ${limit} independent spools and preserves spanning-file offsets`,
		{ timeout: 5000 },
		async (t) => {
			const root = await workspace(t);
			const objects = path.join(root, 'objects');
			const restored = path.join(root, 'restored');
			await fs.mkdir(objects);
			await fs.mkdir(restored);
			const chunks = ['first-', 'second-', 'third-', 'last'].map((value) => Buffer.from(value));
			const bundles = [];
			for (const [index, bytes] of chunks.entries()) {
				const compressed = gzipSync(bytes);
				const object = `${index}.enc`;
				await fs.writeFile(path.join(objects, object), compressed);
				bundles.push({
					object,
					bytes: bytes.length,
					compressedBytes: compressed.length,
					sha256: digest(bytes),
					remoteSha256: digest(compressed)
				});
			}
			const data = Buffer.concat(chunks);
			const manifest = {
				bundles,
				files: [
					{
						path: 'uploads/spanning.bin',
						bytes: data.length,
						sha256: digest(data),
						parts: chunks.map((bytes, bundle) => ({ bundle, offset: 0, bytes: bytes.length }))
					},
					{ path: 'uploads/empty', bytes: 0, sha256: digest(''), parts: [] }
				]
			};
			const gate = deferred();
			const targets = new Set();
			let active = 0;
			let peak = 0;
			let arrivals = 0;
			let verified = 0;
			await unpackBundles(
				manifest,
				objects,
				restored,
				root,
				async (source, target) => {
					assert.equal(targets.has(target), false);
					targets.add(target);
					peak = Math.max(peak, ++active);
					if (++arrivals === limit) gate.resolve();
					try {
						await gate.promise;
						if (source.endsWith('0.enc')) await nextTurn();
						await fs.copyFile(source, target);
					} finally {
						active--;
					}
				},
				async (source, bundle) => {
					assert.equal(await fileDigest(source), bundle.remoteSha256);
				},
				{
					parallelConnections: limit,
					verifiedFile: () => {
						verified++;
					}
				}
			);
			assert.equal(peak, limit);
			assert.equal(active, 0);
			assert.equal(verified, 2);
			assert.deepEqual(await fs.readFile(path.join(restored, 'uploads', 'spanning.bin')), data);
			assert.equal((await fs.stat(path.join(restored, 'uploads', 'empty'))).size, 0);
			assert.deepEqual((await fs.readdir(root)).sort(), ['objects', 'restored']);
		}
	);
}
