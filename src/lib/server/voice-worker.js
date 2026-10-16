import { getStudyDetail } from './studies.js';
import { assertStudyActive } from './study-state.js';
import { appendRecording, appendRecordingAudio, getRecording, assertCanAppendRecordingAudio, recordingError } from './recordings.js';
import { downloadFile, syncStudyMessage, sendReply } from './telegram.js';
import { getApprovedTelegramUser } from './telegram-registration.js';
import fs from 'node:fs';
import path from 'node:path';

const SAVE_DIR = process.env.VOICE_SAVE_DIR || path.join('uploads', 'audio');

function voiceTarget(db, parent) {
	let root = parent;
	const visited = new Set();
	while (root.parent_voice_job_id) {
		if (visited.has(root.id)) throw recordingError('Invalid voice reply chain.', 400);
		visited.add(root.id);
		root = db.prepare('SELECT * FROM pending_voice WHERE id = ?').get(root.parent_voice_job_id);
		if (!root) throw recordingError('Original voice no longer exists.', 404);
	}
	const recordingId = parent.recording_id || root.recording_id || db.prepare('SELECT id FROM study_recordings WHERE telegram_voice_job_id = ?').get(root.id)?.id;
	return { root, recording: recordingId ? getRecording(db, root.study_id, recordingId) : null };
}

export function queueVoiceReply(db, message, now = Math.floor(Date.now() / 1000)) {
	const fileId = message?.voice?.file_id || message?.audio?.file_id;
	if (!fileId || !message.reply_to_message?.message_id || !message.chat?.id || !message.message_id)
		return false;
	const sender =
		message.from?.is_bot || message.sender_chat
			? null
			: getApprovedTelegramUser(db, message.from?.id);
	if (!sender || !['resident', 'attending'].includes(sender.role)) return false;
	return db.transaction(() => {
		const chatId = String(message.chat.id);
		if (db.prepare('SELECT id FROM pending_voice WHERE chat_id = ? AND reply_message_id = ?').get(chatId, message.message_id)) return true;
		const replyId = message.reply_to_message.message_id;
		const study = db.prepare('SELECT id FROM studies WHERE telegram_message_id IN (?, ?)').get(String(replyId), `${replyId}.0`);
		const parent = study ? null : db.prepare('SELECT * FROM pending_voice WHERE chat_id = ? AND reply_message_id = ?').get(chatId, replyId);
		if (!study && !parent) return false;
		assertStudyActive(db, study?.id || parent.study_id);
		if (parent) {
			const { root, recording } = voiceTarget(db, parent);
			if (!recording && root.done) throw recordingError('Original recording no longer exists.', 404);
			assertCanAppendRecordingAudio(db, parent.study_id, recording || {
				sender_user_id: root.sender_user_id,
				corresponding_resident_id: root.sender_role === 'resident' ? root.sender_user_id : null
			}, sender);
		}
		db.prepare(
			'INSERT INTO pending_voice(study_id, chat_id, reply_message_id, file_id, process_at, sender_user_id, sender_role, parent_voice_job_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
		).run(study?.id || parent.study_id, chatId, message.message_id, fileId, now, sender.id, sender.role, parent?.id || null);
		db.prepare('INSERT OR IGNORE INTO study_telegram_voices(study_id,chat_id,message_id) VALUES(?,?,?)')
			.run(study?.id || parent.study_id, chatId, message.message_id);
		return true;
	})();
}

export async function processVoiceJob(
	db,
	download = downloadFile,
	notify = syncStudyMessage,
	directory = SAVE_DIR,
	now = Math.floor(Date.now() / 1000),
	reply = sendReply
) {
	const job = db
		.prepare('SELECT * FROM pending_voice WHERE done = 0 AND process_at <= ? ORDER BY id LIMIT 1')
		.get(now);
	if (!job) return false;
	let sender;
	if (job.sender_role) {
		const account = db.prepare('SELECT telegram_user_id FROM users WHERE id = ? AND role = ?').get(job.sender_user_id, job.sender_role);
		sender = account && getApprovedTelegramUser(db, account.telegram_user_id);
		if (!sender) {
			db.prepare('UPDATE pending_voice SET done = 1 WHERE id = ?').run(job.id);
			return true;
		}
	}
	let savedPath;
	let attached = false;
	try {
		assertStudyActive(db, job.study_id);
		const existing = db.prepare('SELECT recording_id FROM recording_audio_parts WHERE telegram_voice_job_id = ?').get(job.id)
			|| db.prepare('SELECT id AS recording_id FROM study_recordings WHERE telegram_voice_job_id = ?').get(job.id);
		if (existing) {
			db.prepare('UPDATE pending_voice SET done = 1, recording_id = ? WHERE id = ?').run(existing.recording_id, job.id);
			return true;
		}
		let target;
		if (job.parent_voice_job_id) {
			const parent = db.prepare('SELECT * FROM pending_voice WHERE id = ?').get(job.parent_voice_job_id);
			if (!parent) throw recordingError('Original voice no longer exists.', 404);
			const resolved = voiceTarget(db, parent);
			target = resolved.recording;
			if (!target) {
				if (resolved.root.done) throw recordingError('Original recording no longer exists.', 404);
				db.prepare('UPDATE pending_voice SET process_at = ? WHERE id = ?').run(now + 30, job.id);
				return true;
			}
			assertCanAppendRecordingAudio(db, job.study_id, target, sender);
		}
		savedPath = await download(job.file_id, path.join(directory, `study_${job.study_id}_voice_${job.id}.ogg`));
		if (!db.prepare('SELECT id FROM studies WHERE id = ?').get(job.study_id)) {
			if (fs.existsSync(savedPath)) fs.unlinkSync(savedPath);
			return true;
		}
		db.transaction(() => {
			if (job.sender_role) {
				const account = db.prepare('SELECT telegram_user_id FROM users WHERE id = ? AND role = ?').get(job.sender_user_id, job.sender_role);
				sender = account && getApprovedTelegramUser(db, account.telegram_user_id);
				if (!sender) throw recordingError('Sender is no longer approved.', 403);
			}
			const recording = target
				? appendRecordingAudio(db, job.study_id, target.id, savedPath, job.id, sender)
				: appendRecording(db, job.study_id, savedPath, {
					telegramVoiceJobId: job.id,
					senderUserId: job.sender_user_id,
					source: job.sender_role ? 'telegram' : 'legacy'
				});
			db.prepare('UPDATE pending_voice SET done = 1, recording_id = ? WHERE id = ?').run(recording.id, job.id);
		})();
		attached = true;
		await notify(getStudyDetail(db, job.study_id));
	} catch (error) {
		if (savedPath && !attached && fs.existsSync(savedPath)) fs.unlinkSync(savedPath);
		if ([403, 404, 409].includes(error.status) && !/being processed/.test(error.message)) {
			db.prepare('UPDATE pending_voice SET done = 1 WHERE id = ?').run(job.id);
			await reply(job.chat_id, `Audio not attached: ${error.message}`, job.reply_message_id).catch(() => {});
		} else {
			db.prepare('UPDATE pending_voice SET process_at = ? WHERE id = ? AND done = 0').run(now + 30, job.id);
		}
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
