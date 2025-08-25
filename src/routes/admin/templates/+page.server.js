import { getDb } from '$lib/server/db';

export async function load({ locals }) {
  if (!locals.user || locals.user.role !== 'admin') {
    return { status: 302, redirect: '/login' }; // or throw redirect(302, '/login')
  }
  const db = getDb();
  const modalities = db.prepare(`SELECT id, code, name FROM modalities ORDER BY code`).all();
  const exam_types = db.prepare(`SELECT id, code, name FROM exam_types ORDER BY name`).all();
  const templates = db.prepare(`
    SELECT
      rt.id, rt.modality_id, rt.exam_type_id, rt.text,
      m.code AS modality_code, m.name AS modality_name,
      et.name AS exam_type_name, et.code AS exam_type_code
    FROM report_templates rt
    JOIN modalities m ON m.id = rt.modality_id
    JOIN exam_types et ON et.id = rt.exam_type_id
    ORDER BY m.code, et.name
  `).all();

  return { modalities, exam_types, templates };
}
