import { randomUUID } from 'node:crypto';
import { runBackgroundTask } from './restore-activation-runtime.js';
import { getStudyDetail } from './studies.js';
import { editStudyMessage, sendStudyMessage } from './telegram.js';
import { isStudyDeleting } from './study-deletion.js';

export function telegramRefreshStatus(db) {
	const counts = { pending: 0, refreshed: 0, failed: 0, skipped: 0 };
	for (const row of db.prepare('SELECT status, COUNT(*) AS count FROM telegram_study_refresh GROUP BY status').all())
		counts[row.status] = row.count;
	return { ...counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0), configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) };
}

export function queueTelegramStudyRefresh(db, studyId = null) {
	if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID)
		throw Object.assign(new Error('Configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID first.'), { status: 503 });
	return db.transaction(() => {
		if (studyId !== null && !db.prepare('SELECT 1 FROM studies WHERE id = ?').get(studyId))
			throw Object.assign(new Error('Study not found'), { status: 404 });
		const current = telegramRefreshStatus(db);
		if (studyId !== null && db.prepare("SELECT 1 FROM telegram_study_refresh WHERE study_id = ? AND status = 'pending'").get(studyId))
			return { ...current, queued: 0, already_running: true };
		if (studyId === null && !current.pending) db.prepare('DELETE FROM telegram_study_refresh').run();
		else if (studyId !== null) db.prepare('DELETE FROM telegram_study_refresh WHERE study_id = ?').run(studyId);
		const queued = db.prepare(`INSERT INTO telegram_study_refresh(study_id, chat_id, message_id)
			SELECT id, ?, coalesce(telegram_message_id, '') FROM studies
			${studyId !== null ? 'WHERE id = ?' : `WHERE NOT EXISTS
				(SELECT 1 FROM telegram_study_refresh r WHERE r.study_id = studies.id)`}`)
			.run(...(studyId === null ? [process.env.TELEGRAM_CHAT_ID] : [process.env.TELEGRAM_CHAT_ID, studyId])).changes;
		return { ...telegramRefreshStatus(db), queued, already_running: !queued && Boolean(current.pending) };
	})();
}

export function cancelTelegramStudyRefresh(db) {
	return db.transaction(() => {
		const cancelled = db.prepare(`UPDATE telegram_study_refresh SET status = 'skipped',
			lease_until = 0, lease_token = NULL, last_error = 'Cancelled by administrator.'
			WHERE status = 'pending'`).run().changes;
		return { ...telegramRefreshStatus(db), cancelled };
	})();
}

export async function processTelegramStudyRefresh(db, edit = editStudyMessage, now = Math.floor(Date.now() / 1000), send = sendStudyMessage) {
	if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return false;
	const token = randomUUID();
	const job = db.transaction(() => {
		const next = Number(db.prepare("SELECT value FROM application_settings WHERE key = 'telegram_refresh_next_at'").get()?.value || 0);
		if (next > now) return null;
		const item = db.prepare(`SELECT * FROM telegram_study_refresh
			WHERE status = 'pending' AND retry_at <= ? AND lease_until <= ? ORDER BY retry_at, study_id LIMIT 1`).get(now, now);
		if (!item) return null;
		db.prepare('UPDATE telegram_study_refresh SET lease_until = ?, lease_token = ? WHERE study_id = ?').run(now + 60, token, item.study_id);
		db.prepare(`INSERT INTO application_settings(key, value) VALUES ('telegram_refresh_next_at', ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(now + 3));
		return item;
	})();
	if (!job) return false;
	const finish = (status, message = null) => db.prepare(`UPDATE telegram_study_refresh
		SET status = ?, lease_until = 0, lease_token = NULL, last_error = ? WHERE study_id = ? AND lease_token = ?`)
		.run(status, message, job.study_id, token);
	try {
		const study = getStudyDetail(db, job.study_id);
		if (!study || (study.telegram_message_id ?? '') !== job.message_id || process.env.TELEGRAM_CHAT_ID !== job.chat_id) {
			finish('skipped', 'Study message or configured group changed.');
			return true;
		}
		if (isStudyDeleting(study.id)) throw new Error('Study deletion is in progress.');
		if (study.telegram_message_id?.trim()) {
			try {
				await edit(study, job.chat_id);
				finish('refreshed');
				return true;
			} catch (error) {
				if (error.telegram_error_code !== 400 || !/message to edit not found/i.test(error.message)) throw error;
			}
		}
		// Share the notification send lease so imports and recovery cannot post duplicate roots.
		const started = Math.floor(Date.now() / 1000);
		const claimed = db.transaction(() => {
			if (isStudyDeleting(study.id) || process.env.TELEGRAM_CHAT_ID !== job.chat_id ||
				!db.prepare('SELECT 1 FROM telegram_study_refresh WHERE study_id = ? AND lease_token = ?').get(study.id, token)) return false;
			return db.prepare(`UPDATE studies SET telegram_send_started_at = ? WHERE id = ?
				AND coalesce(telegram_message_id, '') = ?
				AND (telegram_send_started_at IS NULL OR telegram_send_started_at < ?)`)
				.run(started, study.id, job.message_id, started - 60).changes > 0;
		})();
		if (!claimed) throw new Error('Study message changed or a Telegram notification is in progress.');
		try {
			const result = await send(getStudyDetail(db, study.id), job.chat_id);
			if (!Number.isSafeInteger(Number(result.message_id)) || Number(result.message_id) <= 0)
				throw new Error('Invalid Telegram message ID.');
			db.transaction(() => {
				db.prepare('UPDATE studies SET telegram_message_id = ? WHERE id = ? AND telegram_send_started_at = ?')
					.run(String(result.message_id), study.id, started);
				db.prepare('DELETE FROM pending_telegram WHERE study_id = ?').run(study.id);
				finish('refreshed');
			})();
		} finally {
			db.prepare('UPDATE studies SET telegram_send_started_at = NULL WHERE id = ? AND telegram_send_started_at = ?')
				.run(study.id, started);
		}
	} catch (error) {
		const attempts = job.attempts + 1;
		const limited = error.telegram_error_code === 429;
		const permanent = [400, 401, 403].includes(error.telegram_error_code);
		const retryAfter = Number(error.retry_after);
		const delay = limited && Number.isSafeInteger(retryAfter) && retryAfter > 0
			? Math.max(3, retryAfter) : Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7));
		db.transaction(() => {
			const updated = db.prepare(`UPDATE telegram_study_refresh SET status = ?, attempts = ?, retry_at = ?, lease_until = 0,
				lease_token = NULL, last_error = 'Telegram message refresh failed.' WHERE study_id = ? AND lease_token = ?`)
				.run(permanent || (!limited && attempts >= 5) ? 'failed' : 'pending', attempts, now + delay, job.study_id, token);
			if (limited && updated.changes) db.prepare(`UPDATE application_settings SET value = MAX(CAST(value AS INTEGER), ?)
				WHERE key = 'telegram_refresh_next_at'`).run(now + delay);
		})();
	}
	return true;
}

let worker;
export function startTelegramStudyRefreshWorker(getDb) {
	if (worker) return;
	let busy = false;
	worker = setInterval(async () => {
		if (busy || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
		busy = true;
		try {
			await runBackgroundTask(() => processTelegramStudyRefresh(getDb()));
		} catch {
			console.warn('Telegram study refresh queue unavailable; retrying later.');
		} finally {
			busy = false;
		}
	}, 1000);
	worker.unref();
}
