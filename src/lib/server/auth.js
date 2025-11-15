import { randomBytes } from 'node:crypto';
import { getDb } from './db.js';

/** Session lifetime in days */
const SESSION_DAYS = 7;

/** ISO string (UTC) add days */
function addDaysISO(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/** Create a new session and return { id, user, expires_at } */
export function createSession(userId) {
  const db = getDb();
  const id = randomBytes(32).toString('hex'); // 64-char hex
  const expires_at = addDaysISO(SESSION_DAYS);

  db.prepare(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`
  ).run(id, userId, expires_at);

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);

  return { id, user, expires_at };
}

/** Look up session by id; returns { user, session } or null */
export function getSession(sessionId) {
  if (!sessionId) return null;
  const db = getDb();

  const session = db
    .prepare(
      `SELECT session_id, user_id, full_name, role, email, created_at, expires_at
       FROM v_user_sessions
       WHERE session_id = ?`
    )
    .get(sessionId);

  if (!session) return null;

  // Expired?
  const now = Date.now();
  if (new Date(session.expires_at).getTime() <= now) {
    try {
      destroySession(sessionId);
    } catch {}
    return null;
  }

  return {
    session: {
      id: session.session_id,
      user_id: session.user_id,
      expires_at: session.expires_at
    },
    user: {
      id: session.user_id,
      full_name: session.full_name,
      role: session.role,
      email: session.email
    }
  };
}

/** Destroy a session by id */
export function destroySession(sessionId) {
  if (!sessionId) return;
  const db = getDb();
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
}

/** Throw 401 if not logged in; return user if logged in */
export function requireUser(locals) {
  if (!locals.user) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
  return locals.user;
}

/** Throw 403 if user role not allowed */
export function requireRole(locals, roles) {
  const user = requireUser(locals);
  if (!roles.includes(user.role)) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  return user;
}
