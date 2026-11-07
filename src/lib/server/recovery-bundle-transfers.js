import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileDigest } from './recovery-bundles.js';
import { uploadStorageFile } from './storage-upload.js';

/** Two encrypted spools maximum. Each transfer gets its own pinned transport session.
 * Legacy injected transports may return the coordinator client; those transfers are awaited
 * synchronously. Repeated injected worker clients are serialized for the entire put/hash pair.
 */
export function bundleTransfers(deps, connection, coordinator, work, assertOwned) {
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
			while (pending.size >= 2) {
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
				let sharedCoordinator = false;
				let task;
				let running;
				task = Promise.resolve()
					.then(() =>
						deps.withStorage(connection, (client) => {
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
									await uploadStorageFile(client, encrypted, target, connection);
									await assertOwned();
									if ((await deps.hashRemote(client, target, connection)) !== remoteSha256)
										throw new Error('Recovery bundle verification failed.');
									await assertOwned();
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
