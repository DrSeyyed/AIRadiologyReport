import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getStorageSettings, getStorageConnection } from './storage-settings.js';
import { withStorage, storagePath, hashRemote } from './storage-transport.js';
import { archiveAudio, hashLocal } from './storage-audio.js';
import { backupRecovery, pruneRecovery } from './recovery-backups.js';
import { prepareStorageRestore } from './storage-restore.js';

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
	if (!['test', 'archive', 'database', 'full', 'restore'].includes(kind))
		throw new Error('Invalid storage job.');
	if (kind === 'restore' && (typeof backupId !== 'string' || !backupIdPattern.test(backupId)))
		throw new Error('Select a valid recovery point.');
	return db.transaction(() => {
		const settings = getStorageSettings(db);
		if (
			!['test', 'restore'].includes(kind) &&
			(!settings.enabled ||
				(kind === 'archive' ? !settings.archiveEnabled : !settings.backupsEnabled))
		)
			throw new Error('Enable the selected storage service before requesting a job.');
		const existing = db
			.prepare(
				"SELECT id FROM storage_jobs WHERE kind = ? AND (status IN ('pending','running') OR (status = 'failed' AND attempts < 8)) ORDER BY id DESC LIMIT 1"
			)
			.get(kind);
		if (existing) {
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

export function scheduleStorageJobs(db, now = Math.floor(Date.now() / 1000)) {
	const settings = getStorageSettings(db);
	if (!settings.enabled) return;
	if (settings.archiveEnabled)
		queueStorageJob(db, 'archive', { now, scheduleKey: `archive:${Math.floor(now / 60)}` });
	if (settings.backupsEnabled) {
		queueStorageJob(db, 'database', {
			now,
			scheduleKey: `database:${settings.databaseIntervalHours}:${Math.floor(now / (settings.databaseIntervalHours * 3600))}`
		});
		const day = Math.floor((now - settings.fileBackupHour * 3600) / 86400);
		queueStorageJob(db, 'full', { now, scheduleKey: `full:${settings.fileBackupHour}:${day}` });
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
				await client.put(local, remote);
				if ((await hashRemote(client, remote)) !== (await hashLocal(local)))
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
		runArchive = archiveAudio,
		runBackup = backupRecovery,
		prepareRestore = prepareStorageRestore,
		prune = pruneRecovery,
		testConnection = testStorageConnection,
		heartbeatMs = 10_000
	} = {}
) {
	if (
		!getStorageSettings(db).enabled &&
		!db
			.prepare(
				"SELECT 1 FROM storage_jobs WHERE kind IN ('test','restore') AND (status IN ('pending','running') OR (status = 'failed' AND attempts < 8)) LIMIT 1"
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
		db.prepare(
			"UPDATE storage_jobs SET status = 'failed', retry_at = ?, error = 'Interrupted by server restart; retrying.' WHERE status = 'running'"
		).run(now);
		return true;
	})();
	if (!claimed) return false;
	const owned = () =>
		db.prepare('SELECT owner FROM storage_worker_lock WHERE id = 1').get()?.owner === owner;
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
	let job;
	try {
		scheduleStorageJobs(db, now);
		const settings = getStorageSettings(db);
		job = db
			.prepare(
				`SELECT * FROM storage_jobs WHERE (status = 'pending' OR (status = 'failed' AND attempts < 8)) AND retry_at <= ?
			AND (kind IN ('test','restore') OR (? = 1 AND ((kind = 'archive' AND ? = 1) OR (kind IN ('database','full') AND ? = 1))))
			ORDER BY CASE kind WHEN 'test' THEN 0 WHEN 'restore' THEN 1 WHEN 'archive' THEN 2 WHEN 'full' THEN 3 ELSE 4 END, id LIMIT 1`
			)
			.get(now, +settings.enabled, +settings.archiveEnabled, +settings.backupsEnabled);
		if (!job) return false;
		db.prepare(
			"UPDATE storage_jobs SET status='running',started_at=?,finished_at=NULL,attempts=attempts+1,error=NULL WHERE id=?"
		).run(now, job.id);
		const connection = getStorageConnection(db);
		let result;
		if (job.kind === 'test') result = await testConnection(connection);
		else if (job.kind === 'restore') {
			const request = db
				.prepare('SELECT backup_id FROM storage_restore_requests WHERE job_id = ?')
				.get(job.id);
			if (!request || !backupIdPattern.test(request.backup_id))
				throw new Error('Invalid restore request.');
			result = await prepareRestore(connection, { backupId: request.backup_id, owned });
			if (!restoreIdPattern.test(result?.restoreId)) throw new Error('Invalid restore result.');
		} else if (job.kind === 'archive') result = await runArchive(db, connection, { now, owned });
		else {
			result = await runBackup(db, connection, { kind: job.kind, now, owned });
			if (!owned()) throw new Error('Storage worker lease expired.');
			await prune(connection, settings, now);
		}
		if (!owned()) throw new Error('Storage worker lease expired.');
		db.prepare(
			"UPDATE storage_jobs SET status='succeeded',finished_at=?,result=?,error=NULL WHERE id=?"
		).run(Math.floor(Date.now() / 1000), JSON.stringify(result ?? {}), job.id);
		db.prepare(
			"DELETE FROM storage_jobs WHERE kind IN ('archive','test') AND status='succeeded' AND finished_at < ?"
		).run(now - 7 * 86400);
		return true;
	} catch {
		if (job && owned())
			db.prepare(
				"UPDATE storage_jobs SET status='failed',finished_at=?,retry_at=?,error=? WHERE id=?"
			).run(
				now,
				now + Math.min(3600, 60 * 2 ** Math.min(job.attempts, 6)),
				job.kind === 'restore'
					? 'Restore preparation failed. Check the encryption key, storage connection, selected recovery point and available disk space. The live database, audio and recovery points were not replaced.'
					: 'Storage job failed. Check credentials, pinned host fingerprint, connectivity, free space and source availability. Local audio and existing recovery points were preserved.',
				job.id
			);
		return Boolean(job);
	} finally {
		clearInterval(heartbeat);
		db.prepare('DELETE FROM storage_worker_lock WHERE id=1 AND owner=?').run(owner);
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
			"SELECT kind,MAX(started_at) AS at FROM storage_jobs WHERE status = 'succeeded' GROUP BY kind"
		)
		.all();
	const jobs = db
		.prepare(
			'SELECT id,kind,status,created_at,started_at,finished_at,retry_at,attempts,error,result FROM storage_jobs ORDER BY id DESC LIMIT 30'
		)
		.all()
		.map(({ result, ...job }) => {
			let backupId = null;
			let restoreDirectory = null;
			try {
				const parsed = JSON.parse(result);
				if (typeof parsed?.id === 'string' && backupIdPattern.test(parsed.id)) backupId = parsed.id;
				if (
					job.kind === 'restore' &&
					job.status === 'succeeded' &&
					typeof parsed?.restoreId === 'string' &&
					restoreIdPattern.test(parsed.restoreId)
				)
					restoreDirectory = `restore-staging/${parsed.restoreId}`;
			} catch {
				/* Incomplete jobs have no recovery identifier. */
			}
			return { ...job, backupId, restoreDirectory };
		});
	const preparedRestores = db
		.prepare(
			"SELECT id,finished_at,result FROM storage_jobs WHERE kind='restore' AND status='succeeded' ORDER BY id DESC LIMIT 10"
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
	const backlog = db
		.prepare(
			`SELECT COUNT(*) AS count FROM (
		SELECT audio_report_path AS path FROM study_recordings WHERE audio_report_path IS NOT NULL
		UNION SELECT audio_report_path FROM recording_audio_parts
	) refs LEFT JOIN storage_audio a ON a.path = refs.path WHERE a.path IS NULL`
		)
		.get().count;
	const archived = db
		.prepare(
			'SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes, COALESCE(SUM(evicted_at IS NOT NULL),0) AS evicted FROM storage_audio'
		)
		.get();
	const interval = settings.databaseIntervalHours * 3600;
	const nextDatabase = (Math.floor(now / interval) + 1) * interval;
	const nextFull =
		(Math.floor((now - settings.fileBackupHour * 3600) / 86400) + 1) * 86400 +
		settings.fileBackupHour * 3600;
	return { last, jobs, preparedRestores, archived, backlog, nextDatabase, nextFull };
}
