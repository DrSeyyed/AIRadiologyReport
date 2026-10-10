import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const db = new Database('db/pacs.db');
db.pragma('foreign_keys = ON');

const userExists = db
	.prepare(
		"SELECT u.id FROM users u LEFT JOIN auth_credentials ac ON ac.user_id=u.id WHERE u.role='admin' ORDER BY (ac.user_id IS NOT NULL) DESC,u.id LIMIT 1"
	)
	.get();
let adminId;
if (!userExists) {
	const info = db
		.prepare(
			`
    INSERT INTO users (full_name, role) VALUES (?, ?)
  `
		)
		.run('System Admin', 'admin');
	adminId = info.lastInsertRowid;
} else {
	adminId = userExists.id;
}

// If no credentials yet, add default admin login
const cred = db.prepare('SELECT 1 FROM auth_credentials WHERE user_id = ?').get(adminId);
if (!cred) {
	const hash = bcrypt.hashSync('change-me-please', 10);
	db.prepare(
		`
    INSERT INTO auth_credentials (user_id, username, password_hash)
    VALUES (?, ?, ?)
  `
	).run(adminId, 'admin', hash);
}

console.log(
	cred
		? '🌱 Existing administrator credentials retained.'
		: '🌱 Seeded default administrator credentials. Change the password immediately.'
);
db.close();
