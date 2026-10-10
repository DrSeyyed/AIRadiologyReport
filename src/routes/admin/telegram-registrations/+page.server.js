import { error, redirect } from '@sveltejs/kit';

export async function load({ locals, fetch }) {
	if (!locals.user) throw redirect(302, '/login');
	if (locals.user.role !== 'admin') throw error(403, 'Administrator access required');
	const response = await fetch('/api/telegram/registrations');
	const result = await response.json().catch(() => ({}));
	if (!response.ok) throw error(response.status, result.error || 'Unable to load Telegram registrations');
	return {
		registrations: result.registrations ?? [],
		telegramConfigured: result.telegramConfigured === true,
		webhookConfigured: result.webhookConfigured === true
	};
}
