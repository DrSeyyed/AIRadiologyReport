import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { hashLocal } from './storage-audio.js';
import { decryptFile } from './storage-crypto.js';
import { abortStorageSession } from './storage-session.js';
import { storageDestination } from './storage-settings.js';
import { storagePath, withStorage } from './storage-transport.js';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const audioName = new RegExp(`^${uuid}\\.enc$`);
const manifestName = new RegExp(`^\\d{1,16}-${uuid}\\.enc$`);
const indexName = new RegExp(`^\\d{1,16}-${uuid}(?:\\.(database|full)\\.json|\\.pending)$`);
const objectName = /^[a-f0-9]{64}\.enc$/;
const digest = /^[a-f0-9]{64}$/;

class StorageResetFailure extends Error {}

export function storageResetFailureMessage(error) {
	return error instanceof StorageResetFailure ? error.message : 'Failure details unavailable.';
}

function resetFailure(error, stage) {
	const codes = {
		ENOENT: 'File or directory not found (ENOENT).',
		ENOSPC: 'Insufficient local disk space (ENOSPC).',
		EACCES: 'Permission denied (EACCES).',
		EPERM: 'Operation not permitted (EPERM).',
		EIO: 'Filesystem input/output error (EIO).',
		ECONNRESET: 'Storage connection reset (ECONNRESET).',
		ECONNREFUSED: 'Storage connection refused (ECONNREFUSED).',
		ETIMEDOUT: 'Storage operation timed out (ETIMEDOUT).',
		2: 'Remote file or directory not found (SFTP status 2).',
		3: 'Remote permission denied (SFTP status 3).',
		4: 'Remote storage operation failed (SFTP status 4).'
	};
	const reason =
		error instanceof StorageResetFailure
			? error.message
			: Object.hasOwn(codes, error?.code)
				? codes[error.code]
				: 'Storage or filesystem operation failed; sensitive error details were withheld.';
	return new StorageResetFailure(`${stage}: ${reason}`, { cause: error });
}

function attribute(attributes, name) {
	return (
		attributes?.[name] === true || (typeof attributes?.[name] === 'function' && attributes[name]())
	);
}

async function existingAttributes(client, path) {
	try {
		return await client.lstat(path);
	} catch (error) {
		if (error.code === 2 || error.code === 'ENOENT') return null;
		throw error;
	}
}

async function directory(client, path) {
	const attributes = await existingAttributes(client, path);
	if (
		attributes &&
		(!attribute(attributes, 'isDirectory') || attribute(attributes, 'isSymbolicLink'))
	)
		throw new StorageResetFailure(
			'Reset requires real storage directories, not files or symbolic links.'
		);
	return attributes;
}

async function remotePlan(client, connection, setStage) {
	const files = [];
	const folders = [];
	async function collect(segments, pattern) {
		setStage(`Inspecting remote ${segments.join('/')}`);
		const path = storagePath(connection, ...segments);
		if (!(await directory(client, path))) return;
		const entries = await client.list(path);
		if (entries.length > 200_000)
			throw new StorageResetFailure(
				`Storage reset listing limit exceeded in ${segments.join('/')}.`
			);
		for (const entry of entries) {
			if (!pattern.test(entry.name) || entry.type !== '-') {
				const reason =
					entry.type === 'l'
						? 'symbolic links are not allowed'
						: 'unrecognized file name or entry type';
				throw new StorageResetFailure(`Unexpected entry in ${segments.join('/')}: ${reason}.`);
			}
			files.push(storagePath(connection, ...segments, entry.name));
		}
		folders.push(path);
	}
	setStage('Inspecting remote backups');
	const backups = storagePath(connection, 'backups');
	if (await directory(client, backups)) {
		for (const entry of await client.list(backups))
			if (!['indexes', 'manifests', 'objects'].includes(entry.name) || entry.type !== 'd')
				throw new StorageResetFailure(
					'Unexpected entry in backups; only real indexes, manifests and objects directories are allowed.'
				);
		// Remove completed and unfinished indexes before the objects they reference.
		await collect(['backups', 'indexes'], indexName);
		await collect(['backups', 'manifests'], manifestName);
		await collect(['backups', 'objects'], objectName);
		folders.push(backups);
	}
	setStage('Inspecting remote files');
	const synced = storagePath(connection, 'files');
	if (await directory(client, synced)) {
		for (const entry of await client.list(synced))
			if (entry.name !== 'objects' || entry.type !== 'd')
				throw new StorageResetFailure(
					'Unexpected entry in files; only a real objects directory is allowed.'
				);
		await collect(['files', 'objects'], objectName);
		folders.push(synced);
	}
	await collect(['audio'], audioName);
	return { files, folders };
}

