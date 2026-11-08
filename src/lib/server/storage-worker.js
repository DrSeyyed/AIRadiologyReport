import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	getStorageSettings,
	getStorageConnection,
	storageDestination,
	MAX_STORAGE_PARALLEL_CONNECTIONS
} from './storage-settings.js';
import { withStorage, storagePath, hashRemote } from './storage-transport.js';
import { hashLocal } from './storage-audio.js';
import { syncStorageData } from './storage-sync.js';
import { uploadStorageFile } from './storage-upload.js';
import { backupRecovery, pruneRecovery } from './recovery-backups.js';
import { safeRecoveryProgress } from './recovery-progress.js';
import { prepareStorageRestore } from './storage-restore.js';
import { resetStorageData, storageResetFailureMessage } from './storage-reset.js';
import { auditStorageData, safeStorageAuditProgress } from './storage-audit.js';
import {
	deleteRecoveryPoints,
	validateBackupDeletionIds,
	safeBackupDeletionProgress
} from './storage-backup-deletion.js';

const uuidPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const backupIdPattern = new RegExp(`^\\d{1,16}-${uuidPattern}$`);
const restoreIdPattern = new RegExp(`^${uuidPattern}$`);

export function queueStorageJob(
	db,
	kind,
	{
		now = Math.floor(Date.now() / 1000),
		scheduleKey = null,
		retryNow = false,
		backupId = null
	} = {}
) {
	if (!['test', 'archive', 'full', 'restore'].includes(kind))
		throw new Error('Invalid storage job.');
	if (kind === 'restore' && (typeof backupId !== 'string' || !backupIdPattern.test(backupId)))
		throw new Error('Select a valid recovery point.');
	return db.transaction(() => {
		if (storageResetActive(db)) throw new Error('Wait for the storage reset to finish.');
		if (kind === 'restore' && activeMaintenance(db, 'delete'))
			throw new Error('Wait for backup deletion to finish before preparing a restore.');
		const settings = getStorageSettings(db);
		if (
			!['test', 'restore'].includes(kind) &&
			(!settings.enabled ||
				(kind === 'archive'
					? !settings.archiveEnabled && !settings.backupsEnabled
					: !settings.backupsEnabled))
		)
			throw new Error('Enable the selected storage service before requesting a job.');
		const existing = db
			.prepare(
				"SELECT id FROM storage_jobs WHERE kind = ? AND NOT EXISTS(SELECT 1 FROM storage_maintenance_requests m WHERE m.job_id=storage_jobs.id) AND (status IN ('pending','running') OR (status = 'failed' AND attempts < 8)) ORDER BY id DESC LIMIT 1"
			)
			.get(kind);
		if (existing) {
			if (db.prepare('SELECT 1 FROM storage_job_cancellations WHERE job_id=?').get(existing.id))
				throw new Error('Wait for cancellation to finish before requesting another job.');
			if (
				kind === 'restore' &&
				db
					.prepare('SELECT backup_id FROM storage_restore_requests WHERE job_id = ?')
					.get(existing.id)?.backup_id !== backupId
			)
				throw new Error('Wait for the existing restore preparation to finish.');
			if (retryNow)
				db.prepare("UPDATE storage_jobs SET retry_at = ? WHERE id = ? AND status = 'failed'").run(
					now,
					existing.id
				);
			return existing.id;
		}
		const result = db
			.prepare('INSERT OR IGNORE INTO storage_jobs(kind,schedule_key,created_at) VALUES(?,?,?)')
			.run(kind, scheduleKey, now);
		if (!result.changes) return null;
		const id = Number(result.lastInsertRowid);
		if (kind === 'restore')
			db.prepare('INSERT INTO storage_restore_requests(job_id,backup_id) VALUES(?,?)').run(
				id,
				backupId
			);
		return id;
	})();
}

function activeMaintenance(db, operation) {
	return db
		.prepare(
			`SELECT j.id,m.backup_ids,m.destination FROM storage_maintenance_requests m
		JOIN storage_jobs j ON j.id=m.job_id WHERE m.operation=? AND
		(j.status IN ('pending','running') OR (j.status='failed' AND j.attempts<8)) LIMIT 1`
		)
		.get(operation);
}

