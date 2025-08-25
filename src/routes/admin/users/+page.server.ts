// Admin-only page and preload current users (for a small table)
import { redirect } from '@sveltejs/kit';

export async function load({ locals, fetch }) {
  if (!locals.user) throw redirect(302, '/login');
  if (locals.user.role !== 'admin') throw redirect(302, '/'); // or 403

  const res = await fetch('/api/users'); // shows username too (from our earlier code)
  const users = await res.json();

  return { users };
}