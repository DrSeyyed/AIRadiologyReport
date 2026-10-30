import { unlinkSync } from 'node:fs';
import { assertRecordingMutable, getRecording, recordingError } from './recordings.js';
import { assertStudyActive } from './study-state.js';
import { getApprovedTelegramUser } from './telegram-registration.js';
import { telegramReplyMessageId } from './telegram-replies.js';
import { deleteMessage, editStudyMessage } from './telegram.js';
import { getStudyDetail } from './studies.js';

export function requestTelegramVoiceDeletion(db, message) {
	const chatId = String(message.chat?.id);
	if (!process.env.TELEGRAM_CHAT_ID || chatId !== process.env.TELEGRAM_CHAT_ID)
		throw recordingError('Use /delete in the study group.', 403);
	const sender = message.from?.is_bot || message.sender_chat ? null : getApprovedTelegramUser(db, message.from?.id);
	if (!sender || !['resident', 'attending'].includes(sender.role))
		throw recordingError('Only approved residents and attendings can delete their own audio.', 403);
	const messageId = telegramReplyMessageId(message);
	if (!messageId) throw recordingError('Reply to your own voice or audio message with /delete.');
	return db.transaction(() => {
		const previous = db.prepare('SELECT * FROM telegram_voice_deletions WHERE chat_id = ? AND message_id = ?').get(chatId, messageId);
		if (previous) {
			if (previous.sender_user_id !== sender.id) throw recordingError('You can only delete your own audio.', 403);
			return { studyId: previous.study_id };
		}
		const job = db.prepare('SELECT * FROM pending_voice WHERE chat_id = ? AND reply_message_id = ?').get(chatId, messageId);
		if (!job) throw recordingError('No linked voice or audio was found.', 404);
		if (job.sender_user_id !== sender.id) throw recordingError('You can only delete your own audio.', 403);
		assertStudyActive(db, job.study_id);
		let root = job;
		const visited = new Set();
		while (root.parent_voice_job_id) {
			if (visited.has(root.id)) throw recordingError('Invalid voice reply chain.', 409);
			visited.add(root.id);
			root = db.prepare('SELECT * FROM pending_voice WHERE id = ?').get(root.parent_voice_job_id);
			if (!root) throw recordingError('Original voice no longer exists.', 404);
		}
		const part = db.prepare('SELECT * FROM recording_audio_parts WHERE telegram_voice_job_id = ?').get(job.id);
		const base = db.prepare('SELECT * FROM study_recordings WHERE telegram_voice_job_id = ?').get(job.id);
		const recordingId = part?.recording_id || base?.id || job.recording_id || root.recording_id
			|| db.prepare('SELECT id FROM study_recordings WHERE telegram_voice_job_id = ?').get(root.id)?.id;
		const recording = recordingId ? getRecording(db, job.study_id, recordingId) : null;
		if (recording) assertRecordingMutable(recording);
		const attached = Boolean(part || base?.audio_report_path);
		const audioPath = part?.audio_report_path || base?.audio_report_path || null;
		const reportPath = attached ? recording?.text_report_path || null : null;
		db.prepare(`INSERT INTO telegram_voice_deletions(chat_id,message_id,study_id,sender_user_id,audio_path,report_path)
			VALUES(?,?,?,?,?,?)`).run(chatId, messageId, job.study_id, sender.id, audioPath, reportPath);
		db.prepare("UPDATE pending_voice SET done = 1, file_id = '' WHERE id = ?").run(job.id);
		if (part) db.prepare('DELETE FROM recording_audio_parts WHERE id = ?').run(part.id);
		if (base) db.prepare('UPDATE study_recordings SET audio_report_path = NULL WHERE id = ?').run(base.id);
		if (attached && recording) db.prepare('UPDATE study_recordings SET text_report_path = NULL WHERE id = ?').run(recording.id);
		if (recording) {
			const remaining = getRecording(db, job.study_id, recording.id).audio_parts.length;
			// Queued descendants still need this recording and its original routing stub.
			const queued = db.prepare(`WITH RECURSIVE chain(id) AS (
				SELECT ? UNION ALL SELECT p.id FROM pending_voice p JOIN chain c ON p.parent_voice_job_id = c.id
			) SELECT 1 FROM pending_voice WHERE id IN (SELECT id FROM chain) AND done = 0 LIMIT 1`).get(root.id);
			if (!remaining && !queued) db.prepare('DELETE FROM study_recordings WHERE id = ?').run(recording.id);
		} else {
			const children = db.prepare('SELECT id FROM pending_voice WHERE parent_voice_job_id = ? ORDER BY id').all(job.id);
			if (!job.parent_voice_job_id && children.length) {
				const promoted = children[0].id;
				db.prepare('UPDATE pending_voice SET parent_voice_job_id = ? WHERE parent_voice_job_id = ?').run(promoted, job.id);
				db.prepare('UPDATE pending_voice SET parent_voice_job_id = NULL WHERE id = ?').run(promoted);
			} else if (job.parent_voice_job_id) {
				db.prepare('UPDATE pending_voice SET parent_voice_job_id = ? WHERE parent_voice_job_id = ?').run(job.parent_voice_job_id, job.id);
			}
		}
		const log = db.prepare('SELECT parent_message_id FROM study_telegram_voices WHERE chat_id = ? AND message_id = ?').get(chatId, messageId);
		db.prepare('UPDATE study_telegram_voices SET parent_message_id = ? WHERE chat_id = ? AND parent_message_id = ?')
			.run(log?.parent_message_id || null, chatId, messageId);
		db.prepare('DELETE FROM study_telegram_voices WHERE chat_id = ? AND message_id = ?').run(chatId, messageId);
		return { studyId: job.study_id };
	})();
}