export function queueStorageMaintenance(
	db,
	operation,
	{ backupIds = null, now = Math.floor(Date.now() / 1000), retryNow = false } = {}
) {
	if (!['audit', 'delete'].includes(operation)) throw new Error('Invalid storage maintenance.');
	const ids =
		operation === 'delete' ? JSON.stringify(validateBackupDeletionIds(backupIds).sort()) : null;
	return db.transaction(() => {
		if (storageResetActive(db)) throw new Error('Wait for the storage reset to finish.');
		const destination = storageDestination(getStorageConnection(db));
		if (
			operation === 'delete' &&
			db
				.prepare(
					`SELECT 1 FROM storage_restore_requests r
			JOIN storage_jobs j ON j.id=r.job_id WHERE j.status IN ('pending','running') OR
			(j.status='failed' AND j.attempts<8) LIMIT 1`
				)
				.get()
		)
			throw new Error('Wait for restore preparation to finish before deleting backups.');
		const existing = activeMaintenance(db, operation);
		if (existing) {
			if (
				existing.backup_ids !== ids ||
				existing.destination !== destination ||
				db.prepare('SELECT 1 FROM storage_job_cancellations WHERE job_id=?').get(existing.id)
			)
				throw new Error('Wait for the existing maintenance job or cancel it first.');
			if (retryNow)
				db.prepare("UPDATE storage_jobs SET retry_at=? WHERE id=? AND status='failed'").run(
					now,
					existing.id
				);
			return existing.id;
		}
		// Side-table operations preserve compatibility with the deployed storage_jobs CHECK constraint.
		const id = Number(
			db.prepare("INSERT INTO storage_jobs(kind,created_at) VALUES('restore',?)").run(now)
				.lastInsertRowid
		);
		db.prepare(
			'INSERT INTO storage_maintenance_requests(job_id,operation,destination,backup_ids) VALUES(?,?,?,?)'
		).run(id, operation, destination, ids);
		return id;
	})();
}

export function storageResetActive(db) {
	return Boolean(
		db
			.prepare(
				`SELECT 1 FROM storage_reset_requests r JOIN storage_jobs j ON j.id=r.job_id
		WHERE j.status IN ('pending','running') OR (j.status='failed' AND j.attempts<8) LIMIT 1`
			)
			.get()
	);
}

export function clearStorageJobLog(db) {
	return db
		.prepare(
			`INSERT OR IGNORE INTO storage_job_log_hidden(job_id)
		SELECT id FROM storage_jobs WHERE status='succeeded' OR (status='failed' AND attempts>=8)`
		)
		.run().changes;
}

export function queueStorageReset(db, { now = Math.floor(Date.now() / 1000) } = {}) {
	return db.transaction(() => {
		if (
			storageResetActive(db) ||
			db.prepare("SELECT 1 FROM storage_jobs WHERE status='running' LIMIT 1").get()
		)
			throw new Error('Pause jobs and wait for running work to stop before resetting storage.');
		getStorageConnection(db);
		pauseAndCancelStorageJobs(db, { now });
		// Reuse the deployed restore job kind; the side table identifies destructive maintenance.
		const id = Number(
			db.prepare("INSERT INTO storage_jobs(kind,created_at) VALUES('restore',?)").run(now)
				.lastInsertRowid
		);
		db.prepare('INSERT INTO storage_reset_requests(job_id) VALUES(?)').run(id);
		return id;
	})();
}

function finishCancelledJob(db, id, now) {
	db.prepare(
		"UPDATE storage_jobs SET status='failed',attempts=8,finished_at=?,retry_at=0,result=CASE WHEN EXISTS(SELECT 1 FROM storage_maintenance_requests m WHERE m.job_id=storage_jobs.id) THEN result ELSE NULL END,error=CASE WHEN EXISTS(SELECT 1 FROM storage_maintenance_requests m WHERE m.job_id=storage_jobs.id AND m.operation='delete') THEN 'Cancelled by administrator. Deletion may be partial; reload recovery points. Shared file objects were retained.' ELSE 'Cancelled by administrator.' END WHERE id=? AND status IN ('pending','running','failed')"
	).run(now, id);
}

export function cancelStorageJob(db, id, { now = Math.floor(Date.now() / 1000) } = {}) {
	if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid storage job.');
	return db.transaction(() => {
		const job = db.prepare('SELECT status,attempts FROM storage_jobs WHERE id=?').get(id);
		if (!job || job.status === 'succeeded' || (job.status === 'failed' && job.attempts >= 8))
			return false;
		db.prepare(
			'INSERT OR IGNORE INTO storage_job_cancellations(job_id,requested_at) VALUES(?,?)'
		).run(id, now);
		if (job.status !== 'running') finishCancelledJob(db, id, now);
		return true;
	})();
}

