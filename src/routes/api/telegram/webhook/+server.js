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
import { telegramDiagnostic, telegramErrorDetails } from '$lib/server/telegram-diagnostics.js';
import { telegramReplyMessageId } from '$lib/server/telegram-replies.js';

const respondDuringMaintenance = createMaintenanceTelegramResponder();

export const POST = async ({ request }) => {
	const context = {};
	let stage = 'authenticate';
	const acknowledge = (reason) => {
		telegramDiagnostic('webhook_completed', { ...context, stage, reason, httpStatus: 200 });
		return json({ ok: true });
	};
	try {
		validateTelegramWebhook(request.headers);
		if (!process.env.TELEGRAM_BOT_TOKEN) {
			telegramDiagnostic('webhook_failed', { stage, reason: 'missing_token', httpStatus: 503 });
			return json({ error: 'Configure TELEGRAM_BOT_TOKEN.' }, { status: 503 });
		}
		stage = 'parse';
		const update = await request.json().catch(() => {
			telegramDiagnostic('webhook_ignored', { stage, reason: 'invalid_json' });
			return {};
		});
		const msg = update?.message || update?.edited_message;
		Object.assign(context, {
			updateId: update?.update_id,
			messageId: msg?.message_id,
			replyMessageId: msg ? telegramReplyMessageId(msg) : undefined,
			kind: update?.callback_query ? 'callback_query' : update?.message ? 'message' : update?.edited_message ? 'edited_message' : 'other',
			media: msg?.voice ? 'voice' : msg?.audio ? 'audio' : 'other'
		});
		telegramDiagnostic('webhook_received', context);
		if (isSiteMaintenanceEnabled()) {
			stage = 'maintenance';
			await respondDuringMaintenance(update, maintenanceTelegramContext());
			return acknowledge('maintenance');
		}
		if (update?.callback_query) {
			stage = 'private';
			if (update.callback_query.message?.chat?.type === 'private')
				await handleTelegramPrivateMenu(getDb(), update);
			return acknowledge();
		}
		if (!msg) {
			telegramDiagnostic('webhook_ignored', { ...context, reason: 'unsupported_update' });
			return acknowledge('unsupported_update');
		}
		stage = msg.chat?.type === 'private' ? 'private' : 'group';
		const db = getDb();
		if (msg.chat?.type === 'private') {
			if (update.message && isTelegramPrivateMessage(msg) && !await handleTelegramPrivateMenu(db, update))
				await handleTelegramRegistration(db, msg);
			return acknowledge();
		}
		await handleTelegramGroupMessage(db, msg, { allowDelete: Boolean(update.message) });
		return acknowledge();
	} catch (error) {
		telegramDiagnostic('webhook_failed', { ...context, stage, ...telegramErrorDetails(error), httpStatus: error.status || 500 });
		return json(
			{ error: error.status ? error.message : 'Telegram update could not be processed.' },
			{ status: error.status || 500 }
		);
	}
};
