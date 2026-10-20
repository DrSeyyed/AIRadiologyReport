import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { queueTelegramStudyRefresh, telegramRefreshStatus } from '$lib/server/telegram-study-refresh.js';

function forbidden(user) {
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (user.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
}

export function GET({ locals }) {
	const denied = forbidden(locals.user);
	if (denied) return denied;
	return json(telegramRefreshStatus(getDb()));
}

export function POST({ locals }) {
	const denied = forbidden(locals.user);
	if (denied) return denied;
	try {
		return json(queueTelegramStudyRefresh(getDb()));
	} catch (error) {
		return json({ error: error.status ? error.message : 'Unable to queue Telegram study refresh.' }, { status: error.status || 500 });
	}
}
