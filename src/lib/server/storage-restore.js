import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { storageTimeoutMs } from './storage-settings.js';
import { storageFilePool } from './storage-file-pool.js';
import { pipeline } from 'node:stream/promises';
import {
	listRecovery, restoreRecovery, validateRecoveryManifest, recoveryAudioPlan
} from './recovery-backups.js';
import { hashStorageFile } from './storage-shell.js';
import { abortStorageSession } from './storage-session.js';
import * as crypto from './storage-crypto.js';
import * as transport from './storage-transport.js';
import { recoveryObjects, objectDownloadBytes, unpackBundles, fileDigest } from './recovery-bundles.js';
import { restoreProgress } from './restore-progress.js';

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

function limitedStream(client, remote, maxBytes, signal, readTimeoutMs, onBytes = () => {}) {
	signal.throwIfAborted();
	const source = client.createReadStream(remote);
	let bytes = 0;
	let timer;
	const limited = new Transform({
		transform(chunk, _encoding, callback) {
			bytes += chunk.length;
			try {
				onBytes(chunk.length);
			} catch {
				return callback(failure());
			}
			clearTimeout(timer);
			timer = setTimeout(() => limited.destroy(failure()), readTimeoutMs);
			callback(bytes > maxBytes ? failure() : null, chunk);
		}
	});
	const abort = () => limited.destroy(failure());
	signal.addEventListener('abort', abort, { once: true });
	timer = setTimeout(abort, readTimeoutMs);
	source.on('error', abort);
	limited.once('close', () => {
		clearTimeout(timer);
		signal.removeEventListener('abort', abort);
		source.destroy();
	});
	return source.pipe(limited);
}

