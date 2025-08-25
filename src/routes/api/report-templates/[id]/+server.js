import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';

export async function DELETE({ params, locals }) {
  if (!locals.user || locals.user.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }
  const db = getDb();
  const id = Number(params.id);
  const info = db.prepare(`DELETE FROM report_templates WHERE id=?`).run(id);
  if (info.changes === 0) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  return json({ ok: true });
}
