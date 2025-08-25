import { redirect } from '@sveltejs/kit';

export async function load({ locals, fetch }) {
  if (!locals.user) throw redirect(302, '/login');
  if (locals.user.role !== 'admin') throw redirect(302, '/'); // or 403

  const res = await fetch('/api/patients'); // shows username too (from our earlier code)
  const patients = await res.json();

  return { patients };
}