async function localTarget(path, roots) {
	const target = resolve(path);
	let root;
	for (const candidate of roots) {
		const absolute = resolve(candidate);
		const sub = relative(absolute, target);
		if (
			sub &&
			sub !== '..' &&
			!sub.startsWith(`..\\`) &&
			!sub.startsWith('../') &&
			!isAbsolute(sub)
		) {
			root = absolute;
			break;
		}
	}
	if (!root || (await realpath(root)) !== root || !(await lstat(root)).isDirectory())
		throw new StorageResetFailure('Reset audio path is outside real upload directories.');
	const segments = relative(root, target).split(/[\\/]/);
	let parent = root;
	for (const segment of segments.slice(0, -1)) {
		parent = join(parent, segment);
		try {
			await mkdir(parent, { mode: 0o700 });
			if (process.platform !== 'win32') await syncFile(dirname(parent));
		} catch (error) {
			if (error.code !== 'EEXIST') throw error;
		}
		const attributes = await lstat(parent);
		if (!attributes.isDirectory() || attributes.isSymbolicLink())
			throw new StorageResetFailure('Reset audio path contains an unsafe directory.');
	}
	return { target, parent };
}

async function matches(file, saved) {
	try {
		const attributes = await lstat(file);
		if (!attributes.isFile() || attributes.isSymbolicLink())
			throw new StorageResetFailure('Unsafe local audio file.');
		if (attributes.size !== saved.bytes || (await hashLocal(file)) !== saved.sha256)
			throw new StorageResetFailure('Local audio differs from the archived copy; reset stopped.');
		return true;
	} catch (error) {
		if (error.code === 'ENOENT') return false;
		throw error;
	}
}

