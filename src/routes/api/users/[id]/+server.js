import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { updateAccount, removeAccount } from '$lib/server/user-accounts.js';

export async function PATCH({ locals, params, request, cookies }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.user.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
	try {
		return json(
			await updateAccount(
				getDb(),
				locals.user,
				Number(params.id),
				await request.json().catch(() => null),
				{ sessionId: cookies.get('session') }
			)
		);
	} catch (error) {
		return json(
			{ error: error.status ? error.message : 'Account update failed' },
			{ status: error.status || 500 }
		);
	}
}
export async function DELETE({ locals, params }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.user.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
	try {
		return json(removeAccount(getDb(), locals.user, Number(params.id)));
	} catch (error) {
		return json(
			{ error: error.status ? error.message : 'Account removal failed' },
			{ status: error.status || 500 }
		);
	}
}
