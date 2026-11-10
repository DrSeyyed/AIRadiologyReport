import { storageFilePool } from './storage-file-pool.js';

export async function verifyRecoveryArchives(deps, connection, coordinator, archives, assertOwned) {
	await storageFilePool(
		deps,
		connection,
		[...archives],
		async (client, archive) => {
			if (
				(await deps.hashRemote(
					client,
					deps.storagePath(connection, 'audio', archive.object_key),
					connection
				)) !== archive.remote_sha256
			)
				throw new Error('Recovery archive changed.');
		},
		assertOwned,
		coordinator
	);
}
