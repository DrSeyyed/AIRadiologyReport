import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import {
	validateTelegramWebhook,
	handleTelegramRegistration
} from '$lib/server/telegram-registration.js';
import { handleTelegramGroupMessage } from '$lib/server/telegram-group.js';
import { handleTelegramPrivateMenu, isTelegramPrivateMessage } from '$lib/server/telegram-private-menu.js';
import {
	isSiteMaintenanceEnabled,
	maintenanceTelegramContext
} from '$lib/server/site-maintenance.js';
import { createMaintenanceTelegramResponder } from '$lib/server/maintenance-telegram.js';

const respondDuringMaintenance = createMaintenanceTelegramResponder();

export const POST = async ({ request }) => {
	try {
		validateTelegramWebhook(request.headers);
		if (!process.env.TELEGRAM_BOT_TOKEN)
			return json({ error: 'Configure TELEGRAM_BOT_TOKEN.' }, { status: 503 });
		const update = await request.json().catch(() => ({}));
		if (isSiteMaintenanceEnabled()) {
			await respondDuringMaintenance(update, maintenanceTelegramContext());
			return json({ ok: true });
		}
		if (update?.callback_query) {
			if (update.callback_query.message?.chat?.type === 'private')
				await handleTelegramPrivateMenu(getDb(), update);
			return json({ ok: true });
		}
		const msg = update?.message || update?.edited_message;
		if (!msg) return json({ ok: true });
		const db = getDb();
		if (msg.chat?.type === 'private') {
			if (update.message && isTelegramPrivateMessage(msg) && !await handleTelegramPrivateMenu(db, update))
				await handleTelegramRegistration(db, msg);
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
