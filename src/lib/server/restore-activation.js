import path from 'node:path';
import fs, { lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { isStorageRestoreId } from './storage-restore.js';
import { getStorageConnection } from './storage-settings.js';
import { restoreActivation } from './restore-activation-runtime.js';
import { stageIntegrationRestore } from './integration-backup.js';
import { validateIntegrationRestoreSelection } from './integration-restore-admin.js';

export async function activatePreparedRestore(db, { jobId, userId, integrationFields = [] }, {
	cwd = process.cwd(), activate = (options) => restoreActivation.activate(options), stage = stageIntegrationRestore
} = {}) {
	const fields = validateIntegrationRestoreSelection(integrationFields);
	if (!Number.isSafeInteger(jobId) || jobId < 1 || !Number.isSafeInteger(userId) || userId < 1)
		throw new Error('Select a verified restore.');
	const result = db.prepare(
		"SELECT result FROM storage_jobs WHERE id=? AND kind='restore' AND status='succeeded' AND NOT EXISTS(SELECT 1 FROM storage_maintenance_requests m WHERE m.job_id=storage_jobs.id)"
	).get(jobId);
	if (!result) throw new Error('Select a verified restore.');
	const saved = JSON.parse(result.result);
	if (!isStorageRestoreId(saved.restoreId) || typeof saved.id !== 'string')
		throw new Error('Select a verified restore.');
	return activate({
		restoreId: saved.restoreId,
		backupId: saved.id,
		requestedBy: userId,
		validate: () => {
			if (db.prepare("SELECT 1 FROM storage_jobs WHERE status='running' LIMIT 1").get())
				throw new Error('Wait for running storage jobs to finish.');
			const preparedDatabase = path.join(cwd, 'restore-staging', saved.restoreId, 'db', 'pacs.db');
			for (const suffix of ['-wal', '-shm', '-journal']) {
				try { lstatSync(`${preparedDatabase}${suffix}`); }
				catch (error) { if (error.code === 'ENOENT') continue; throw error; }
				throw Object.assign(new Error('Prepare a fresh verified restore; the prepared database has SQLite journal files.'),
					{ code: 'RESTORE_PREPARED_DATABASE_HAS_JOURNALS' });
			}
			if (saved.audioMode === 'remote' && saved.remoteAudioFiles > 0) {
				let target = cwd;
				for (const part of ['restore-staging', saved.restoreId, 'db', 'pacs.db']) {
					target = path.join(target, part);
					const stat = lstatSync(target);
					if (stat.isSymbolicLink() || (part === 'pacs.db' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()))
						throw new Error('Unsafe prepared restore path.');
				}
				// Even read-only SQLite connections can create WAL/SHM files. Never open the prepared source.
				const scratch = fs.mkdtempSync(path.join(tmpdir(), 'arr-restore-credentials-'));
				let restored;
				try {
					if (process.platform !== 'win32' && (lstatSync(scratch).mode & 0o777) !== 0o700)
						throw new Error('Private restore validation directory required.');
					const copy = path.join(scratch, 'pacs.db');
					fs.copyFileSync(target, copy, fs.constants.COPYFILE_EXCL);
					restored = new Database(copy, { readonly: true, fileMustExist: true });
					if (!getStorageConnection(restored).password) throw new Error('Original encryption key required.');
				} finally {
					try { restored?.close(); }
					finally { fs.rmSync(scratch, { recursive: true, force: true }); }
				}
			}
			stage(path.join(cwd, 'restore-staging', saved.restoreId), { backupId: saved.id, fields });
		}
	});
}
