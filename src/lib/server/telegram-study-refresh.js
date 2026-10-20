import { randomUUID } from 'node:crypto';
import { getStudyDetail } from './studies.js';
import { editStudyMessage } from './telegram.js';

export function telegramRefreshStatus(db) {
	const counts = { pending: 0, refreshed: 0, failed: 0, skipped: 0 };
	for (const row of db.prepare('SELECT status, COUNT(*) AS count FROM telegram_study_refresh GROUP BY status').all())
		counts[row.status] = row.count;
	return { ...counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0), configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) };
}

export function queueTelegramStudyRefresh(db) {
	if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID)
		throw Object.assign(new Error('Configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID first.'), { status: 503 });
	return db.transaction(() => {
		const current = telegramRefreshStatus(db);
		if (current.pending) return { ...current, queued: 0, already_running: true };
		db.prepare('DELETE FROM telegram_study_refresh').run();
		const queued = db.prepare(`INSERT INTO telegram_study_refresh(study_id, chat_id, message_id)
			SELECT id, ?, telegram_message_id FROM studies
			WHERE telegram_message_id IS NOT NULL AND trim(telegram_message_id) != ''`)
			.run(process.env.TELEGRAM_CHAT_ID).changes;
		return { ...telegramRefreshStatus(db), queued, already_running: false };
	})();
}

export async function processTelegramStudyRefresh(db, edit = editStudyMessage, now = Math.floor(Date.now() / 1000)) {
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
		if (!study || String(study.telegram_message_id) !== job.message_id || process.env.TELEGRAM_CHAT_ID !== job.chat_id) {
			finish('skipped', 'Study message or configured group changed.');
			return true;
		}
		await edit(study, job.chat_id);
		finish('refreshed');
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
	if (worker || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
	let busy = false;
	worker = setInterval(async () => {
		if (busy) return;
		busy = true;
		try {
			await processTelegramStudyRefresh(getDb());
		} catch {
			console.warn('Telegram study refresh queue unavailable; retrying later.');
		} finally {
			busy = false;
		}
	}, 1000);
	worker.unref();
}