export function pauseAndCancelStorageJobs(db, { now = Math.floor(Date.now() / 1000) } = {}) {
	return db.transaction(() => {
		db.prepare(
			"INSERT INTO application_settings(key,value) VALUES('storage_settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
		).run(JSON.stringify({ ...getStorageSettings(db), enabled: false }));
		const jobs = db
			.prepare(
				"SELECT id FROM storage_jobs WHERE status IN ('pending','running') OR (status='failed' AND attempts < 8)"
			)
			.all();
		for (const job of jobs) cancelStorageJob(db, job.id, { now });
		return jobs.length;
	})();
}

function archiveProgress(progress) {
	const fields = ['copied', 'evicted', 'preparing', 'uploading', 'verifying', 'lastActivityAt'];
	if (
		!progress ||
		!fields.every((field) => Number.isSafeInteger(progress[field]) && progress[field] >= 0)
	)
		return null;
	if (
		progress.preparing + progress.uploading + progress.verifying >
		MAX_STORAGE_PARALLEL_CONNECTIONS
	)
		return null;
	const verificationBytes =
		progress.verificationBytes === undefined ? 0 : progress.verificationBytes;
	if (!Number.isSafeInteger(verificationBytes) || verificationBytes < 0) return null;
	return {
		...Object.fromEntries(fields.map((field) => [field, progress[field]])),
		verificationBytes
	};
}

function archiveBacklog(db) {
	return db
		.prepare(
			`SELECT COUNT(*) AS count FROM (
		SELECT audio_report_path AS path FROM study_recordings WHERE audio_report_path IS NOT NULL
		UNION SELECT audio_report_path FROM recording_audio_parts
	) refs LEFT JOIN storage_audio a ON a.path = refs.path WHERE a.path IS NULL`
		)
		.get().count;
}

function retireDatabaseJobs(db, now) {
	db.prepare(
		"UPDATE storage_jobs SET status='failed',attempts=8,finished_at=?,retry_at=0,result=NULL,error='Legacy database snapshot retired; use full recovery backups.' WHERE kind='database' AND (status='pending' OR (status='failed' AND attempts<8))"
	).run(now);
}

function fullBackupSlots(hours, now) {
	const day = Math.floor(now / 86400) * 86400;
	const slots = hours.map((hour) => day + hour * 3600);
	return {
		due: slots.findLast((slot) => slot <= now) ?? slots.at(-1) - 86400,
		next: slots.find((slot) => slot > now) ?? slots[0] + 86400
	};
}

export function scheduleStorageJobs(db, now = Math.floor(Date.now() / 1000)) {
	retireDatabaseJobs(db, now);
	const settings = getStorageSettings(db);
	if (!settings.enabled) return;
	if (settings.archiveEnabled || settings.backupsEnabled) {
		// Persist the window's starting minute, retaining existing one-minute schedule keys.
		const minute =
			Math.floor(now / (settings.syncIntervalMinutes * 60)) * settings.syncIntervalMinutes;
		queueStorageJob(db, 'archive', { now, scheduleKey: `archive:${minute}` });
	}
	if (settings.backupsEnabled) {
		const { due } = fullBackupSlots(settings.fullBackupHours, now);
		queueStorageJob(db, 'full', { now, scheduleKey: `full:${due}` });
	}
}

