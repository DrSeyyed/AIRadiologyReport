import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';

export const BUNDLE_BYTES = 256 * 1024 * 1024;
export const MAX_RECOVERY_BYTES = 1024 ** 4;
export const MAX_RECOVERY_FILES = 100_000;
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const ENCRYPTION_OVERHEAD = 35;

export async function fileDigest(file, activity = () => {}) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) {
		hash.update(chunk);
		activity();
	}
	return hash.digest('hex');
}

// v2 concat-gzip-v1: authenticated manifest parts address byte ranges in a gzip-compressed
// concatenation, not archive headers. No paths or extraction instructions come from gzip data.
// Each raw bundle is <=256 MiB; larger files span bundles. Only one bundle is spooled at a time.
export function bundleWriter(work, manifest, publish, limit = BUNDLE_BYTES) {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > BUNDLE_BYTES)
		throw new Error('Invalid recovery bundle limit.');
	const raw = path.join(work, 'bundle.raw');
	const compressed = path.join(work, 'bundle.gz');
	let bytes = 0;
	async function flush() {
		if (!bytes) return;
		try {
			const sha256 = await fileDigest(raw);
			await pipeline(
				createReadStream(raw),
				createGzip(),
				createWriteStream(compressed, { flags: 'wx', mode: 0o600 })
			);
			const compressedBytes = (await fs.stat(compressed)).size;
			const remote = await publish(compressed, { sha256, bytes, compressedBytes });
			manifest.bundles.push({ sha256, bytes, compressedBytes, ...remote });
		} finally {
			await fs.rm(raw, { force: true });
			await fs.rm(compressed, { force: true });
		}
		bytes = 0;
	}
	return {
		flush,
		async add(source, entry) {
			entry.parts = [];
			let position = 0;
			while (position < entry.bytes) {
				const count = Math.min(entry.bytes - position, limit - bytes);
				entry.parts.push({ bundle: manifest.bundles.length, offset: bytes, bytes: count });
				await pipeline(
					createReadStream(source, { start: position, end: position + count - 1 }),
					createWriteStream(raw, { flags: 'a', mode: 0o600 })
				);
				position += count;
				bytes += count;
				if (bytes === limit) await flush();
			}
		}
	};
}

export function recoveryObjects(manifest) {
	return manifest.version === 2 ? manifest.bundles : manifest.files;
}

export function objectDownloadBytes(manifest, object) {
	return (manifest.version === 2 ? object.compressedBytes : object.bytes) + ENCRYPTION_OVERHEAD;
}

export async function unpackBundles(
	manifest,
	objectsDirectory,
	restored,
	work,
	decrypt,
	checkObject,
	{ activity = () => {}, verifiedFile = () => {}, phase = () => {} } = {}
) {
	const ranges = manifest.bundles.map(() => []);
	for (const entry of manifest.files) {
		const target = path.join(restored, ...entry.path.split('/'));
		await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		await fs.writeFile(target, '', { flag: 'wx', mode: 0o600 });
		for (const part of entry.parts)
			ranges[part.bundle].push({ target, offset: part.offset, bytes: part.bytes });
		activity();
	}
	for (const [index, bundle] of manifest.bundles.entries()) {
		const object = path.join(objectsDirectory, bundle.object);
		await checkObject(object, bundle);
		const compressed = path.join(work, 'restore.gz');
		const raw = path.join(work, 'restore.raw');
		try {
			await decrypt(object, compressed);
			if ((await fs.stat(compressed)).size !== bundle.compressedBytes)
				throw new Error('Invalid recovery bundle.');
			phase('verifying');
			let bytes = 0;
			const hash = createHash('sha256');
			await pipeline(
				createReadStream(compressed),
				createGunzip(),
				new Transform({
					transform(chunk, _encoding, callback) {
						bytes += chunk.length;
						if (bytes > bundle.bytes)
							return callback(new Error('Recovery decompression limit exceeded.'));
						hash.update(chunk);
						try {
							activity();
							callback(null, chunk);
						} catch (error) {
							callback(error);
						}
					}
				}),
				createWriteStream(raw, { flags: 'wx', mode: 0o600 })
			);
			if (bytes !== bundle.bytes || hash.digest('hex') !== bundle.sha256)
				throw new Error('Invalid recovery bundle.');
			for (const part of ranges[index]) {
				await pipeline(
					createReadStream(raw, { start: part.offset, end: part.offset + part.bytes - 1 }),
					createWriteStream(part.target, { flags: 'a', mode: 0o600 })
				);
				activity();
			}
		} finally {
			await fs.rm(compressed, { force: true });
			await fs.rm(raw, { force: true });
		}
	}
	phase('verifying');
	for (const entry of manifest.files) {
		const target = path.join(restored, ...entry.path.split('/'));
		if (
			(await fs.stat(target)).size !== entry.bytes ||
			(await fileDigest(target, activity)) !== entry.sha256
		)
			throw new Error('Invalid recovery file.');
		verifiedFile();
	}
}
