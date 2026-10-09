import { getStudyDetail } from './studies.js';
import { sendStudyMessage } from './telegram.js';

export async function processStudyNotification(
	db,
	send = sendStudyMessage,
	now = Math.floor(Date.now() / 1000)
) {
	const job = db
		.prepare('SELECT * FROM pending_telegram WHERE retry_at <= ? ORDER BY study_id LIMIT 1')
		.get(now);
	if (!job) return false;
	const study = getStudyDetail(db, job.study_id);
	if (!study || study.telegram_message_id) {
		db.prepare('DELETE FROM pending_telegram WHERE study_id = ?').run(job.study_id);
		return true;
	}
	try {
		const result = await send(study);
		db.transaction(() => {
			db.prepare('UPDATE studies SET telegram_message_id = ? WHERE id = ?').run(
				String(result.message_id),
				study.id
			);
			db.prepare('DELETE FROM pending_telegram WHERE study_id = ?').run(study.id);
		})();
	} catch {
		const delay = Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7));
		db.prepare(
			'UPDATE pending_telegram SET attempts = attempts + 1, retry_at = ? WHERE study_id = ?'
		).run(now + delay, job.study_id);
	}
	return true;
}

let worker;
export function startStudyNotificationWorker(getDb) {
	if (worker || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
	let busy = false;
	worker = setInterval(async () => {
		if (busy) return;
		busy = true;
		try {
			await processStudyNotification(getDb());
		} catch {
			console.warn('Study notification queue unavailable; retrying later.');
		} finally {
			busy = false;
		}
	}, 1000);
	worker.unref();
}
