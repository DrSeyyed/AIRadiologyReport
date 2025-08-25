import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPORT_DIR = 'uploads/reports';

export async function GET({ params, locals }) {
  if (!locals.user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  const id = Number(params.id);
  const db = getDb();
  const row = db.prepare(`SELECT text_report_path FROM studies WHERE id = ?`).get(id);
  let text = '';
  if (row?.text_report_path && existsSync(row.text_report_path)) {
    text = readFileSync(row.text_report_path, 'utf-8');
  }
  return json({ text });
}

export async function PUT({ params, request, locals }) {
  if (!locals.user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  const id = Number(params.id);
  const { text } = await request.json();

  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
  const path = join(REPORT_DIR, `study_${id}.txt`);
  writeFileSync(path, text ?? '', 'utf-8');

  const db = getDb();
  db.prepare(`UPDATE studies SET text_report_path = ? WHERE id = ?`).run(path, id);

  return json({ ok: true, path });
}
