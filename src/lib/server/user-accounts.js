import bcrypt from 'bcryptjs';

function failure(message, status = 400) {
	return Object.assign(new Error(message), { status });
}
export function getAccount(db, id) {
	return db
		.prepare(
			`SELECT u.id, u.full_name, u.role, u.telegram_user_id, ac.username
		FROM users u LEFT JOIN auth_credentials ac ON ac.user_id=u.id WHERE u.id=?`
		)
		.get(id);
}
function authorize(db, actor, id, selfOnly = false) {
	const current = actor && db.prepare('SELECT id,role FROM users WHERE id=?').get(actor.id);
	if (!current) throw failure('Unauthorized', 401);
	if (!Number.isSafeInteger(id) || id <= 0) throw failure('Invalid user ID');
	if ((selfOnly && current.id !== id) || (current.role !== 'admin' && current.id !== id))
		throw failure('Forbidden', 403);
	return current;
}
function validateInput(input, allowed) {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw failure('Invalid account request');
	if (Object.keys(input).some((key) => !allowed.includes(key)))
		throw failure('Unsupported account field');
}
function nameValue(value) {
	if (typeof value !== 'string' || !value.trim() || value.trim().length > 100)
		throw failure('Full name must be between 1 and 100 characters');
	return value.trim();
}
function usernameValue(value) {
	if (typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{2,31}$/.test(value))
		throw failure(
			'Username must be 3–32 lowercase letters, numbers, dots, underscores or hyphens, starting with a letter'
		);
	return value;
}
function passwordValue(value) {
	if (typeof value !== 'string' || value.length < 8 || Buffer.byteLength(value, 'utf8') > 72)
		throw failure('Password must be at least 8 characters and at most 72 UTF-8 bytes');
	return value;
}
function checkUsername(db, username, id = -1) {
	if (
		db
			.prepare(
				'SELECT user_id FROM auth_credentials WHERE username=? COLLATE NOCASE AND user_id!=?'
			)
			.get(username, id) ||
		db
			.prepare(
				"SELECT id FROM telegram_registrations WHERE username=? COLLATE NOCASE AND step IN ('password','pending')"
			)
			.get(username)
	)
		throw failure('That website username is unavailable', 409);
}
function protectAdmin(db, user, role) {
	if (
		user.role === 'admin' &&
		role !== 'admin' &&
		db.prepare("SELECT count(*) AS n FROM users WHERE role='admin'").get().n <= 1
	)
		throw failure('The last administrator cannot be removed or demoted', 409);
}
function protectReviewers(db, id, deleting = false) {
	const signed = db
		.prepare(
			`SELECT 1 FROM study_recordings r JOIN studies s ON s.id=r.study_id
		WHERE (r.resident_checked=1 OR r.attending_checked=1 OR r.processing=1) AND
		(r.corresponding_resident_id=? OR s.corresponding_attending_id=? OR r.sender_user_id=? OR
		r.resident_signed_by_user_id=? OR r.attending_signed_by_user_id=?) LIMIT 1`
		)
		.get(id, id, id, id, id);
	if (signed)
		throw failure(
			'This user is linked to signed or processing recordings. Finish processing and remove signatures before changing their role or removing them.',
			409
		);
	if (
		!deleting &&
		(db
			.prepare(
				'SELECT 1 FROM studies WHERE corresponding_attending_id=? OR corresponding_resident_id=? LIMIT 1'
			)
			.get(id, id) ||
			db
				.prepare('SELECT 1 FROM study_recordings WHERE corresponding_resident_id=? LIMIT 1')
				.get(id))
	)
		throw failure('Reassign this user’s studies and recordings before changing their role', 409);
}
export async function createAdminAccount(db, actor, input) {
	if (authorize(db, actor, actor?.id).role !== 'admin') throw failure('Forbidden', 403);
	validateInput(input, ['full_name', 'role', 'username', 'password']);
	if (input.role !== 'admin')
		throw failure(
			'Typists, residents and attendings must register privately with the Telegram bot and receive administrator approval'
		);
	const full_name = nameValue(input.full_name),
		username = usernameValue(input.username);
	const password_hash = await bcrypt.hash(passwordValue(input.password), 12);
	return db.transaction(() => {
		if (authorize(db, actor, actor.id).role !== 'admin') throw failure('Forbidden', 403);
		checkUsername(db, username);
		const id = Number(
			db.prepare('INSERT INTO users(full_name,role) VALUES(?,?)').run(full_name, 'admin')
				.lastInsertRowid
		);
		db.prepare('INSERT INTO auth_credentials(user_id,username,password_hash) VALUES(?,?,?)').run(
			id,
			username,
			password_hash
		);
		return getAccount(db, id);
	})();
}
export async function updateAccount(db, actor, id, input, { selfOnly = false, sessionId } = {}) {
	const current = authorize(db, actor, id, selfOnly);
	if (input && Object.hasOwn(input, 'role') && (selfOnly || current.role !== 'admin'))
		throw failure('Only administrators can change roles', 403);
	validateInput(input, ['full_name', 'username', 'password', ...(selfOnly ? [] : ['role'])]);
	const full_name = Object.hasOwn(input, 'full_name') ? nameValue(input.full_name) : undefined;
	const username = Object.hasOwn(input, 'username') ? usernameValue(input.username) : undefined;
	if (
		Object.hasOwn(input, 'role') &&
		!['admin', 'typist', 'resident', 'attending'].includes(input.role)
	)
		throw failure('Invalid role');
	let password_hash;
	if (Object.hasOwn(input, 'password') && input.password !== '')
		password_hash = await bcrypt.hash(passwordValue(input.password), 12);
	return db.transaction(() => {
		const fresh = authorize(db, actor, id, selfOnly);
		if (Object.hasOwn(input, 'role') && fresh.role !== 'admin')
			throw failure('Only administrators can change roles', 403);
		const user = getAccount(db, id);
		if (!user) throw failure('User not found', 404);
		const role = input.role ?? user.role;
		if (role !== user.role) {
			protectAdmin(db, user, role);
			protectReviewers(db, id);
		}
		const credentials = db
			.prepare('SELECT username,password_hash FROM auth_credentials WHERE user_id=?')
			.get(id);
		if (username !== undefined) checkUsername(db, username, id);
		if (
			!credentials &&
			(username !== undefined || password_hash !== undefined) &&
			(!username || !password_hash)
		)
			throw failure('Supply both username and password to enable this account’s website login');
		db.prepare('UPDATE users SET full_name=?,role=? WHERE id=?').run(
			full_name ?? user.full_name,
			role,
			id
		);
		if (credentials && (username !== undefined || password_hash !== undefined))
			db.prepare('UPDATE auth_credentials SET username=?,password_hash=? WHERE user_id=?').run(
				username ?? credentials.username,
				password_hash ?? credentials.password_hash,
				id
			);
		else if (!credentials && username && password_hash)
			db.prepare('INSERT INTO auth_credentials(user_id,username,password_hash) VALUES(?,?,?)').run(
				id,
				username,
				password_hash
			);
		db.prepare(
			"UPDATE telegram_registrations SET full_name=?,role=CASE WHEN ?='admin' THEN role ELSE ? END,username=?,updated_at=? WHERE user_id=? AND step='approved'"
		).run(
			full_name ?? user.full_name,
			role,
			role,
			username ?? user.username,
			Math.floor(Date.now() / 1000),
			id
		);
		if (password_hash || role !== user.role) {
			if (id === fresh.id && sessionId)
				db.prepare('DELETE FROM sessions WHERE user_id=? AND id!=?').run(id, sessionId);
			else db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
		}
		return getAccount(db, id);
	})();
}
export function removeAccount(db, actor, id) {
	return db.transaction(() => {
		const current = authorize(db, actor, id);
		if (current.role !== 'admin' || current.id === id)
			throw failure(
				'Only administrators can remove other users; accounts cannot delete themselves',
				403
			);
		const user = getAccount(db, id);
		if (!user) throw failure('User not found', 404);
		protectAdmin(db, user, null);
		protectReviewers(db, id, true);
		db.prepare(
			"UPDATE telegram_registrations SET step='rejected',username=NULL,password_hash=NULL,updated_at=? WHERE user_id=?"
		).run(Math.floor(Date.now() / 1000), id);
		db.prepare('DELETE FROM users WHERE id=?').run(id);
		return { ok: true };
	})();
}
