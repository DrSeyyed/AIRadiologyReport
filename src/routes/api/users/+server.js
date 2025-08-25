import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import bcrypt from 'bcryptjs';
import { requireRole } from '$lib/server/auth';


export async function GET({ url }) {
  const role = url.searchParams.get('role'); // optional
  const db = getDb();

  let sql = `SELECT u.id, u.full_name, u.role,
                    ac.username
             FROM users u
             LEFT JOIN auth_credentials ac ON ac.user_id = u.id`;
  const params = [];
  if (role) { sql += ` AND u.role = ?`; params.push(role); }
  sql += ` ORDER BY u.full_name`;

  const rows = db.prepare(sql).all(...params);
  return json(rows);
}

export async function POST({ request, locals }) {
  // admin-only
  requireRole(locals, ['admin']);

  const db = getDb();
  const body = await request.json();
  const { full_name, role, email, username, password } = body;

  if (!full_name || !role || !username || !password) {
    return new Response(JSON.stringify({ error: 'full_name, role, username, password are required' }), { status: 400 });
  }

  const tx = db.transaction(() => {
    const userInfo = db.prepare(
      `INSERT INTO users (full_name, role, email) VALUES (@full_name, @role, @email)`
    ).run({ full_name, role, email });

    const userId = userInfo.lastInsertRowid;



    if (String(username).length < 3) throw new Error('Username must be at least 3 characters');
    if (String(password).length < 6) throw new Error('Password must be at least 6 characters');
    const password_hash = bcrypt.hashSync(password, 10);
    db.prepare(
      `INSERT INTO auth_credentials (user_id, username, password_hash) VALUES (?, ?, ?)`
    ).run(userId, username, password_hash);

    return userId;
  });

  try {
    const userId = tx();
    const row = db.prepare(`
      SELECT u.id, u.full_name, u.role, u.email, ac.username
      FROM users u
      LEFT JOIN auth_credentials ac ON ac.user_id = u.id
      WHERE u.id = ?
    `).get(userId);
    return json(row, { status: 201 });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || 'Failed to create user' }), { status: 400 });
  }
}
