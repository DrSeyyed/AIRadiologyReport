import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { listRecovery, restoreRecovery, validateRecoveryManifest } from './recovery-backups.js';
import * as crypto from './storage-crypto.js';
import * as transport from './storage-transport.js';

export const STORAGE_RESTORE_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BACKUP_ID =
	/^(0|[1-9][0-9]{0,15})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_BYTES = 1024 ** 4;
const OPERATION_MS = 6 * 60 * 60 * 1000;
const IDLE_MS = 20_000;
const ENCRYPTION_OVERHEAD = 35;

function failure() {
	return new Error('Storage restore preparation failed.');
}

export function isStorageRestoreId(value) {
	return typeof value === 'string' && STORAGE_RESTORE_ID.test(value);
}

function validBackupId(value) {
	return (
		typeof value === 'string' &&
		BACKUP_ID.test(value) &&
		Number.isSafeInteger(Number(value.slice(0, value.indexOf('-'))))
	);
}

async function localDirectories(directory) {
	const absolute = path.resolve(directory);
	const root = path.parse(absolute).root;
	let current = root;
	for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		const stat = await fs.lstat(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure();
	}
}

function contains(root, target) {
	const relative = path.relative(root, target);
	return (
		relative === '' ||
		(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
	);
}

async function canonicalDirectory(directory) {
	try {
		return await fs.realpath(directory);
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
		const parent = path.dirname(directory);
		if (parent === directory) throw error;
		const stat = await fs.lstat(directory).catch((missing) => {
			if (missing.code !== 'ENOENT') throw missing;
		});
		if (stat?.isSymbolicLink()) {
			return canonicalDirectory(path.resolve(parent, await fs.readlink(directory)));
		}
		return path.join(await canonicalDirectory(parent), path.basename(directory));
	}
}

async function separateStaging(cwd, staging, env) {
	const roots = [
		path.join(cwd, 'uploads'),
		path.join(cwd, 'static'),
		path.resolve(cwd, env.VOICE_SAVE_DIR || path.join('uploads', 'audio'))
	];
	const canonicalStaging = await canonicalDirectory(staging);
	for (const root of roots) {
		const canonicalRoot = await canonicalDirectory(root);
		if (
			contains(root, staging) ||
			contains(staging, root) ||
			contains(canonicalRoot, canonicalStaging) ||
			contains(canonicalStaging, canonicalRoot)
		)
			throw failure();
	}
}

async function bounded(operation, signal) {
	signal.throwIfAborted();
	let timer;
	let aborted;
	try {
		return await Promise.race([
			Promise.resolve().then(operation),
			new Promise((_, reject) => {
				aborted = () => reject(failure());
				signal.addEventListener('abort', aborted, { once: true });
				timer = setTimeout(aborted, IDLE_MS);
			})
		]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener('abort', aborted);
	}
}

function attributeIs(stat, method, type) {
	return (
		stat?.[method] === true ||
		(typeof stat?.[method] === 'function' && stat[method]()) ||
		stat?.type === type
	);
}

async function remotePath(client, remote, directory, signal, maxBytes = 0) {
	if (
		typeof remote !== 'string' ||
		!remote.startsWith('/') ||
		remote.includes('\\') ||
		Array.from(remote).some((character) => {
			const code = character.codePointAt(0);
			return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
		})
	)
		throw failure();
	const parts = remote.split('/').filter(Boolean);
	if (parts.some((part) => part === '.' || part === '..')) throw failure();
	for (let index = 0; index <= parts.length; index++) {
		const stat = await bounded(() => client.lstat('/' + parts.slice(0, index).join('/')), signal);
		const isDirectory = index < parts.length || directory;
		if (
			attributeIs(stat, 'isSymbolicLink', 'l') ||
			!attributeIs(stat, isDirectory ? 'isDirectory' : 'isFile', isDirectory ? 'd' : '-')
		)
			throw failure();
		if (
			!isDirectory &&
			(!Number.isSafeInteger(stat.size) || stat.size < ENCRYPTION_OVERHEAD || stat.size > maxBytes)
		)
			throw failure();
	}
}

function limitedStream(client, remote, maxBytes, signal) {
	signal.throwIfAborted();
	const source = client.createReadStream(remote);
	let bytes = 0;
	let timer;
	const limited = new Transform({
		transform(chunk, _encoding, callback) {
			bytes += chunk.length;
			clearTimeout(timer);
			timer = setTimeout(() => limited.destroy(failure()), IDLE_MS);
			callback(bytes > maxBytes ? failure() : null, chunk);
		}
	});
	const abort = () => limited.destroy(failure());
	signal.addEventListener('abort', abort, { once: true });
	timer = setTimeout(abort, IDLE_MS);
	source.on('error', abort);
	limited.once('close', () => {
		clearTimeout(timer);
		signal.removeEventListener('abort', abort);
		source.destroy();
	});
	return source.pipe(limited);
}

async function download(client, remote, target, maxBytes, signal, deps, expected) {
	await remotePath(client, remote, false, signal, maxBytes);
	const guarded = {
		lstat: (...args) => client.lstat(...args),
		createReadStream: (file) => limitedStream(client, file, maxBytes, signal)
	};
	const remoteDigest = await deps.hashRemote(guarded, remote);
	if (expected !== undefined && remoteDigest !== expected) throw failure();
	const hash = createHash('sha256');
	const digestStream = new Transform({
		transform(chunk, _encoding, callback) {
			hash.update(chunk);
			callback(null, chunk);
		}
	});
	await pipeline(
		limitedStream(client, remote, maxBytes, signal),
		digestStream,
		createWriteStream(target, { flags: 'wx', mode: 0o600 }),
		{ signal }
	);
	if (hash.digest('hex') !== remoteDigest) throw failure();
	await remotePath(client, remote, false, signal, maxBytes);
}

/** Prepare an authenticated, independent copy only. Activation and live paths are never touched.
 * injected uses recovery transport/crypto overrides; cwd/env support isolated test roots.
 * Staging must not overlap uploads, static, or VOICE_SAVE_DIR, including symlink aliases.
 * Downloads are capped at 16 MiB of manifest, 100,000 files and 1 TiB of plaintext, within six hours.
 */
export async function prepareStorageRestore(
	connection,
	{ backupId, owned = () => true } = {},
	injected = {}
) {
	let work;
	let destination;
	let published = false;
	const controller = new AbortController();
	// Leave time for transport shutdown before its independent six-hour callback limit expires.
	const timer = setTimeout(() => controller.abort(), OPERATION_MS - 60_000);
	const signal = controller.signal;
	try {
		if (!validBackupId(backupId) || typeof owned !== 'function') throw failure();
		const deps = { ...crypto, ...transport, ...injected };
		const assertOwned = async () => {
			signal.throwIfAborted();
			if ((await owned()) !== true) throw failure();
		};
		await assertOwned();
		await deps.assertStorageKey();
		const cwd = path.resolve(injected.cwd || process.cwd());
		await localDirectories(cwd);
		const root = path.join(cwd, 'restore-staging');
		const env = injected.env || process.env;
		await separateStaging(cwd, root, env);
		await fs.mkdir(root, { mode: 0o700 }).catch((error) => {
			if (error.code !== 'EEXIST') throw error;
		});
		await localDirectories(root);
		await fs.chmod(root, 0o700);
		const restoreId = randomUUID();
		destination = path.join(root, restoreId);
		work = path.join(root, `.prepare-${restoreId}`);
		await fs.mkdir(work, { mode: 0o700 });
		const manifestFile = path.join(work, 'manifest.enc');
		const objectsDirectory = path.join(work, 'objects');
		await fs.mkdir(objectsDirectory, { mode: 0o700 });
		const manifest = await deps.withStorage(
			{ ...connection, operationTimeoutMs: OPERATION_MS },
			async (client) => {
				await assertOwned();
				await remotePath(client, deps.storagePath(connection, 'backups', 'indexes'), true, signal);
				const recovery = await listRecovery(connection, {
					...deps,
					withStorage: async (_connection, callback) => callback(client)
				});
				const selected = recovery.filter((snapshot) => snapshot.id === backupId);
				if (selected.length !== 1) throw failure();
				const snapshot = selected[0];
				await remotePath(
					client,
					deps.storagePath(connection, 'backups', 'indexes', `${backupId}.${snapshot.kind}.json`),
					false,
					signal,
					MAX_MANIFEST_BYTES
				);
				await download(
					client,
					deps.storagePath(connection, 'backups', 'manifests', `${backupId}.enc`),
					manifestFile,
					MAX_MANIFEST_BYTES,
					signal,
					deps
				);
				const plain = path.join(work, 'manifest.json');
				await deps.decryptFile(manifestFile, plain);
				const parsed = validateRecoveryManifest(JSON.parse(await fs.readFile(plain, 'utf8')));
				await fs.unlink(plain);
				if (
					parsed.id !== snapshot.id ||
					parsed.kind !== snapshot.kind ||
					parsed.createdAt !== snapshot.createdAt ||
					parsed.files.length > MAX_FILES
				)
					throw failure();
				let bytes = 0;
				const objects = new Set();
				for (const entry of parsed.files) {
					bytes += entry.bytes;
					if (!Number.isSafeInteger(bytes) || bytes > MAX_BYTES) throw failure();
				}
				for (const entry of parsed.files) {
					await assertOwned();
					if (objects.has(entry.object)) continue;
					objects.add(entry.object);
					await download(
						client,
						deps.storagePath(connection, 'backups', 'objects', entry.object),
						path.join(objectsDirectory, entry.object),
						entry.bytes + ENCRYPTION_OVERHEAD,
						signal,
						deps,
						entry.remoteSha256
					);
				}
				await assertOwned();
				return parsed;
			}
		);
		await assertOwned();
		const verified = path.join(work, 'verified');
		const result = await restoreRecovery(
			{ manifestFile, objectsDirectory, outputDirectory: verified },
			deps
		);
		if (result.id !== backupId || result.files !== manifest.files.length) throw failure();
		await localDirectories(root);
		await separateStaging(cwd, root, env);
		await assertOwned();
		await fs.rename(verified, destination);
		published = true;
		await fs.rm(work, { recursive: true, force: true });
		work = undefined;
		await assertOwned();
		return { id: backupId, restoreId, files: result.files };
	} catch {
		await Promise.all(
			[
				work && fs.rm(work, { recursive: true, force: true }),
				published && fs.rm(destination, { recursive: true, force: true })
			].filter(Boolean)
		).catch(() => {});
		throw failure();
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}
