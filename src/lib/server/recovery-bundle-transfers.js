import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileDigest } from './recovery-bundles.js';
import { uploadStorageFile } from './storage-upload.js';
import { storageParallelConnections } from './storage-settings.js';

/** Reserve the coordinator's slot while producing bundles; use it synchronously when workers
 * fill the other slots. Shared injected clients serialize the complete upload/check pair.
 */
export function bundleTransfers(deps, connection, coordinator, work, assertOwned, progress) {
	const concurrency = storageParallelConnections(connection);
	const pending = new Set();
	const byDigest = new Map();
	const clients = new WeakMap();
	let failure;
	const assertHealthy = () => {
		if (failure) throw failure;
	};
	return {
		async upload(source, info) {
			assertHealthy();
			while (pending.size >= concurrency) {
				await Promise.race(pending);
				assertHealthy();
			}
			await assertOwned();
			const encrypted = path.join(work, `${randomUUID()}.bundle.enc`);
			let scheduled = false;
			try {
				await deps.encryptFile(source, encrypted);
				const remoteSha256 = await fileDigest(encrypted);
				assertHealthy();
				await assertOwned();
				const object = `${remoteSha256}.enc`;
				const target = deps.storagePath(connection, 'backups', 'objects', object);
				let ready;
				const connected = new Promise((resolve) => {
					ready = resolve;
				});
				const useCoordinator = pending.size >= concurrency - 1;
				const withClient = useCoordinator
					? (_connection, callback) => callback(coordinator)
					: deps.withStorage.bind(deps);
				let sharedCoordinator = useCoordinator;
				let task;
				let running;
				task = Promise.resolve()
					.then(() =>
						withClient(connection, (client) => {
							if (failure) return Promise.reject(failure);
							running = (async () => {
								const previous = clients.get(client) || Promise.resolve();
								let release;
								clients.set(
									client,
									new Promise((resolve) => {
										release = resolve;
									})
								);
								sharedCoordinator = client === coordinator;
								ready();
								await previous;
								try {
									assertHealthy();
									await assertOwned();
									await progress.track('uploading', () =>
										uploadStorageFile(client, encrypted, target, connection, {
											onProgress: (bytes) => progress.add('uploadedBytes', bytes)
										})
									);
									await assertOwned();
									if ((await deps.hashRemote(client, target, connection)) !== remoteSha256)
										throw new Error('Recovery bundle verification failed.');
									await assertOwned();
									progress.add('uploadedObjects');
								} finally {
									release();
								}
							})();
							return running;
						})
					)
					.catch((error) => {
						failure ||= error;
					})
					.then(async () => {
						await running?.catch((error) => {
							failure ||= error;
						});
						try {
							await fs.rm(encrypted, { force: true });
						} catch (error) {
							failure ||= error;
						}
						pending.delete(task);
						ready();
					});
				pending.add(task);
				byDigest.set(info.sha256, task);
				scheduled = true;
				await connected;
				if (sharedCoordinator) await task;
				assertHealthy();
				return { object, remoteSha256 };
			} finally {
				if (!scheduled) await fs.rm(encrypted, { force: true });
			}
		},
		async wait(digest) {
			await byDigest.get(digest);
			assertHealthy();
		},
		async finish() {
			await Promise.all(pending);
			assertHealthy();
		},
		async settle() {
			await Promise.all(pending);
		}
	};
}
