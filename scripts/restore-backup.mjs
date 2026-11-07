#!/usr/bin/env node
/**
 * Offline, new-directory recovery. Download one backups/manifests/<id>.enc and the
 * backups/objects directory using a trusted SFTP client; never execute a remote restore.
 * Set STORAGE_ENCRYPTION_KEY to the original base64 32-byte key (keep it separately).
 * Remote layout beneath connection.root (POSIX):
 *   backups/indexes/<unix-seconds>-<uuid>.<database|full>.json  (completion marker)
 *   backups/manifests/<unix-seconds>-<uuid>.enc               (encrypted manifest)
 *   backups/objects/<ciphertext-sha256>.enc                  (shared encrypted payloads)
 *   audio/<uuid>.enc                                        (independent archive; not needed to restore)
 * Ignore backups/indexes/*.pending and manifests without a completed index.
 * Only STORAGE_ENCRYPTION_KEY is required at restore time; no SSH/provider environment is used.
 * node scripts/restore-backup.mjs --manifest <file.enc> --objects <directory> --output <new-empty-directory>
 * Legacy database snapshots include all referenced audio/reports. New full recovery points also include
 * upload extras/templates, using individual encrypted objects (legacy bundles remain supported). Relative uploads paths are preserved; custom VOICE_SAVE_DIR
 * files map to voice/. All recording audio/report database paths become app-root-relative,
 * including formerly absolute paths, so the restored tree can be promoted to another app root.
 * Output: db/pacs.db, uploads/... and/or voice/..., environment.json, and .env if originally present.
 * storage_audio rows are removed, not merely marked unevicted: restored media is entirely local.
 * Synchronization queue/catalog/object tracking is cleared so stale remote versions cannot be reused.
 * Storage enabled/archiveEnabled/backupsEnabled are reset to false. storage_jobs history and
 * storage_worker_lock leases are cleared, including succeeded remote-backup metadata. Connection
 * settings and encrypted credentials are preserved for admin review, never automatically enabled.
 * Stop the target app; preserve its old data separately; place restored db/uploads/voice beneath
 * its root; set its working directory to that root. Never merge old database/WAL or uploads data.
 * Apply the allowlisted environment.json values to deployment settings (it is not auto-loaded),
 * using the relocated VOICE_SAVE_DIR value; restore .env only after reviewing deployment values.
 * Configure provider credentials separately and disable/reconfigure storage workers before startup.
 * Verify local reports/audio, then start the new deployment. No original audio archive is needed.
 * .env/environment.json preserve only APP_ENV_KEYS (see recovery-backups.js); supply provider
 * credentials separately. Restored .env is private. No SSH credentials or live database needed.
 * Retention removes manifests/indexes only, not shared objects or independent audio archives.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { restoreRecovery } from '../src/lib/server/recovery-backups.js';
export { restoreRecovery };

async function main() {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === '--help') {
		console.log(
			'Offline recovery: --manifest <file.enc> --objects <directory> --output <new-empty-directory>\nRequires STORAGE_ENCRYPTION_KEY. Custom voice files restore under voice/. Provider credentials must be configured separately.'
		);
		return;
	}
	const values = {};
	for (let i = 0; i < args.length; i += 2) {
		if (
			!['--manifest', '--objects', '--output'].includes(args[i]) ||
			!args[i + 1] ||
			values[args[i]]
		)
			throw new Error();
		values[args[i]] = args[i + 1];
	}
	if (Object.keys(values).length !== 3) throw new Error();
	const result = await restoreRecovery({
		manifestFile: values['--manifest'],
		objectsDirectory: values['--objects'],
		outputDirectory: values['--output']
	});
	console.log(
		`Recovery completed: ${result.files} files. Configure credentials and application paths before starting the application.`
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch(() => {
		console.error(
			'Recovery failed. Check arguments, storage key, downloaded objects, and an empty output directory.'
		);
		process.exitCode = 1;
	});
}