async function syncFile(file) {
	const handle = await open(file, process.platform === 'win32' ? 'r+' : 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function resetStorageData(
	db,
	connection,
	{
		jobId,
		owned = () => true,
		transport = withStorage,
		roots = ['uploads', ...(process.env.VOICE_SAVE_DIR ? [process.env.VOICE_SAVE_DIR] : [])]
	} = {}
) {
	const controller = new AbortController();
	async function assertOwned() {
		const active = !controller.signal.aborted && (await owned());
		if (!active || controller.signal.aborted)
			throw new StorageResetFailure('Storage reset no longer owns the worker.');
	}
	const request = db.prepare('SELECT * FROM storage_reset_requests WHERE job_id=?').get(jobId);
	if (!request) throw new StorageResetFailure('Missing storage reset request.');
	const destination = storageDestination(connection);
	let stage = 'Connecting to storage';
	let callbackFailure;
	const setStage = (value) => {
		stage = value;
	};
	// The transport sanitizes callback errors, so capture safe reset diagnostics before that boundary.
	const captureFailure = (operation) => async (client) => {
		const abort = () => abortStorageSession(client);
		controller.signal.addEventListener('abort', abort, { once: true });
		// Guard late completions too: an aborted request must never resume reset cleanup.
		const guarded = Object.fromEntries(
			['lstat', 'list', 'get', 'delete', 'rmdir'].map((method) => [
				method,
				async (...args) => {
					await assertOwned();
					const result = await client[method](...args);
					await assertOwned();
					return result;
				}
			])
		);
		try {
			await assertOwned();
			return await operation(guarded);
		} catch (error) {
			callbackFailure = resetFailure(error, stage);
			throw error;
		} finally {
			controller.signal.removeEventListener('abort', abort);
		}
	};
	let checking = false;
	const cancellation = setInterval(async () => {
		if (checking) return;
		checking = true;
		try {
			await assertOwned();
		} catch {
			controller.abort();
		} finally {
			checking = false;
		}
	}, 250);
	try {
		return await transport(
			{ ...connection, operationTimeoutMs: 6 * 60 * 60 * 1000, signal: controller.signal },
			captureFailure(async (client) => {
				await assertOwned();
				if (request.phase === 'recovering') {
					stage = 'Checking remote audio directory';
					await directory(client, storagePath(connection, 'audio'));
					const rows = db.prepare('SELECT * FROM storage_audio ORDER BY path').all();
					db.prepare('UPDATE storage_reset_requests SET total=?,restored=0 WHERE job_id=?').run(
						rows.length,
						jobId
					);
					let recovered = 0;
					for (const saved of rows) {
						stage = `Recovering local audio ${recovered + 1}/${rows.length}`;
						await assertOwned();
						if (
							saved.destination !== destination ||
							!audioName.test(saved.object_key) ||
							!digest.test(saved.sha256) ||
							!digest.test(saved.remote_sha256) ||
							!Number.isSafeInteger(saved.bytes) ||
							saved.bytes < 0
						)
							throw new StorageResetFailure('Invalid archive metadata; reset stopped.');
						const { target, parent } = await localTarget(saved.path, roots);
						if (!(await matches(target, saved))) {
							const space = await statfs(parent, { bigint: true });
							if (space.bavail * space.bsize < BigInt(saved.bytes) * 2n + 64n * 1024n * 1024n)
								throw new StorageResetFailure(
									'Insufficient local disk space to recover audio safely.'
								);
							const work = await mkdtemp(join(parent, '.storage-reset-'));
							try {
								const encrypted = join(work, `${randomUUID()}.enc`);
								const plain = join(work, 'audio');
								const remote = storagePath(connection, 'audio', saved.object_key);
								const attributes = await client.lstat(remote);
								if (
									!attribute(attributes, 'isFile') ||
									attribute(attributes, 'isSymbolicLink') ||
									!Number.isSafeInteger(attributes.size) ||
									attributes.size < saved.bytes ||
									attributes.size > saved.bytes + 1024
								)
									throw new StorageResetFailure('Unsafe remote audio object or unexpected size.');
								await client.get(remote, encrypted);
								if ((await hashLocal(encrypted)) !== saved.remote_sha256)
									throw new StorageResetFailure('Corrupt encrypted audio.');
								stage = `Decrypting recovered audio ${recovered + 1}/${rows.length}`;
								await decryptFile(encrypted, plain);
								stage = `Validating recovered audio ${recovered + 1}/${rows.length}`;
								if (!(await matches(plain, saved)))
									throw new StorageResetFailure('Recovered audio is missing.');
								await syncFile(plain);
								await assertOwned();
								try {
									await link(plain, target);
								} catch (error) {
									if (error.code !== 'EEXIST' || !(await matches(target, saved))) throw error;
								}
								if (process.platform !== 'win32') await syncFile(parent);
							} finally {
								await rm(work, { recursive: true, force: true });
							}
						}
						await syncFile(target);
						await assertOwned();
						db.prepare('UPDATE storage_reset_requests SET restored=? WHERE job_id=?').run(
							++recovered,
							jobId
						);
					}
					let checked = 0;
					for (const saved of rows) {
						stage = `Rechecking recovered local audio ${++checked}/${rows.length}`;
						await assertOwned();
						const { target } = await localTarget(saved.path, roots);
						if (!(await matches(target, saved)))
							throw new StorageResetFailure('Audio disappeared before reset.');
					}
					await remotePlan(client, connection, setStage);
					await assertOwned();
					db.transaction(() => {
						db.prepare('DELETE FROM storage_audio').run();
						db.prepare("UPDATE storage_reset_requests SET phase='cleaning' WHERE job_id=?").run(
							jobId
						);
					})();
				}
				const plan = await remotePlan(client, connection, setStage);
				let deleting = 0;
				for (const path of plan.files) {
					stage = `Deleting remote file ${++deleting}/${plan.files.length}`;
					await assertOwned();
					const attributes = await existingAttributes(client, path);
					if (attributes) {
						if (!attribute(attributes, 'isFile') || attribute(attributes, 'isSymbolicLink'))
							throw new StorageResetFailure('Remote storage changed during reset.');
						await client.delete(path, true);
					}
					db.prepare('UPDATE storage_reset_requests SET deleted=deleted+1 WHERE job_id=?').run(
						jobId
					);
				}
				stage = 'Removing remote application directories';
				for (const path of plan.folders) {
					await assertOwned();
					if (await directory(client, path)) await client.rmdir(path, false);
				}
				stage = 'Finalizing local storage reset metadata';
				await assertOwned();
				db.transaction(() => {
					for (const table of [
						'storage_file_queue',
						'storage_file_catalog',
						'storage_file_objects'
					])
						if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
							db.prepare(`DELETE FROM ${table}`).run();
					db.prepare('DELETE FROM storage_jobs WHERE id<>?').run(jobId);
					db.prepare("UPDATE storage_reset_requests SET phase='complete' WHERE job_id=?").run(
						jobId
					);
				})();
				const result = db
					.prepare('SELECT restored,total,deleted FROM storage_reset_requests WHERE job_id=?')
					.get(jobId);
				return { reset: true, ...result };
			})
		);
	} catch (error) {
		throw callbackFailure || resetFailure(error, stage);
	} finally {
		clearInterval(cancellation);
	}
}
