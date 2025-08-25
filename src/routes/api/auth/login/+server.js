import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import bcrypt from 'bcryptjs';
import { createSession } from '$lib/server/auth';

export async function POST({ request, cookies }) {
  const { username, password } = await request.json();
  if (!username || !password) {
    return new Response(JSON.stringify({ error: 'username and password are required' }), { status: 400 });
  }

  const db = getDb();
  const row = db.prepare(`
    SELECT u.id, u.full_name, u.role, u.email, ac.password_hash
    FROM auth_credentials ac
    JOIN users u ON u.id = ac.user_id
    WHERE ac.username = ?
  `).get(username);

  if (!row) {
    return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 });
  }

  const ok = bcrypt.compareSync(password, row.password_hash);
  if (!ok) {
    return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 });
  }

  const { id: sessionId, user, expires_at } = createSession(row.id);

  // Set cookie (HttpOnly, Secure, SameSite=Lax)
  cookies.set('session', sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: false,               // keep true in production; for local http you can temporarily set false
    expires: new Date(expires_at)
  });

  return json({ user });
}
