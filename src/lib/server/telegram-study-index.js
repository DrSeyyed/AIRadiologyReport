import { randomUUID } from 'node:crypto';
import { buildTelegramStudyIndexes, clinicalDayTopicName } from './telegram-study-index-format.js';
import { createStudyTopic, sendStudyIndex, editStudyIndex } from './telegram.js';

const defaultApi = { create: createStudyTopic, send: sendStudyIndex, edit: editStudyIndex };
const emptyList = '<b>No studies currently assigned to this list.</b>\nSee the current attending lists in this topic.';
const configured = () => Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
const pageKey = (row) => JSON.stringify([row.clinical_day, row.attending_id, row.page_number]);

export function telegramIndexStatus(db) {
	const chat = process.env.TELEGRAM_CHAT_ID || '';
	const state = db.prepare('SELECT * FROM telegram_index_state WHERE chat_id = ?').get(chat);
	const version = db.prepare('SELECT version FROM telegram_index_revision WHERE id = 1').get().version;
	const counts = { pending: 0, synced: 0, failed: 0 };
	for (const row of db.prepare('SELECT status, COUNT(*) AS count FROM telegram_index_pages WHERE chat_id = ? GROUP BY status').all(chat))
		counts[row.status] = row.count;
	const planning = (state?.planned_version || 0) !== version;
	return {
		...counts, configured: configured(), planning, paused: Boolean(state?.paused),
		active: configured() && !state?.paused && (planning || counts.pending > 0),
		topics: db.prepare('SELECT COUNT(*) AS count FROM telegram_index_topics WHERE chat_id = ? AND message_thread_id IS NOT NULL').get(chat).count,
		skipped: state?.skipped || 0, last_error: state?.last_error || null
	};
}

export function queueTelegramIndexRebuild(db) {
	if (!configured()) throw Object.assign(new Error('Configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID first.'), { status: 503 });
	return db.transaction(() => {
		const status = telegramIndexStatus(db);
		if (status.active) return { ...status, already_running: true };
		const chat = process.env.TELEGRAM_CHAT_ID;
		db.prepare('INSERT OR IGNORE INTO telegram_index_state(chat_id) VALUES (?)').run(chat);
		db.prepare('UPDATE telegram_index_state SET paused = 0, last_error = NULL WHERE chat_id = ?').run(chat);
		db.prepare(`UPDATE telegram_index_pages SET sent_text = NULL, status = 'pending', attempts = 0, retry_at = 0, last_error = NULL
			WHERE chat_id = ?`).run(chat);
		db.prepare('UPDATE telegram_index_revision SET version = version + 1 WHERE id = 1').run();
		return { ...telegramIndexStatus(db), already_running: false };
	})();
}

function planIndexes(db, chat, version) {
	const studies = db.prepare(`SELECT s.*, a.full_name AS attending_fullname, m.code AS modality_code
		FROM studies s LEFT JOIN users a ON a.id = s.corresponding_attending_id
		LEFT JOIN modalities m ON m.id = s.modality_id
		WHERE s.telegram_message_id IS NOT NULL AND trim(s.telegram_message_id) != ''`).all();
	const { groups, skipped } = buildTelegramStudyIndexes(studies, chat);
	const desired = new Map();
	for (const group of groups) {
		db.prepare('INSERT OR IGNORE INTO telegram_index_topics(chat_id, clinical_day) VALUES (?, ?)').run(chat, group.day);
		for (const [page_number, text] of group.texts.entries()) {
			const row = { clinical_day: group.day, attending_id: group.attendingId, page_number, text };
			desired.set(pageKey(row), row);
		}
	}
	const previous = db.prepare('SELECT * FROM telegram_index_pages WHERE chat_id = ?').all(chat);
	for (const row of previous) {
		if (desired.has(pageKey(row))) continue;
		if (row.message_id) desired.set(pageKey(row), { ...row, text: emptyList });
		else db.prepare(`DELETE FROM telegram_index_pages WHERE chat_id = ? AND clinical_day = ? AND attending_id = ? AND page_number = ?`)
			.run(chat, row.clinical_day, row.attending_id, row.page_number);
	}
	const upsert = db.prepare(`INSERT INTO telegram_index_pages(chat_id, clinical_day, attending_id, page_number, desired_text)
		VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id, clinical_day, attending_id, page_number) DO UPDATE SET
		desired_text = excluded.desired_text, status = CASE WHEN sent_text = excluded.desired_text THEN 'synced' ELSE 'pending' END,
		attempts = 0, retry_at = 0, last_error = NULL WHERE desired_text IS NOT excluded.desired_text`);
	for (const row of desired.values()) upsert.run(chat, row.clinical_day, row.attending_id, row.page_number, row.text);
	db.prepare('UPDATE telegram_index_state SET planned_version = ?, skipped = ? WHERE chat_id = ?').run(version, skipped, chat);
}