export async function processTelegramVoiceDeletion(db, {
	remove = deleteMessage,
	refresh = editStudyMessage,
	now = Math.floor(Date.now() / 1000),
	chatId = process.env.TELEGRAM_CHAT_ID,
	messageId = null
} = {}) {
	const job = db.prepare(`SELECT * FROM telegram_voice_deletions WHERE chat_id = ? AND retry_at <= ?
		AND (? IS NULL OR message_id = ?) AND (telegram_deleted = 0 OR files_deleted = 0 OR refreshed = 0)
		ORDER BY message_id LIMIT 1`).get(String(chatId), now, messageId, messageId);
	if (!job) {
		return messageId !== null && Boolean(db.prepare(`SELECT 1 FROM telegram_voice_deletions
			WHERE chat_id = ? AND message_id = ? AND telegram_deleted = 1 AND files_deleted = 1 AND refreshed = 1`).get(String(chatId), messageId));
	}
	const mark = (sql) => db.prepare(sql).run(job.chat_id, job.message_id);
	let failed = false;
	const attempt = async (work) => {
		try { await work(); } catch { failed = true; }
	};
	if (!job.files_deleted) {
		await attempt(() => {
			for (const file of [job.audio_path, job.report_path].filter(Boolean)) {
				try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
			}
			mark('UPDATE telegram_voice_deletions SET files_deleted = 1, audio_path = NULL, report_path = NULL WHERE chat_id = ? AND message_id = ?');
		});
	}
	if (!job.telegram_deleted) {
		await attempt(async () => {
			await remove(job.message_id, job.chat_id);
			mark('UPDATE telegram_voice_deletions SET telegram_deleted = 1 WHERE chat_id = ? AND message_id = ?');
		});
	}
	if (!job.refreshed) {
		await attempt(async () => {
			const study = getStudyDetail(db, job.study_id);
			if (study) await refresh(study, job.chat_id);
			mark('UPDATE telegram_voice_deletions SET refreshed = 1 WHERE chat_id = ? AND message_id = ?');
		});
	}
	if (failed) db.prepare('UPDATE telegram_voice_deletions SET retry_at = ? WHERE chat_id = ? AND message_id = ?').run(now + 30, job.chat_id, job.message_id);
	return !failed;
}
