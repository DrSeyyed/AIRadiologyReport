import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const db = new Database('db/pacs.db');
db.pragma('foreign_keys = ON');

const userExists = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@hospital.test');
let adminId;
if (!userExists) {
  const info = db.prepare(`
    INSERT INTO users (full_name, role, email) VALUES (?, ?, ?)
  `).run('System Admin', 'admin', 'admin@hospital.test');
  adminId = info.lastInsertRowid;
} else {
  adminId = userExists.id;
}

// If no credentials yet, add default admin login
const cred = db.prepare('SELECT 1 FROM auth_credentials WHERE user_id = ?').get(adminId);
if (!cred) {
  const hash = bcrypt.hashSync('change-me-please', 10);
  db.prepare(`
    INSERT INTO auth_credentials (user_id, username, password_hash)
    VALUES (?, ?, ?)
  `).run(adminId, 'admin', hash);
}

console.log('🌱 Seeded admin user with credentials (username: admin, password: change-me-please). Update this ASAP.');