async function download(
	client,
	remote,
	target,
	maxBytes,
	signal,
	deps,
	connection,
	progress,
	expected
) {
	const readTimeoutMs = storageTimeoutMs(connection, 'verificationTimeoutSeconds');
	await remotePath(client, remote, false, signal, maxBytes);
	const guarded = {
		lstat: (...args) => client.lstat(...args),
		createReadStream: (file) =>
			limitedStream(client, file, maxBytes, signal, readTimeoutMs, (bytes) =>
				progress.add('verificationBytes', bytes)
			)
	};
	const remoteDigest = await deps.hashRemote(guarded, remote, connection);
	if (expected !== undefined && remoteDigest !== expected) throw failure();
	const hash = createHash('sha256');
	const digestStream = new Transform({
		transform(chunk, _encoding, callback) {
			hash.update(chunk);
			callback(null, chunk);
		}
	});
	await pipeline(
		limitedStream(client, remote, maxBytes, signal, readTimeoutMs, (bytes) =>
			progress.add('downloadedBytes', bytes)
		),
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
 * v2 downloads use authenticated compressed bundle sizes; v1 independent objects remain supported.
 */
export async function prepareStorageRestore(
	connection,
	{ backupId, audioMode = 'download', owned = () => true, onProgress } = {},
	injected = {}
) {
	let work;
	let destination;
	let published = false;
	let progress;
	const controller = new AbortController();
	const clients = new Set();
	const stop = () => {
		controller.abort();
		for (const client of clients) abortStorageSession(client);
	};
	let ownershipTimer;
	// Leave time for transport shutdown before its independent six-hour callback limit expires.
	const timer = setTimeout(stop, OPERATION_MS - 60_000);
	const signal = controller.signal;
	try {
		if (!validBackupId(backupId) || typeof owned !== 'function' ||
			!['remote', 'download'].includes(audioMode)) throw failure();
		const deps = { ...crypto, ...transport, hashStorageFile, ...injected };
		const connect = deps.withStorage;
		deps.withStorage = (settings, callback) => connect(settings, (client) => {
			clients.add(client);
			return callback(client);
		});
		const assertOwned = async () => {
			try {
				signal.throwIfAborted();
				progress?.assertHealthy();
				if ((await owned()) !== true) throw failure();
			} catch (error) {
				stop();
				throw error;
			}
		};
		await assertOwned();
		let checkingOwnership = false;
		ownershipTimer = setInterval(() => {
			if (checkingOwnership) return;
			checkingOwnership = true;
			assertOwned().catch(stop).finally(() => { checkingOwnership = false; });
		}, 100);
		ownershipTimer.unref();
		progress = restoreProgress(onProgress);
		progress.assertHealthy();
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
		const transferConnection = { ...connection, signal, operationTimeoutMs: OPERATION_MS };
		let remoteAudio = [];
		let preparation;
		let stopped = false;
		let manifest;
		try {
			manifest = await deps.withStorage(transferConnection, (client) => {
				if (stopped) throw failure();
				preparation = (async () => {
					await assertOwned();
					progress.set({ phase: 'listing' });
					await remotePath(
						client,
						deps.storagePath(connection, 'backups', 'indexes'),
						true,
						signal
					);
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
					progress.set({ phase: 'manifest' });
					await download(
						client,
						deps.storagePath(connection, 'backups', 'manifests', `${backupId}.enc`),
						manifestFile,
						MAX_MANIFEST_BYTES + ENCRYPTION_OVERHEAD,
						signal,
						deps,
						connection,
						progress
					);
					const plain = path.join(work, 'manifest.json');
					await deps.decryptFile(manifestFile, plain);
					if ((await fs.stat(plain)).size > MAX_MANIFEST_BYTES) throw failure();
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
					const objects = new Map();
					for (const entry of parsed.files) {
						bytes += entry.bytes;
						if (!Number.isSafeInteger(bytes) || bytes > MAX_BYTES) throw failure();
					}
					progress.set({
						phase: 'downloading',
						totalFiles: parsed.files.length,
						totalObjects: new Set(recoveryObjects(parsed).map((entry) => entry.object)).size
					});
					const downloaded = new Set();
					async function downloadObjects(entries) {
						const unique = new Map(entries.map((entry) => [entry.object, entry]));
						await storageFilePool(deps, transferConnection,
							[...unique.values()].filter((entry) => !downloaded.has(entry.object)),
							async (worker, entry) => {
								try {
									await download(worker,
										deps.storagePath(connection, 'backups', 'objects', entry.object),
										path.join(objectsDirectory, entry.object), objectDownloadBytes(parsed, entry),
										signal, deps, connection, progress, entry.remoteSha256);
									downloaded.add(entry.object);
									progress.add('downloadedObjects');
								} catch (error) { stop(); throw error; }
							}, assertOwned, client);
					}
					if (audioMode === 'remote') {
						const database = parsed.files.find((entry) => entry.role === 'database');
						await downloadObjects(recoveryObjects(parsed, [database]));
						const inspection = path.join(work, 'inspection');
						await fs.mkdir(inspection, { mode: 0o700 });
						const databaseFile = path.join(inspection, 'db', 'pacs.db');
						if (parsed.version === 2) {
							await unpackBundles(parsed, objectsDirectory, inspection, work,
								deps.decryptFile, async (object, entry) => {
									await assertOwned();
									if ((await fileDigest(object)) !== entry.remoteSha256) throw failure();
								}, { files: [database], parallelConnections: connection.parallelConnections,
									assertActive: assertOwned, activity: () => progress.set({}) });
						} else {
							await fs.mkdir(path.dirname(databaseFile), { mode: 0o700 });
							await deps.decryptFile(path.join(objectsDirectory, database.object), databaseFile);
							if ((await fs.stat(databaseFile)).size !== database.bytes ||
								(await fileDigest(databaseFile)) !== database.sha256) throw failure();
						}
						await assertOwned();
						remoteAudio = recoveryAudioPlan(parsed, databaseFile, connection);
						await fs.rm(inspection, { recursive: true, force: true });
						const archives = new Map(remoteAudio.map((entry) => [entry.archive.object_key, entry.archive]));
						progress.set({ phase: 'verifying' });
						await storageFilePool(deps, transferConnection, [...archives.values()], async (worker, archive) => {
							try {
								const remote = deps.storagePath(connection, 'audio', archive.object_key);
								const bytes = archive.bytes + ENCRYPTION_OVERHEAD;
								await remotePath(worker, remote, false, signal, bytes);
								if ((await bounded(() => worker.lstat(remote), signal)).size !== bytes ||
									(await deps.hashStorageFile(worker, remote, connection, {
										assertActive: () => { signal.throwIfAborted(); progress.assertHealthy(); },
										onProgress: () => progress.set({})
									})) !== archive.remote_sha256) throw failure();
								await remotePath(worker, remote, false, signal, bytes);
								progress.add('verificationBytes', bytes);
							} catch (error) { stop(); throw error; }
						}, assertOwned, client);
					}
					const omitted = new Set(remoteAudio.map((entry) => entry.path));
					const files = parsed.files.filter((entry) => !omitted.has(entry.path));
					for (const entry of recoveryObjects(parsed, files)) objects.set(entry.object, entry);
					progress.set({ phase: 'downloading', totalFiles: files.length, totalObjects: objects.size });
					await downloadObjects([...objects.values()]);
					await assertOwned();
					return parsed;
				})();
				return preparation;
			});
		} catch (error) {
			stopped = true;
			stop();
			throw error;
		} finally {
			stopped = true;
			await preparation?.catch(() => {});
		}
		await assertOwned();
		const verified = path.join(work, 'verified');
		const result = await restoreRecovery(
			{
				manifestFile,
				objectsDirectory,
				outputDirectory: verified,
				parallelConnections: connection.parallelConnections,
				audioMode, remoteAudio, remoteConnection: connection,
				owned: assertOwned,
				onProgress: (update) => progress.set(update)
			},
			deps
		);
		if (result.id !== backupId || result.files + result.remoteAudioFiles !== manifest.files.length)
			throw failure();
		progress.set({ phase: 'publishing' });
		await localDirectories(root);
		await separateStaging(cwd, root, env);
		await assertOwned();
		await fs.rename(verified, destination);
		published = true;
		await fs.rm(work, { recursive: true, force: true });
		work = undefined;
		await assertOwned();
		progress.set({ phase: 'complete', restoredFiles: result.files });
		return {
			id: backupId,
			restoreId,
			files: result.files,
			audioMode,
			remoteAudioFiles: result.remoteAudioFiles,
			integrationFields: result.integrationFields
		};
	} catch {
		await Promise.all(
			[
				work && fs.rm(work, { recursive: true, force: true }),
				published && fs.rm(destination, { recursive: true, force: true })
			].filter(Boolean)
		).catch(() => {});
		throw failure();
	} finally {
		progress?.finish();
		clearInterval(ownershipTimer);
		clearTimeout(timer);
		controller.abort();
	}
}
