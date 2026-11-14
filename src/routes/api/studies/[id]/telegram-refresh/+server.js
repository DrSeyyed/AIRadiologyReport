import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { queueTelegramStudyRefresh } from '$lib/server/telegram-study-refresh.js';

export function POST({ params, locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.user.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
	if (!/^[1-9]\d*$/.test(params.id) || !Number.isSafeInteger(Number(params.id)))
		return json({ error: 'Invalid study ID' }, { status: 400 });
	try {
		return json(queueTelegramStudyRefresh(getDb(), Number(params.id)));
	} catch (error) {
		return json({ error: error.status ? error.message : 'Unable to queue Telegram study refresh.' }, { status: error.status || 500 });
	}
}
