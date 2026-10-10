import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { getAccount, updateAccount } from '$lib/server/user-accounts.js';

export function GET({ locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const user = getAccount(getDb(), locals.user.id);
	return user ? json(user) : json({ error: 'Unauthorized' }, { status: 401 });
}
export async function PATCH({ locals, request, cookies }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	try {
		return json(
			await updateAccount(
				getDb(),
				locals.user,
				locals.user.id,
				await request.json().catch(() => null),
				{ selfOnly: true, sessionId: cookies.get('session') }
			)
		);
	} catch (error) {
		return json(
			{ error: error.status ? error.message : 'Account update failed' },
			{ status: error.status || 500 }
		);
	}
}
