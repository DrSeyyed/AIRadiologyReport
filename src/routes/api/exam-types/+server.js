import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';

export async function GET() {
  const rows = getDb().prepare('SELECT * FROM exam_types ORDER BY name').all();
  return json(rows);
}