function updatePage(db, job, sql, ...params) {
	return db.prepare(`UPDATE telegram_index_pages SET ${sql} WHERE chat_id = ? AND clinical_day = ? AND attending_id = ? AND page_number = ?`)
		.run(...params, job.chat_id, job.clinical_day, job.attending_id, job.page_number);
}

export async function processTelegramTopicIndex(db, api = defaultApi, clock = () => Math.floor(Date.now() / 1000)) {
	if (!configured()) return false;
	const chat = process.env.TELEGRAM_CHAT_ID, now = clock(), token = randomUUID();
	const claim = db.transaction(() => {
		db.prepare('INSERT OR IGNORE INTO telegram_index_state(chat_id) VALUES (?)').run(chat);
		const state = db.prepare('SELECT * FROM telegram_index_state WHERE chat_id = ?').get(chat);
		const sharedNext = Number(db.prepare("SELECT value FROM application_settings WHERE key = 'telegram_refresh_next_at'").get()?.value || 0);
		if (state.paused || state.lease_until > now || state.next_at > now || sharedNext > now) return null;
		const version = db.prepare('SELECT version FROM telegram_index_revision WHERE id = 1').get().version;
		if (state.planned_version !== version) planIndexes(db, chat, version);
		const job = db.prepare(`SELECT p.*, t.message_thread_id FROM telegram_index_pages p JOIN telegram_index_topics t
			ON t.chat_id = p.chat_id AND t.clinical_day = p.clinical_day
			WHERE p.chat_id = ? AND p.status = 'pending' AND p.retry_at <= ?
			ORDER BY p.retry_at, p.clinical_day DESC, p.attending_id, p.page_number LIMIT 1`).get(chat, now);
		if (!job) return null;
		db.prepare('UPDATE telegram_index_state SET lease_token = ?, lease_until = ?, next_at = ? WHERE chat_id = ?')
			.run(token, now + 60, now + 3, chat);
		db.prepare(`INSERT INTO application_settings(key, value) VALUES ('telegram_refresh_next_at', ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(now + 3));
		return job;
	})();
	if (!claim) return false;
	const job = claim;
	const ownsLease = () => db.prepare('SELECT 1 FROM telegram_index_state WHERE chat_id = ? AND lease_token = ?').get(chat, token);
	const operation = !job.message_thread_id ? 'create' : !job.message_id ? 'send' : 'edit';
	try {
		if (operation === 'create') {
			const thread = await api.create(chat, clinicalDayTopicName(job.clinical_day));
			if (!Number.isSafeInteger(thread) || thread <= 0) throw new Error('Invalid Telegram topic response.');
			db.transaction(() => {
				if (ownsLease()) db.prepare('UPDATE telegram_index_topics SET message_thread_id = ? WHERE chat_id = ? AND clinical_day = ?')
					.run(thread, chat, job.clinical_day);
			})();
		} else {
			const message = operation === 'send' ? await api.send(chat, job.message_thread_id, job.desired_text)
				: (await api.edit(chat, job.message_id, job.desired_text), job.message_id);
			if (!Number.isSafeInteger(message) || message <= 0) throw new Error('Invalid Telegram message response.');
			db.transaction(() => {
				if (ownsLease()) updatePage(db, job, `message_id = ?, sent_text = ?,
					status = CASE WHEN desired_text = ? THEN 'synced' ELSE 'pending' END, attempts = 0, retry_at = 0, last_error = NULL`,
					message, job.desired_text, job.desired_text);
			})();
		}
		db.transaction(() => {
			if (ownsLease()) db.prepare(`UPDATE telegram_index_state SET last_error = (
				SELECT last_error FROM telegram_index_pages WHERE chat_id = ? AND status != 'synced' AND last_error IS NOT NULL LIMIT 1
			) WHERE chat_id = ?`).run(chat, chat);
		})();
	} catch (error) {
		const failedAt = clock();
		db.transaction(() => {
			if (!ownsLease()) return;
			const code = error.telegram_error_code;
			if (code === 400 && operation === 'edit' && /message to edit not found|message_id_invalid/i.test(error.message)) {
				updatePage(db, job, "message_id = NULL, sent_text = NULL, status = 'pending', retry_at = 0");
				return;
			}
			if (code === 400 && job.message_thread_id && /message thread not found|message_thread_invalid|topic_deleted/i.test(error.message)) {
				db.prepare('UPDATE telegram_index_topics SET message_thread_id = NULL WHERE chat_id = ? AND clinical_day = ?').run(chat, job.clinical_day);
				db.prepare(`UPDATE telegram_index_pages SET message_id = NULL, sent_text = NULL, status = 'pending', attempts = 0, retry_at = 0
					WHERE chat_id = ? AND clinical_day = ?`).run(chat, job.clinical_day);
				return;
			}
			const limited = code === 429, attempts = job.attempts + 1;
			const retryAfter = Number(error.retry_after);
			const delay = limited && Number.isSafeInteger(retryAfter) && retryAfter > 0 ? Math.max(3, retryAfter)
				: Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7));
			const permanent = [400, 401, 403].includes(code);
			const paused = code === 401 || code === 403 || (code === 400 && operation === 'create');
			const message = paused ? 'Enable Topics in the study supergroup and check the bot token, Manage Topics and posting permissions. Then rebuild indexes.'
				: 'Telegram index update failed. Check deleted or closed topics and bot permissions, then rebuild indexes to retry.';
			updatePage(db, job, 'status = ?, attempts = ?, retry_at = ?, last_error = ?',
				permanent || (!limited && attempts >= 5) ? 'failed' : 'pending', attempts, failedAt + delay, message);
			db.prepare('UPDATE telegram_index_state SET paused = ?, last_error = ?, next_at = MAX(next_at, ?) WHERE chat_id = ?')
				.run(paused ? 1 : 0, message, limited ? failedAt + delay : 0, chat);
			if (limited) db.prepare(`UPDATE application_settings SET value = MAX(CAST(value AS INTEGER), ?)
				WHERE key = 'telegram_refresh_next_at'`).run(failedAt + delay);
		})();
	} finally {
		db.prepare('UPDATE telegram_index_state SET lease_until = 0, lease_token = NULL WHERE chat_id = ? AND lease_token = ?').run(chat, token);
	}
	return true;
}

let worker;
export function startTelegramTopicIndexWorker(getDb) {
	if (worker || !configured()) return;
	let busy = false;
	worker = setInterval(async () => {
		if (busy) return;
		busy = true;
		try {
			await processTelegramTopicIndex(getDb());
		} catch {
			console.warn('Telegram topic index queue unavailable; retrying later.');
		} finally {
			busy = false;
		}
	}, 1000);
	worker.unref();
}
