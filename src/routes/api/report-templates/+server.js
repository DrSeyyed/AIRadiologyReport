import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';

// List templates (joined with names for UI)
export async function GET() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      rt.id, rt.modality_id, rt.exam_type_id, rt.text,
      m.code AS modality_code, m.name AS modality_name,
      et.name AS exam_type_name, et.code AS exam_type_code
    FROM report_templates rt
    JOIN modalities m ON m.id = rt.modality_id
    JOIN exam_types et ON et.id = rt.exam_type_id
    ORDER BY m.code, et.name
  `).all();

  return json(rows);
}

// Create or update (by unique (modality_id, exam_type_id) OR by id)
export async function POST({ request, locals }) {
  if (!locals.user || locals.user.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }
  const db = getDb();
  const body = await request.json();
  const { id, modality_id, exam_type_id, text } = body || {};

  if (!modality_id || !exam_type_id || typeof text !== 'string') {
    return new Response(JSON.stringify({ error: 'modality_id, exam_type_id and text are required' }), { status: 400 });
  }

  // If you created a UNIQUE index on (modality_id, exam_type_id) you can use UPSERT:
  // db.prepare(`
  //   INSERT INTO report_templates (modality_id, exam_type_id, text)
  //   VALUES (?, ?, ?)
  //   ON CONFLICT(modality_id, exam_type_id) DO UPDATE SET text=excluded.text
  // `).run(modality_id, exam_type_id, text);

  if (id) {
    const info = db.prepare(`UPDATE report_templates SET modality_id=?, exam_type_id=?, text=? WHERE id=?`)
      .run(modality_id, exam_type_id, text, id);
    if (info.changes === 0) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  } else {
    // Upsert-by-pair if no unique index: try update first
    const found = db.prepare(`
      SELECT id FROM report_templates WHERE modality_id=? AND exam_type_id=? LIMIT 1
    `).get(modality_id, exam_type_id);
    if (found) {
      db.prepare(`UPDATE report_templates SET text=? WHERE id=?`).run(text, found.id);
    } else {
      db.prepare(`INSERT INTO report_templates (modality_id, exam_type_id, text) VALUES (?, ?, ?)`)
        .run(modality_id, exam_type_id, text);
    }
  }

  const row = db.prepare(`
    SELECT rt.id, rt.modality_id, rt.exam_type_id, rt.text,
           m.code AS modality_code, m.name AS modality_name,
           et.name AS exam_type_name, et.code AS exam_type_code
    FROM report_templates rt
    JOIN modalities m ON m.id = rt.modality_id
    JOIN exam_types et ON et.id = rt.exam_type_id
    WHERE rt.modality_id=? AND rt.exam_type_id=? LIMIT 1
  `).get(modality_id, exam_type_id);

  return json(row);
}
