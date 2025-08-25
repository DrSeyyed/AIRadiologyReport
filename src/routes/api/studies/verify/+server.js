import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { requireRole } from '$lib/server/auth';

export async function POST({ request, locals }) {
  // Only resident or attending may verify
  const user = requireRole(locals, ['resident', 'attending']);

  const { study_id, field, value } = await request.json();
  // field: 'resident_checked' or 'attending_checked'
  if (!study_id || !['resident_checked','attending_checked'].includes(field)) {
    return new Response(JSON.stringify({ error: 'Invalid payload' }), { status: 400 });
  }
  const v = value ? 1 : 0;

  const db = getDb();
  const stmt = db.prepare(`UPDATE studies SET ${field} = ? WHERE id = ?`);
  const info = stmt.run(v, study_id);
  if (info.changes === 0) {
    return new Response(JSON.stringify({ error: 'Study not found' }), { status: 404 });
  }

  const row = db.prepare(`SELECT id, resident_checked, attending_checked FROM studies WHERE id = ?`).get(study_id);
  return json({ ok: true, study: row, by: { id: user.id, role: user.role } });
}
