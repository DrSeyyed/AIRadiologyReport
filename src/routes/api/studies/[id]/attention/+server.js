import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { canUpdateStudyAttention } from '$lib/study-permissions.js';
import { getStudyDetail } from '$lib/server/studies.js';
import { editStudyMessage } from '$lib/server/telegram.js';

export async function PATCH({ params, request, locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (!canUpdateStudyAttention(locals.user)) return json({ error: 'Forbidden' }, { status: 403 });
	if (!/^[1-9]\d*$/.test(params.id) || !Number.isSafeInteger(Number(params.id)))
		return json({ error: 'Invalid study ID' }, { status: 400 });
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}
	if (!body || typeof body.needs_attention !== 'boolean' || typeof body.attention_note !== 'string')
		return json({ error: 'Provide a checkbox value and a text description.' }, { status: 400 });
	const note = body.attention_note.trim();
	if (note.length > 300)
		return json({ error: 'Description must be 300 characters or fewer.' }, { status: 400 });
	const db = getDb();
	const current = db.prepare('SELECT disabled FROM studies WHERE id = ?').get(Number(params.id));
	if (current?.disabled) return json({ error: 'This study is disabled.' }, { status: 409 });
	const result = db.prepare(
		'UPDATE studies SET needs_attention = ?, attention_note = ? WHERE id = ?'
	).run(Number(body.needs_attention), note, Number(params.id));
	if (!result.changes) return json({ error: 'Study not found' }, { status: 404 });
	const study = getStudyDetail(db, Number(params.id));
	let notification_warning = null;
	if (study?.telegram_message_id) {
		try {
			await editStudyMessage(study);
		} catch {
			notification_warning = 'Attention saved, but Telegram update failed.';
		}
	}
	return json({ needs_attention: Number(body.needs_attention), attention_note: note, notification_warning });
}