export async function testStorageConnection(connection, transport = withStorage) {
	const directory = await mkdtemp(join(tmpdir(), 'radiology-storage-test-'));
	const name = `.connection-test-${randomUUID()}`;
	try {
		const local = join(directory, 'probe');
		await writeFile(local, randomUUID(), { mode: 0o600 });
		return await transport(connection, async (client) => {
			await client.mkdir(connection.root, true);
			const remote = storagePath(connection, name);
			try {
				await uploadStorageFile(client, local, remote, connection);
				if ((await hashRemote(client, remote, connection)) !== (await hashLocal(local)))
					throw new Error('Storage read/write verification failed.');
				return { verified: true };
			} finally {
				await client.delete(remote, true);
			}
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export async function processStorageJob(
	db,
	{
		now = Math.floor(Date.now() / 1000),
		runArchive = syncStorageData,
		runBackup = backupRecovery,
		prepareRestore = prepareStorageRestore,
		resetStorage = resetStorageData,
		runAudit = auditStorageData,
		deleteBackups = deleteRecoveryPoints,
		prune = pruneRecovery,
		testConnection = testStorageConnection,
		heartbeatMs = 10_000
	} = {}
) {
	retireDatabaseJobs(db, now);
	if (
		!getStorageSettings(db).enabled &&
		!db
			.prepare(
				"SELECT 1 FROM storage_jobs WHERE (kind IN ('test','restore') AND (status IN ('pending','running') OR (status = 'failed' AND attempts < 8))) OR (status='running' AND EXISTS(SELECT 1 FROM storage_job_cancellations c WHERE c.job_id=storage_jobs.id)) LIMIT 1"
			)
			.get()
	)
		return false;
	const owner = randomUUID();
	const claimed = db.transaction(() => {
		const lock = db.prepare('SELECT * FROM storage_worker_lock WHERE id = 1').get();
		if (lock && lock.expires_at > now) return false;
		db.prepare(
			'INSERT INTO storage_worker_lock(id,owner,expires_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at'
		).run(owner, now + 600);
		for (const interrupted of db
			.prepare(
				"SELECT id FROM storage_jobs WHERE status='running' AND EXISTS(SELECT 1 FROM storage_job_cancellations c WHERE c.job_id=storage_jobs.id)"
			)
			.all())
			finishCancelledJob(db, interrupted.id, now);
		db.prepare(
			"UPDATE storage_jobs SET status = 'failed', retry_at = ?, error = CASE WHEN attempts>=8 THEN 'Previous worker stopped or its lease expired; retry limit reached.' ELSE 'Previous worker stopped or its lease expired; retrying.' END WHERE status = 'running'"
		).run(now);
		return true;
	})();
	if (!claimed) return false;
	let job;
	let maintenance;
	const leaseOwned = () =>
		db.prepare('SELECT owner FROM storage_worker_lock WHERE id = 1').get()?.owner === owner;
	const cancelled = () =>
		Boolean(
			job && db.prepare('SELECT 1 FROM storage_job_cancellations WHERE job_id=?').get(job.id)
		);
	const owned = () => leaseOwned() && !cancelled();
	const heartbeat = setInterval(() => {
		try {
			db.prepare('UPDATE storage_worker_lock SET expires_at = ? WHERE id = 1 AND owner = ?').run(
				Math.floor(Date.now() / 1000) + 600,
				owner
			);
		} catch {
			/* The lease expires if the database becomes unavailable. */
		}
	}, heartbeatMs);
	heartbeat.unref();
	try {
		scheduleStorageJobs(db, now);
		const settings = getStorageSettings(db);
		job = db
			.prepare(
				`SELECT * FROM storage_jobs WHERE (status = 'pending' OR (status = 'failed' AND attempts < 8)) AND retry_at <= ?
			AND (kind IN ('test','restore') OR (? = 1 AND ((kind = 'archive' AND ? = 1) OR (kind = 'full' AND ? = 1))))
			ORDER BY CASE kind WHEN 'test' THEN 0 WHEN 'restore' THEN 1 ELSE 2 END,
			COALESCE((SELECT MAX(previous.started_at) FROM storage_jobs previous WHERE previous.kind=storage_jobs.kind),0),
			CASE kind WHEN 'full' THEN 0 ELSE 1 END, created_at, id LIMIT 1`
			)
			.get(
				now,
				+settings.enabled,
				+(settings.archiveEnabled || settings.backupsEnabled),
				+settings.backupsEnabled
			);
		if (!job) return false;
		db.prepare(
			"UPDATE storage_jobs SET status='running',started_at=?,finished_at=NULL,attempts=attempts+1,error=NULL,result=NULL WHERE id=?"
		).run(now, job.id);
		maintenance = db
			.prepare('SELECT * FROM storage_maintenance_requests WHERE job_id=?')
			.get(job.id);
		const connection = getStorageConnection(db);
		let result;
		if (maintenance) {
			if (maintenance.destination !== storageDestination(connection))
				throw new Error('Storage destination changed.');
			const sanitize =
				maintenance.operation === 'audit' ? safeStorageAuditProgress : safeBackupDeletionProgress;
			const onProgress = (progress) => {
				if (!owned()) throw new Error('Storage maintenance stopped.');
				const safe = sanitize(progress);
				if (safe)
					db.prepare("UPDATE storage_jobs SET result=? WHERE id=? AND status='running'").run(
						JSON.stringify(safe),
						job.id
					);
			};
			if (maintenance.operation === 'audit') {
				result = sanitize(await runAudit(db, connection, { now, owned, onProgress }));
			} else {
				const backupIds = validateBackupDeletionIds(JSON.parse(maintenance.backup_ids));
				result = sanitize(
					await deleteBackups(connection, {
						backupIds,
						plan: maintenance.plan ? JSON.parse(maintenance.plan) : null,
						owned,
						onProgress,
						onPlan(plan) {
							if (!owned()) throw new Error('Storage maintenance stopped.');
							if (
								!Array.isArray(plan) ||
								plan.length !== backupIds.length ||
								plan.some(
									(point, i) =>
										point?.id !== backupIds[i] || !['full', 'database'].includes(point.kind)
								)
							)
								throw new Error('Invalid backup deletion plan.');
							db.transaction(() => {
								db.prepare('UPDATE storage_maintenance_requests SET plan=? WHERE job_id=?').run(
									JSON.stringify(plan),
									job.id
								);
								const record = db.prepare(
									'INSERT OR IGNORE INTO storage_deleted_recovery_points(backup_id,deleted_at) VALUES(?,?)'
								);
								for (const point of plan) record.run(point.id, Math.floor(Date.now() / 1000));
							})();
						}
					})
				);
			}
			if (
				!result ||
				(maintenance.operation === 'audit'
					? result.checked !== result.total
					: result.deleted !== result.total)
			)
				throw new Error('Invalid storage maintenance result.');
		} else if (job.kind === 'test') result = await testConnection(connection);
		else if (db.prepare('SELECT 1 FROM storage_reset_requests WHERE job_id=?').get(job.id)) {
			result = await resetStorage(db, connection, { jobId: job.id, owned });
		} else if (job.kind === 'restore') {
			const request = db
				.prepare('SELECT backup_id FROM storage_restore_requests WHERE job_id = ?')
				.get(job.id);
			if (!request || !backupIdPattern.test(request.backup_id))
				throw new Error('Invalid restore request.');
			result = await prepareRestore(connection, { backupId: request.backup_id, owned });
			if (!restoreIdPattern.test(result?.restoreId)) throw new Error('Invalid restore result.');
		} else if (job.kind === 'archive')
			result = await runArchive(db, connection, {
				now,
				owned,
				onProgress(progress) {
					if (!owned()) return;
					const safe = archiveProgress(progress);
					if (safe)
						db.prepare("UPDATE storage_jobs SET result=? WHERE id=? AND status='running'").run(
							JSON.stringify(safe),
							job.id
						);
				}
			});
		else {
			let latestProgress;
			const onProgress = (progress) => {
				if (!owned()) return;
				const safe = safeRecoveryProgress(progress);
				if (!safe) return;
				latestProgress = safe;
				db.prepare("UPDATE storage_jobs SET result=? WHERE id=? AND status='running'").run(
					JSON.stringify(safe),
					job.id
				);
			};
			result = await runBackup(db, connection, { kind: job.kind, now, owned, onProgress });
			if (!owned()) throw new Error('Storage worker lease expired.');
			if (latestProgress)
				onProgress({
					...latestProgress,
					phase: 'pruning',
					lastActivityAt: Math.floor(Date.now() / 1000)
				});
			await prune(connection, settings, now);
		}
		if (!owned()) throw new Error('Storage worker lease expired.');
		db.transaction(() => {
			const finished = Math.max(now, Math.floor(Date.now() / 1000));
			const completed = db
				.prepare(
					"UPDATE storage_jobs SET status='succeeded',finished_at=?,result=?,error=NULL WHERE id=? AND status='running' AND NOT EXISTS(SELECT 1 FROM storage_job_cancellations c WHERE c.job_id=storage_jobs.id)"
				)
				.run(finished, JSON.stringify(result ?? {}), job.id);
			if (!completed.changes) throw new Error('Storage job no longer active.');
			const current = getStorageSettings(db);
			if (
				job.kind === 'archive' &&
				current.enabled &&
				(current.archiveEnabled || current.backupsEnabled) &&
				((Number.isSafeInteger(result?.syncPending) && result.syncPending > 0) ||
					(result?.syncPending === undefined && result?.copied > 0 && archiveBacklog(db) > 0))
			)
				queueStorageJob(db, 'archive', { now: finished });
		})();
		db.prepare(
			"DELETE FROM storage_jobs WHERE kind IN ('archive','test') AND status='succeeded' AND finished_at < ?"
		).run(now - 7 * 86400);
		return true;
	} catch (error) {
		if (job && owned()) {
			const finished = Math.max(now, Math.floor(Date.now() / 1000));
			db.prepare(
				"UPDATE storage_jobs SET status='failed',finished_at=?,retry_at=?,error=? WHERE id=?"
			).run(
				finished,
				finished + Math.min(3600, 60 * 2 ** Math.min(job.attempts, 6)),
				db.prepare('SELECT 1 FROM storage_reset_requests WHERE job_id=?').get(job.id)
					? `Storage reset stopped. ${storageResetFailureMessage(error)} Recovered local files were preserved; remote cleanup may be partial if it had already started. Retry or cancel this reset before starting another.`
					: maintenance
						? maintenance.operation === 'audit'
							? 'Checksum audit stopped. Check storage connectivity, the saved destination, and missing, changed or corrupted encrypted objects. No files were deleted or replaced.'
							: 'Backup deletion stopped. Some selected points may already be removed. Retry the same selection or cancel and reload the list. Shared file objects and live data were retained.'
						: job.kind === 'restore'
							? 'Restore preparation failed. Check the encryption key, storage connection, selected recovery point and available disk space. The live database, audio and recovery points were not replaced.'
							: 'Storage job failed. Check credentials, pinned host fingerprint, connectivity, free space and source availability. Local audio and existing recovery points were preserved.',
				job.id
			);
		}
		return Boolean(job);
	} finally {
		clearInterval(heartbeat);
		try {
			if (job && leaseOwned() && cancelled())
				finishCancelledJob(db, job.id, Math.floor(Date.now() / 1000));
		} finally {
			db.prepare('DELETE FROM storage_worker_lock WHERE id=1 AND owner=?').run(owner);
		}
	}
}

let worker;
export function startStorageWorker(getDb) {
	if (worker) return;
	let busy = false;
	worker = setInterval(async () => {
		if (busy) return;
		busy = true;
		try {
			await processStorageJob(getDb());
		} catch {
			console.warn('Storage jobs unavailable; retrying later.');
		} finally {
			busy = false;
		}
	}, 15_000);
	worker.unref();
}

export function storageStatus(db, now = Math.floor(Date.now() / 1000)) {
	const settings = getStorageSettings(db);
	const last = db
		.prepare(
			"SELECT kind,MAX(started_at) AS at FROM storage_jobs WHERE status = 'succeeded' AND NOT EXISTS(SELECT 1 FROM storage_reset_requests r WHERE r.job_id=storage_jobs.id) AND NOT EXISTS(SELECT 1 FROM storage_maintenance_requests m WHERE m.job_id=storage_jobs.id) GROUP BY kind"
		)
		.all();
	const jobs = db
		.prepare(
			`SELECT id,kind,status,created_at,started_at,finished_at,retry_at,attempts,error,result,
			EXISTS(SELECT 1 FROM storage_job_cancellations c WHERE c.job_id=storage_jobs.id) AS cancelRequested,
			(SELECT operation FROM storage_maintenance_requests m WHERE m.job_id=storage_jobs.id) AS maintenance,
			(SELECT phase||': audio '||restored||'/'||total||', remote files removed '||deleted FROM storage_reset_requests r WHERE r.job_id=storage_jobs.id) AS progress
			FROM storage_jobs WHERE NOT EXISTS(SELECT 1 FROM storage_job_log_hidden h WHERE h.job_id=storage_jobs.id) ORDER BY id DESC LIMIT 30`
		)
		.all()
		.map(({ result, cancelRequested, maintenance, ...job }) => {
			const displayedKind =
				maintenance || (job.kind === 'restore' && job.progress ? 'reset' : job.kind);
			let backupId = null;
			let restoreDirectory = null;
			try {
				const parsed = JSON.parse(result);
				if (maintenance === 'audit') {
					const progress = safeStorageAuditProgress(parsed);
					if (progress)
						job.progress = `Checksums: ${progress.checked}/${progress.total}; verified: ${(progress.verifiedBytes / (1024 * 1024)).toFixed(2)} MiB; elapsed: ${progress.elapsedSeconds}s. Last checksum activity: ${Math.max(0, now - progress.lastActivityAt)}s ago.`;
				} else if (maintenance === 'delete') {
					const progress = safeBackupDeletionProgress(parsed);
					if (progress)
						job.progress = `Recovery points removed: ${progress.deleted}/${progress.total}. Shared file objects retained.`;
				}
				if (
					job.kind === 'archive' &&
					Number.isSafeInteger(parsed?.copied) &&
					parsed.copied >= 0 &&
					Number.isSafeInteger(parsed.evicted) &&
					parsed.evicted >= 0
				) {
					job.progress = `Copied: ${parsed.copied}; evicted: ${parsed.evicted}.`;
					const progress = archiveProgress(parsed);
					if (progress && job.status === 'running')
						job.progress += ` Preparing: ${progress.preparing}; uploading: ${progress.uploading}; verifying: ${progress.verifying}. Checksum verification: ${(progress.verificationBytes / (1024 * 1024)).toFixed(2)} MiB. Last transfer/file activity: ${Math.max(0, now - progress.lastActivityAt)}s ago.`;
				}
				if (['database', 'full'].includes(job.kind)) {
					const progress = safeRecoveryProgress(parsed);
					if (progress) {
						job.progress = `Files collected: ${progress.files}/${progress.totalFiles}; objects verified: ${progress.uploadedObjects + progress.reusedObjects}/${progress.bundles}; uploaded: ${progress.uploadedObjects}; reused: ${progress.reusedObjects}.`;
						if (job.status === 'running')
							job.progress += ` Phase: ${progress.phase}; uploading: ${progress.uploading}; verifying: ${progress.verifying}. Uploaded: ${(progress.uploadedBytes / (1024 * 1024)).toFixed(2)} MiB; verified on storage: ${(progress.verificationBytes / (1024 * 1024)).toFixed(2)} checksum MiB. Last transfer/file activity: ${Math.max(0, now - progress.lastActivityAt)}s ago.`;
					} else if (
						['files', 'bytes', 'uploadedObjects', 'reusedObjects'].every(
							(field) => Number.isSafeInteger(parsed?.[field]) && parsed[field] >= 0
						)
					) {
						job.progress = `Files: ${parsed.files}; objects uploaded and verified: ${parsed.uploadedObjects}; reused: ${parsed.reusedObjects}; source data: ${(parsed.bytes / (1024 * 1024)).toFixed(2)} MiB.`;
					}
				}
				if (!maintenance && typeof parsed?.id === 'string' && backupIdPattern.test(parsed.id))
					backupId = parsed.id;
				if (
					!maintenance &&
					job.kind === 'restore' &&
					job.status === 'succeeded' &&
					typeof parsed?.restoreId === 'string' &&
					restoreIdPattern.test(parsed.restoreId)
				)
					restoreDirectory = `restore-staging/${parsed.restoreId}`;
			} catch {
				/* Incomplete jobs have no recovery identifier. */
			}
			return {
				...job,
				kind: displayedKind,
				status: cancelRequested
					? job.status === 'running'
						? 'cancelling'
						: 'cancelled'
					: job.status,
				canCancel:
					!cancelRequested &&
					(['pending', 'running'].includes(job.status) ||
						(job.status === 'failed' && job.attempts < 8)),
				backupId,
				restoreDirectory
			};
		});
	const preparedRestores = db
		.prepare(
			"SELECT id,finished_at,result FROM storage_jobs WHERE kind='restore' AND status='succeeded' AND NOT EXISTS(SELECT 1 FROM storage_maintenance_requests m WHERE m.job_id=storage_jobs.id) ORDER BY id DESC LIMIT 10"
		)
		.all()
		.flatMap(({ result, ...job }) => {
			try {
				const restoreId = JSON.parse(result)?.restoreId;
				return typeof restoreId === 'string' && restoreIdPattern.test(restoreId)
					? [{ ...job, directory: `restore-staging/${restoreId}` }]
					: [];
			} catch {
				return [];
			}
		});
	const backlog = archiveBacklog(db);
	const archived = db
		.prepare(
			'SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes, COALESCE(SUM(evicted_at IS NOT NULL),0) AS evicted FROM storage_audio'
		)
		.get();
	const { next: nextFull } = fullBackupSlots(settings.fullBackupHours, now);
	return {
		last,
		jobs,
		preparedRestores,
		archived,
		backlog,
		nextFull,
		resetActive: storageResetActive(db)
	};
}
