import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { reviewTelegramRegistration } from '$lib/server/telegram-registration.js';
import { sendBotMessage } from '$lib/server/telegram.js';
export async function PATCH({ locals, params, request }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.user.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
	try {
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object' || Array.isArray(body))
			return json({ error: 'Invalid review request' }, { status: 400 });
		const result = reviewTelegramRegistration(getDb(), Number(params.id), body);
		let notification_warning = result.link_warning || null;
		try {
			await sendBotMessage(
				result.registration.telegram_user_id,
				body.action === 'approve'
					? `Account approved (${result.user.role}). Website username: ${result.user.username}.`
					: 'Registration rejected. Send /register to reapply.'
			);
		} catch {
			notification_warning = [notification_warning, 'Review saved, but Telegram notification failed.'].filter(Boolean).join(' ');
		}
		return json({ ...result, notification_warning });
	} catch (error) {
		return json(
			{ error: error.message || 'Registration review failed' },
			{ status: error.status || 400 }
		);
	}
}
