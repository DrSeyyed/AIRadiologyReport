import { getStudyDetail } from './studies.js';
import { runBackgroundTask } from './restore-activation-runtime.js';
import { assertStudyActive } from './study-state.js';
import { appendRecording, appendRecordingAudio, getRecording, assertCanAppendRecordingAudio, recordingError } from './recordings.js';
import { downloadFile, syncStudyMessage, sendReply } from './telegram.js';
import { getApprovedTelegramUser } from './telegram-registration.js';
import { trackStudyReply, telegramReplyMessageId } from './telegram-replies.js';
import { processTelegramVoiceDeletion } from './telegram-voice-deletion.js';
import { telegramDiagnostic, telegramErrorDetails } from './telegram-diagnostics.js';
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
	const replyId = telegramReplyMessageId(message);
	const context = { messageId: message?.message_id, replyMessageId: replyId, stage: 'queue' };
	if (!fileId || !replyId || !message.chat?.id || !message.message_id) {
		telegramDiagnostic('voice_ignored', { ...context, reason: 'invalid_metadata' });
		return false;
	}
	const sender =
		message.from?.is_bot || message.sender_chat
			? null
			: getApprovedTelegramUser(db, message.from?.id);
	if (!sender || !['resident', 'attending'].includes(sender.role)) {
		telegramDiagnostic('voice_ignored', { ...context, reason: 'sender_not_allowed' });
		return false;
	}
	let event = 'voice_queued';
	let reason;
	const queued = db.transaction(() => {
		const chatId = String(message.chat.id);
		if (db.prepare('SELECT 1 FROM telegram_voice_deletions WHERE chat_id = ? AND message_id IN (?, ?)').get(chatId, message.message_id, replyId)) {
			reason = 'deleted';
			return false;
		}
		const existing = db.prepare('SELECT id, study_id, recording_id FROM pending_voice WHERE chat_id = ? AND reply_message_id = ?').get(chatId, message.message_id);
		if (existing) {
			Object.assign(context, { jobId: existing.id, studyId: existing.study_id, recordingId: existing.recording_id });
			event = 'voice_duplicate';
			return true;
		}
		const study = db.prepare('SELECT id FROM studies WHERE telegram_message_id IN (?, ?)').get(String(replyId), `${replyId}.0`);
		const parent = study ? null : db.prepare('SELECT * FROM pending_voice WHERE chat_id = ? AND reply_message_id = ?').get(chatId, replyId);
		if (!study && !parent) {
			reason = 'unknown_reply';
			return false;
		}
		context.studyId = study?.id || parent.study_id;
		assertStudyActive(db, study?.id || parent.study_id);
		if (parent) {
			const { root, recording } = voiceTarget(db, parent);
			if (!recording && root.done) throw recordingError('Original recording no longer exists.', 404);
			assertCanAppendRecordingAudio(db, parent.study_id, recording || {
				sender_user_id: root.sender_user_id,
				corresponding_resident_id: root.sender_role === 'resident' ? root.sender_user_id : null
			}, sender);
		}
		const inserted = db.prepare(
			'INSERT INTO pending_voice(study_id, chat_id, reply_message_id, file_id, process_at, sender_user_id, sender_role, parent_voice_job_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
		).run(study?.id || parent.study_id, chatId, message.message_id, fileId, now, sender.id, sender.role, parent?.id || null);
		context.jobId = Number(inserted.lastInsertRowid);
		trackStudyReply(db, message);
		db.prepare('INSERT OR IGNORE INTO study_telegram_voices(study_id,chat_id,message_id) VALUES(?,?,?)')
			.run(study?.id || parent.study_id, chatId, message.message_id);
		return true;
	})();
	telegramDiagnostic(queued ? event : 'voice_ignored', { ...context, reason });
	return queued;
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
	const context = { jobId: job.id, studyId: job.study_id, messageId: job.reply_message_id };
	telegramDiagnostic('voice_processing', context);
	let stage = 'validate';
	let sender;
	if (job.sender_role) {
		const account = db.prepare('SELECT telegram_user_id FROM users WHERE id = ? AND role = ?').get(job.sender_user_id, job.sender_role);
		sender = account && getApprovedTelegramUser(db, account.telegram_user_id);
		if (!sender) {
			db.prepare('UPDATE pending_voice SET done = 1 WHERE id = ?').run(job.id);
			telegramDiagnostic('voice_stopped', { ...context, stage, reason: 'sender_no_longer_approved' });
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
			telegramDiagnostic('voice_duplicate', { ...context, stage, recordingId: existing.recording_id, reason: 'already_attached' });
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
				telegramDiagnostic('voice_retry', { ...context, stage, reason: 'waiting_for_parent', retryAt: now + 30 });
				return true;
			}
			assertCanAppendRecordingAudio(db, job.study_id, target, sender);
		}
		stage = 'download';
		telegramDiagnostic('voice_download_started', { ...context, stage });
		savedPath = await download(job.file_id, path.join(directory, `study_${job.study_id}_voice_${job.id}.ogg`));
		telegramDiagnostic('voice_downloaded', { ...context, stage });
		stage = 'attach';
		if (!db.prepare('SELECT id FROM studies WHERE id = ?').get(job.study_id) ||
			db.prepare('SELECT 1 FROM telegram_voice_deletions WHERE chat_id = ? AND message_id = ?').get(job.chat_id, job.reply_message_id)) {
			if (fs.existsSync(savedPath)) fs.unlinkSync(savedPath);
			telegramDiagnostic('voice_stopped', { ...context, stage, reason: 'removed_during_download' });
			return true;
		}
		const currentJob = db.prepare('SELECT done FROM pending_voice WHERE id = ?').get(job.id);
		if (!currentJob) throw recordingError('Original voice no longer exists.', 404);
		if (currentJob.done) {
			if (fs.existsSync(savedPath)) fs.unlinkSync(savedPath);
			telegramDiagnostic('voice_stopped', { ...context, stage, reason: 'already_completed' });
			return true;
		}
		const recordingId = db.transaction(() => {
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
			return recording.id;
		})();
		attached = true;
		context.recordingId = recordingId;
		telegramDiagnostic('voice_attached', { ...context, stage });
		stage = 'refresh';
		await notify(getStudyDetail(db, job.study_id));
	} catch (error) {
		if (attached) {
			telegramDiagnostic('voice_notification_failed', { ...context, stage, reason: 'attached', ...telegramErrorDetails(error) });
			return true;
		}
		if (savedPath && fs.existsSync(savedPath)) fs.unlinkSync(savedPath);
		if ([403, 404, 409].includes(error.status) && !/being processed/.test(error.message)) {
			db.prepare('UPDATE pending_voice SET done = 1 WHERE id = ?').run(job.id);
			telegramDiagnostic('voice_rejected', { ...context, stage, reason: 'policy_rejected', ...telegramErrorDetails(error) });
			await reply(job.chat_id, `Audio not attached: ${error.message}`, job.reply_message_id).catch(() => {});
		} else {
			const result = db.prepare('UPDATE pending_voice SET process_at = ? WHERE id = ? AND done = 0').run(now + 30, job.id);
			telegramDiagnostic(result.changes ? 'voice_retry' : 'voice_stopped', {
				...context, stage, reason: result.changes ? 'retryable_failure' : 'already_completed',
				retryAt: result.changes ? now + 30 : undefined, ...telegramErrorDetails(error)
			});
		}
	}
	return true;
}

let worker;
export function startVoiceWorker(getDb) {
	if (worker) return;
	let busy = false;
	worker = setInterval(async () => {
		if (busy || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
		busy = true;
		try {
			await runBackgroundTask(async () => {
				const db = getDb();
				await processTelegramVoiceDeletion(db);
				await processVoiceJob(db);
			});
		} catch (error) {
			telegramDiagnostic('voice_worker_failed', { stage: 'worker', ...telegramErrorDetails(error) });
		} finally {
			busy = false;
		}
	}, 1000);
	worker.unref();
}
