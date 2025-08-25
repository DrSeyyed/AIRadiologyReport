import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';

export async function GET() {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM patients ORDER BY lastname, firstname`).all();
  return json(rows);
}

export async function POST({ request }) {
  const body = await request.json();
  const { patient_code, firstname, lastname, gender, birth_year } = body;

  if (!patient_code || !firstname || !lastname || !gender || !birth_year) {
    return new Response(JSON.stringify({ error: 'firstname, lastname, gender are required' }), { status: 400 });
  }

  const stmt = getDb().prepare(`
    INSERT INTO patients (patient_code, firstname, lastname, gender, birth_year)
    VALUES (@patient_code, @firstname, @lastname, @gender, @birth_year)
  `);
  const info = stmt.run({ patient_code, firstname, lastname, gender, birth_year });
  const row = getDb().prepare('SELECT * FROM patients WHERE id = ?').get(info.lastInsertRowid);
  return json(row, { status: 201 });
}