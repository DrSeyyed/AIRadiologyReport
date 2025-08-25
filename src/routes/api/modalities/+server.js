import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';

export async function GET() {
  const rows = getDb().prepare('SELECT * FROM modalities ORDER BY code').all();
  return json(rows);
}