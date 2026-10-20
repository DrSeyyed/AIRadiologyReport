import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { getSigningDelegates, updateSigningDelegates } from '$lib/server/attending-delegates.js';

function respond(locals, operation) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	try {
		return json(operation(getDb(), locals.user));
	} catch (error) {
		return json({ error: error.status ? error.message : 'Unable to update signing delegates' }, { status: error.status || 500 });
	}
}

export function GET({ locals }) {
	return respond(locals, getSigningDelegates);
}

export async function PUT({ locals, request }) {
	const input = await request.json().catch(() => null);
	return respond(locals, (db, actor) => updateSigningDelegates(db, actor, input));
}
