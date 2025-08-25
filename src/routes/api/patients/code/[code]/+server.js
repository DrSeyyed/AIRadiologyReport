import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';

export async function GET({ params }) {
  console.log(params)
  const patient_code = params.code;
  if (!patient_code) return json({ error: 'Missing code in URL' }, { status: 400 });

  const db = getDb();

  const row = db
    .prepare(
      `SELECT id, patient_code, firstname, lastname, gender, birth_year
       FROM patients
       WHERE patient_code = ?
       LIMIT 1`
    )
    .get(patient_code);

  if (!row) return json({ error: 'Not found' }, { status: 404 });

  return json({
    id: row.id,
    patient_code: row.patinet_code,
    firstname: row.firstname,
    lastname: row.lastname,
    gender: row.gender,
    birth_year: row.birth_year
  });
}