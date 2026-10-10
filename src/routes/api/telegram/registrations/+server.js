import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { listTelegramRegistrations } from '$lib/server/telegram-registration.js';
export function GET({ locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.user.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
	return json({
		registrations: listTelegramRegistrations(getDb()),
		telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
		webhookConfigured: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET)
	});
}
