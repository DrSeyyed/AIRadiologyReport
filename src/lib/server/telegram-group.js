import { deleteMessage, editStudyMessage, sendBotMessage } from './telegram.js';
import { getStudyDetail } from './studies.js';
import { queueVoiceReply } from './voice-worker.js';
import { getApprovedTelegramUser } from './telegram-registration.js';
import { trackStudyReply, telegramReplyMessageId } from './telegram-replies.js';

export async function handleTelegramGroupMessage(db, message, {
	remove = deleteMessage,
	refresh = editStudyMessage,
	notify = sendBotMessage
} = {}) {
	if (!process.env.TELEGRAM_CHAT_ID || String(message.chat?.id) !== process.env.TELEGRAM_CHAT_ID || !message.message_id)
		return false;
	if (['forum_topic_created', 'forum_topic_edited', 'forum_topic_closed', 'forum_topic_reopened',
		'general_forum_topic_hidden', 'general_forum_topic_unhidden'].some((key) => message[key])) return false;
	const indexPost = db.prepare('SELECT 1 FROM telegram_index_pages WHERE chat_id = ? AND message_id = ?')
		.get(String(message.chat.id), message.message_id);
	if (indexPost) return false;
	const studyPost = db.prepare('SELECT id FROM studies WHERE telegram_message_id IN (?, ?)')
		.get(String(message.message_id), `${message.message_id}.0`);
	if (studyPost) return false;
	if (!(message.voice || message.audio)) {
		await remove(message.message_id, message.chat.id);
		return true;
	}
	if (!telegramReplyMessageId(message)) return false;
	const studyId = trackStudyReply(db, message);
	const sender = getApprovedTelegramUser(db, message.from?.id);
	let rejection = '';
	if (message.from?.is_bot || !sender)
		rejection = 'Audio not attached: account not approved. Register privately with /register.';
	else if (sender.role === 'typist') rejection = 'Typists cannot attach Telegram audio.';
	else {
		try {
			queueVoiceReply(db, message);
		} catch (error) {
			if (![400, 403, 404, 409].includes(error.status)) throw error;
			rejection = `Audio not attached: ${error.message}`;
		}
	}
	if (rejection) await notify(message.chat.id, rejection, message.message_id).catch(() => {});
	if (studyId) await refresh(getStudyDetail(db, studyId), message.chat.id);
	return true;
}
