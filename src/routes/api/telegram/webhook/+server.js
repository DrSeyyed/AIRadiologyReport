import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { queueVoiceReply } from '$lib/server/voice-worker.js';

export const POST = async ({ request }) => {
	const update = await request.json().catch(() => ({}));
	const msg = update?.message;
	if (!msg) return json({ ok: true });

	const reply = msg.reply_to_message;
	if (!reply?.message_id || !msg.chat?.id) return json({ ok: true });

	if (!process.env.TELEGRAM_CHAT_ID || String(msg.chat.id) !== process.env.TELEGRAM_CHAT_ID)
		return json({ ok: true });
	queueVoiceReply(getDb(), msg);

	return json({ ok: true });
};
