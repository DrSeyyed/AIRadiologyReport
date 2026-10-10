import { getStudyDetail } from './studies.js';
import { appendRecording } from './recordings.js';
import { downloadFile, syncStudyMessage } from './telegram.js';
import fs from 'node:fs';
import path from 'node:path';

const SAVE_DIR = process.env.VOICE_SAVE_DIR || path.join('uploads', 'audio');

export function queueVoiceReply(db, message, now = Math.floor(Date.now() / 1000)) {
	const fileId = message?.voice?.file_id || message?.audio?.file_id;
	if (!fileId || !message.reply_to_message?.message_id || !message.chat?.id || !message.message_id)
		return false;
	return db.transaction(() => {
		const study = db
			.prepare('SELECT id FROM studies WHERE telegram_message_id = ?')
			.get(String(message.reply_to_message.message_id));
		if (!study) return false;
		const chatId = String(message.chat.id);
		if (
			!db
				.prepare('SELECT id FROM pending_voice WHERE chat_id = ? AND reply_message_id = ?')
				.get(chatId, message.message_id)
		)
			db.prepare(
				'INSERT INTO pending_voice(study_id, chat_id, reply_message_id, file_id, process_at) VALUES (?, ?, ?, ?, ?)'
			).run(study.id, chatId, message.message_id, fileId, now);
		return true;
	})();
}

export async function processVoiceJob(
	db,
	download = downloadFile,
	notify = syncStudyMessage,
	directory = SAVE_DIR,
	now = Math.floor(Date.now() / 1000)
) {
	const job = db
		.prepare('SELECT * FROM pending_voice WHERE done = 0 AND process_at <= ? ORDER BY id LIMIT 1')
		.get(now);
	if (!job) return false;
	try {
		const savedPath = await download(
			job.file_id,
			path.join(directory, `study_${job.study_id}_voice_${job.id}.ogg`)
		);
		if (!db.prepare('SELECT id FROM studies WHERE id = ?').get(job.study_id)) {
			if (fs.existsSync(savedPath)) fs.unlinkSync(savedPath);
			return true;
		}
		db.transaction(() => {
			appendRecording(db, job.study_id, savedPath, { telegramVoiceJobId: job.id });
			db.prepare('UPDATE pending_voice SET done = 1 WHERE id = ?').run(job.id);
		})();
		await notify(getStudyDetail(db, job.study_id));
	} catch {
		db.prepare('UPDATE pending_voice SET process_at = ? WHERE id = ? AND done = 0').run(
			now + 30,
			job.id
		);
	}
	return true;
}

let worker;
export function startVoiceWorker(getDb) {
	if (worker || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
	let busy = false;
	worker = setInterval(async () => {
		if (busy) return;
		busy = true;
		try {
			await processVoiceJob(getDb());
		} catch {
			console.warn('Voice queue unavailable; retrying later.');
		} finally {
			busy = false;
		}
	}, 1000);
	worker.unref();
}
