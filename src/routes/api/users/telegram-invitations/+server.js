import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { queueGroupInvitations, validateInvitationUserIds } from '$lib/server/telegram-invitations.js';

export async function POST({ locals, request }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.user.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
	try {
		const body = await request.json().catch(() => null);
		const ids = validateInvitationUserIds(body?.user_ids);
		return json(await queueGroupInvitations(getDb(), ids));
	} catch (error) {
		return json({ error: error.status === 400 ? error.message : 'Unable to queue invitations. Check the study group and bot invite permissions.' }, { status: error.status || 503 });
	}
}
