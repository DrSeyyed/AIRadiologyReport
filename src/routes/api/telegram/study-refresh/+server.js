import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { queueTelegramStudyRefresh, telegramRefreshStatus, cancelTelegramStudyRefresh } from '$lib/server/telegram-study-refresh.js';

function forbidden(user) {
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (user.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
}

export function GET({ locals }) {
	const denied = forbidden(locals.user);
	if (denied) return denied;
	return json(telegramRefreshStatus(getDb()));
}

export function DELETE({ locals }) {
	const denied = forbidden(locals.user);
	if (denied) return denied;
	try {
		return json(cancelTelegramStudyRefresh(getDb()));
	} catch {
		return json({ error: 'Unable to cancel Telegram study refresh.' }, { status: 500 });
	}
}

export async function POST({ locals, request }) {
	const denied = forbidden(locals.user);
	if (denied) return denied;
	let filters;
	try {
		filters = await request.json();
	} catch {
		return json({ error: 'Invalid refresh request. Send a JSON object with examination date filters.' }, { status: 400 });
	}
	try {
		return json(queueTelegramStudyRefresh(getDb(), null, filters));
	} catch (error) {
		return json({ error: error.status ? error.message : 'Unable to queue Telegram study refresh.' }, { status: error.status || 500 });
	}
}
