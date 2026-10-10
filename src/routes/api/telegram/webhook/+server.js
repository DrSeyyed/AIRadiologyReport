import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { queueVoiceReply } from '$lib/server/voice-worker.js';
import {
	validateTelegramWebhook,
	handleTelegramRegistration,
	getApprovedTelegramUser
} from '$lib/server/telegram-registration.js';
import { sendBotMessage } from '$lib/server/telegram.js';

export const POST = async ({ request }) => {
	try {
		validateTelegramWebhook(request.headers);
		if (!process.env.TELEGRAM_BOT_TOKEN)
			return json({ error: 'Configure TELEGRAM_BOT_TOKEN.' }, { status: 503 });
		const update = await request.json().catch(() => ({}));
		const msg = update?.message;
		if (!msg) return json({ ok: true });
		const db = getDb();
		if (msg.chat?.type === 'private') {
			await handleTelegramRegistration(db, msg);
			return json({ ok: true });
		}
		if (
			!process.env.TELEGRAM_CHAT_ID ||
			String(msg.chat?.id) !== process.env.TELEGRAM_CHAT_ID ||
			!msg.reply_to_message?.message_id ||
			!(msg.voice || msg.audio)
		)
			return json({ ok: true });
		const sender = getApprovedTelegramUser(db, msg.from?.id);
		if (msg.from?.is_bot || !sender) {
			await sendBotMessage(
				msg.chat.id,
				'Audio not attached: register with this bot in a private chat using /register and wait for administrator approval.',
				msg.message_id
			).catch(() => {});
			return json({ ok: true });
		}
		if (sender.role === 'typist') {
			await sendBotMessage(
				msg.chat.id,
				'Typist accounts manage studies and uploads on the website. Only approved residents and attendings can attach Telegram audio.',
				msg.message_id
			).catch(() => {});
			return json({ ok: true });
		}
		queueVoiceReply(db, msg);
		return json({ ok: true });
	} catch (error) {
		return json(
			{ error: error.status ? error.message : 'Telegram update could not be processed.' },
			{ status: error.status || 500 }
		);
	}
};
