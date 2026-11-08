import { performance } from 'node:perf_hooks';
import { withStorage, storagePath } from './storage-transport.js';
import { storageDestination, storageParallelConnections } from './storage-settings.js';
import { hashStorageFile } from './storage-shell.js';
import { storageFilePool } from './storage-file-pool.js';
import { abortStorageSession, assertStorageSession, storageRequest } from './storage-session.js';

const progressFields = ['checked', 'total', 'verifiedBytes', 'elapsedSeconds', 'lastActivityAt'];
const auditError = () => new Error('Storage integrity audit failed.');
/** Reject malformed audit results and allowlist valid counters for worker history. */
export function safeStorageAuditProgress(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const result = {};
	for (const field of progressFields) {
		if (!Object.hasOwn(value, field)) return null;
		const number = value[field];
		if (!Number.isSafeInteger(number) || number < 0) return null;
		result[field] = number;
	}
	return result.checked <= result.total ? result : null;
}

function isType(info, method, type) {
	return (
		info?.type === type ||
		info?.[method] === true ||
		(typeof info?.[method] === 'function' && info[method]())
	);
}

/** Full, read-only remote checksum audit; total/checked count unique remote copies, not rows. */
export async function auditStorageData(
	db,
	connection,
	{ now = Math.floor(Date.now() / 1000), owned = () => true, onProgress = () => {}, signal } = {},
	injected = {}
) {
	const deps = { withStorage, storagePath, hashStorageFile, ...injected };
	const controller = new AbortController();
	const clients = new Set();
	const connect = deps.withStorage;
	deps.withStorage = async (settings, callback) => {
		try {
			return await connect(settings, callback);
		} catch {
			stop();
			throw auditError();
		}
	};
	const started = performance.now();
	const state = {
		checked: 0,
		total: 0,
		verifiedBytes: 0,
		elapsedSeconds: 0,
		lastActivityAt: Math.floor(Date.now() / 1000)
	};
	let failure;
	let poll;
	let reporter;
	function stop() {
		failure ||= auditError();
		controller.abort();
		for (const client of clients) abortStorageSession(client);
	}
	function assertActive() {
		if (failure || signal?.aborted || typeof owned !== 'function' || owned() !== true) {
			stop();
			throw auditError();
		}
	}
	function snapshot() {
		state.elapsedSeconds = Math.floor((performance.now() - started) / 1000);
		return safeStorageAuditProgress(state);
	}
	function report() {
		assertActive();
		if (typeof onProgress !== 'function') throw auditError();
		onProgress(snapshot());
		assertActive();
	}
	function activity() {
		assertActive();
		state.lastActivityAt = Math.floor(Date.now() / 1000);
	}
	async function request(client, operation) {
		assertActive();
		assertStorageSession(client);
		let cancel;
		try {
			return await Promise.race([
				Promise.resolve().then(() => {
					assertActive();
					return operation();
				}),
				new Promise((_, reject) => {
					cancel = () => reject(auditError());
					controller.signal.addEventListener('abort', cancel, { once: true });
					if (controller.signal.aborted) cancel();
				})
			]);
		} finally {
			controller.signal.removeEventListener('abort', cancel);
		}
	}
	const hasTable = (name) =>
		Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
	try {
		assertActive();
		if (!Number.isSafeInteger(now) || now < 0) throw auditError();
		storageParallelConnections(connection);
		const destination = storageDestination(connection);
		const objects = hasTable('storage_file_objects')
			? db.prepare('SELECT * FROM storage_file_objects WHERE destination=?').all(destination)
			: [];
		const archives = hasTable('storage_audio')
			? db.prepare('SELECT * FROM storage_audio WHERE destination=?').all(destination)
			: [];
		const targets = new Map();
		function addTarget(target, digest, bytes) {
			if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(bytes) || bytes < 0)
				throw auditError();
			const previous = targets.get(target);
			if (previous && (previous.digest !== digest || previous.bytes !== bytes)) throw auditError();
			targets.set(target, { target, digest, bytes });
		}
		for (const object of objects) {
			addTarget(
				deps.storagePath(connection, 'files', 'objects', object.object_key),
				object.remote_sha256,
				object.encrypted_bytes
			);
			if (object.backup_linked_at != null)
				addTarget(
					deps.storagePath(connection, 'backups', 'objects', object.object_key),
					object.remote_sha256,
					object.encrypted_bytes
				);
		}
		for (const archive of archives) {
			// Legacy ARRSTG v1 ciphertext adds a 7-byte prefix, 12-byte IV and 16-byte tag.
			if (!Number.isSafeInteger(archive.bytes) || archive.bytes < 0) throw auditError();
			addTarget(
				deps.storagePath(connection, 'audio', archive.object_key),
				archive.remote_sha256,
				archive.encrypted_bytes ?? archive.bytes + 35
			);
		}
		state.total = targets.size;
		signal?.addEventListener('abort', stop, { once: true });
		poll = setInterval(() => {
			try {
				assertActive();
			} catch {
				stop();
			}
		}, 100);
		reporter = setInterval(() => {
			try {
				report();
			} catch {
				stop();
			}
		}, 2000);
		report();
		await storageFilePool(
			deps,
			{ ...connection, signal: controller.signal },
			[...targets.values()],
			async (client, { target, digest, bytes }) => {
				clients.add(client);
				try {
					// Check intermediate directories as well as the final file without following links.
					const root = deps.storagePath(connection);
					const relative = target.slice(root === '/' ? 1 : root.length + 1).split('/');
					for (let index = 1; index <= relative.length; index++) {
						const current = deps.storagePath(connection, ...relative.slice(0, index));
						const info = await request(client, () =>
							storageRequest(client, () => client.lstat(current))
						);
						const file = index === relative.length;
						if (
							isType(info, 'isSymbolicLink', 'l') ||
							!isType(info, file ? 'isFile' : 'isDirectory', file ? '-' : 'd') ||
							(file && info.size !== bytes)
						)
							throw auditError();
						activity();
					}
					if (
						(await request(client, () =>
							deps.hashStorageFile(client, target, connection, {
								assertActive,
								onProgress: activity
							})
						)) !== digest
					)
						throw auditError();
					activity();
					state.checked++;
					state.verifiedBytes = Math.min(Number.MAX_SAFE_INTEGER, state.verifiedBytes + bytes);
				} catch {
					stop();
					throw auditError();
				}
			},
			assertActive
		);
		assertActive();
		// Report before committing so an observer failure or cancellation cannot publish verification.
		report();
		db.transaction(() => {
			for (const object of objects) {
				assertActive();
				const result = db
					.prepare(
						`UPDATE storage_file_objects SET verified_at=?
						WHERE destination=? AND object_key=? AND sha256=? AND remote_sha256=?
						AND bytes=? AND encrypted_bytes=? AND created_at=? AND verified_at=?
						AND backup_linked_at IS ?`
					)
					.run(
						now,
						destination,
						object.object_key,
						object.sha256,
						object.remote_sha256,
						object.bytes,
						object.encrypted_bytes,
						object.created_at,
						object.verified_at,
						object.backup_linked_at
					);
				if (result.changes !== 1) throw auditError();
			}
			assertActive();
		})();
		return snapshot();
	} catch {
		stop();
		throw auditError();
	} finally {
		clearInterval(poll);
		clearInterval(reporter);
		signal?.removeEventListener('abort', stop);
	}
}
