import { getStudyDetail, normalizeStudyInput, studyFields } from '$lib/server/studies.js';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { editStudyMessage, deleteMessage } from '$lib/server/telegram.js';

// Optionally fetch one study
export async function GET({ params, locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const db = getDb();
	const id = Number(params.id);
	const row = getStudyDetail(db, id);
	if (!row) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });

	return json(row);
}

export async function PATCH({ params, request, locals }) {
 if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
 const db = getDb();
 const id = Number(params.id);
 const current = getStudyDetail(db, id);
 if (!current) return json({ error: 'Study not found' }, { status: 404 });
 try {
  const body = await request.json();
  const changes = Object.fromEntries(studyFields.filter((field) => field in body).map((field) => [field, body[field]]));
  if (!Object.keys(changes).length) return json({ error: 'Nothing to update' }, { status: 400 });
  const payload = normalizeStudyInput(db, { ...current, ...changes });
  db.prepare('UPDATE studies SET ' + studyFields.map((field) => field + ' = @' + field).join(', ') + ' WHERE id = @id').run({ ...payload, id });
  const detail = getStudyDetail(db, id);
  let notification_warning = null;
  if (detail.telegram_message_id) {
   try { await editStudyMessage(detail); }
   catch { notification_warning = 'Study saved, but Telegram update failed.'; }
  }
  return json({ ...detail, notification_warning });
 } catch (error) {
  return json({ error: error.message || 'Update failed' }, { status: 400 });
 }
}

export async function DELETE({ params, locals }) {
	if (!locals.user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
	const db = getDb();
	const id = Number(params.id);
	const detail = getStudyDetail(db, id);
	const info = db.prepare(`DELETE FROM studies WHERE id = ?`).run(id);
	if (info.changes === 0) {
		return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
	}
	if (detail.telegram_message_id) {
		try { await deleteMessage(detail.telegram_message_id); }
		catch { /* Deletion remains successful if the optional notification fails. */ }
	}
	return json({ ok: true });
}
