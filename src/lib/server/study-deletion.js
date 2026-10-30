import { getStudyDetail } from './studies.js';
import { telegramVoiceCount } from './study-state.js';
import { deleteMessage, editStudyMessage } from './telegram.js';
import { processTelegramVoiceDeletion } from './telegram-voice-deletion.js';

const deleting = new Set();

export async function deleteStudy(db, studyId, confirmation = {}, remove = deleteMessage, edit = editStudyMessage) {
	if (deleting.has(studyId))
		throw Object.assign(new Error('Study deletion is already in progress.'), { status: 409 });
	deleting.add(studyId);
	try {
		const detail = db.transaction(() => {
			const study = getStudyDetail(db, studyId);
			if (!study) throw Object.assign(new Error('Study not found'), { status: 404 });
			if (study.recordings.some(r => r.processing) || study.telegram_send_started_at > Math.floor(Date.now() / 1000) - 60)
				throw Object.assign(new Error('A recording or Telegram notification is being processed. Try again later.'), { status: 409 });
			const count = telegramVoiceCount(db, studyId);
			if (count && (confirmation.confirm_voices !== true || confirmation.telegram_voice_count !== count))
				throw Object.assign(new Error(`This study has ${count} linked Telegram voice/audio messages. Review and confirm their deletion.`), { status: 409 });
			db.prepare('UPDATE studies SET disabled = 1 WHERE id = ?').run(studyId);
			db.prepare('UPDATE pending_voice SET done = 1 WHERE study_id = ?').run(studyId);
			db.prepare('DELETE FROM pending_telegram WHERE study_id = ?').run(studyId);
			db.prepare(`INSERT OR IGNORE INTO study_telegram_voices(study_id,chat_id,message_id)
				SELECT study_id,chat_id,reply_message_id FROM pending_voice p WHERE study_id = ? AND NOT EXISTS
				(SELECT 1 FROM telegram_voice_deletions d WHERE d.chat_id = p.chat_id AND d.message_id = p.reply_message_id)`).run(studyId);
			return { ...study, disabled: 1 };
		})();
		let failed = false;
		const cleanups = db.prepare(`SELECT chat_id, message_id FROM telegram_voice_deletions
			WHERE study_id = ? AND (telegram_deleted = 0 OR files_deleted = 0 OR refreshed = 0)`).all(studyId);
		for (const job of cleanups) {
			const complete = await processTelegramVoiceDeletion(db, {
				remove, refresh: edit, chatId: job.chat_id, messageId: job.message_id, now: Math.floor(Date.now() / 1000) + 30
			});
			if (!complete) failed = true;
		}
		const voices = db.prepare('SELECT * FROM study_telegram_voices WHERE study_id = ? AND deleted = 0 ORDER BY message_id DESC').all(studyId);
		for (const voice of voices) {
			try {
				await remove(voice.message_id, voice.chat_id);
				db.prepare('UPDATE study_telegram_voices SET deleted = 1 WHERE chat_id = ? AND message_id = ?').run(voice.chat_id, voice.message_id);
			} catch {
				failed = true;
			}
		}
		// Keep the study message available to mark disabled if any voice remains.
		if (!failed && detail.telegram_message_id) {
			try { await remove(detail.telegram_message_id); } catch { failed = true; }
		}
		if (!failed) {
			db.prepare('DELETE FROM studies WHERE id = ?').run(studyId);
			return { ok: true, disabled: false, notification_warning: null };
		}
		let notification_warning = 'Telegram could not remove all messages (for example, its deletion time limit or missing permissions). The study is retained as disabled; new replies are ignored. Retry deletion later if permissions change.';
		if (detail.telegram_message_id) {
			try { await edit(getStudyDetail(db, studyId)); }
			catch { notification_warning += ' Telegram also could not update the study message; it may still look active.'; }
		}
		return { ok: true, disabled: true, notification_warning };
	} finally {
		deleting.delete(studyId);
	}
}
