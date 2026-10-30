import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import {
	validateTelegramWebhook,
	handleTelegramRegistration
} from '$lib/server/telegram-registration.js';
import { handleTelegramGroupMessage } from '$lib/server/telegram-group.js';

export const POST = async ({ request }) => {
	try {
		validateTelegramWebhook(request.headers);
		if (!process.env.TELEGRAM_BOT_TOKEN)
			return json({ error: 'Configure TELEGRAM_BOT_TOKEN.' }, { status: 503 });
		const update = await request.json().catch(() => ({}));
		const msg = update?.message || update?.edited_message;
		if (!msg) return json({ ok: true });
		const db = getDb();
		if (msg.chat?.type === 'private') {
			if (update.message) await handleTelegramRegistration(db, msg);
			return json({ ok: true });
		}
		await handleTelegramGroupMessage(db, msg, { allowDelete: Boolean(update.message) });
		return json({ ok: true });
	} catch (error) {
		return json(
			{ error: error.status ? error.message : 'Telegram update could not be processed.' },
			{ status: error.status || 500 }
		);
	}
};
