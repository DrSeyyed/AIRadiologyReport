import bcrypt from 'bcryptjs';
import { timingSafeEqual } from 'node:crypto';
import { sendBotMessage, deleteMessage } from './telegram.js';

function failure(message, status = 400) {
	return Object.assign(new Error(message), { status });
}
const publicColumns =
	'id, telegram_user_id, telegram_username, full_name, role, username, step, user_id, created_at, updated_at';
export function listTelegramRegistrations(db) {
	return db
		.prepare(
			`SELECT ${publicColumns} FROM telegram_registrations WHERE step IN ('pending','approved','rejected') ORDER BY (step = 'pending') DESC, updated_at DESC, id DESC LIMIT 200`
		)
		.all();
}
export function getApprovedTelegramUser(db, telegramId) {
	return db
		.prepare(
			`SELECT u.id, u.full_name, u.role FROM users u JOIN telegram_registrations r ON r.user_id = u.id AND r.telegram_user_id = u.telegram_user_id WHERE u.telegram_user_id = ? AND r.step = 'approved' AND u.role IN ('resident','attending','typist')`
		)
		.get(String(telegramId));
}
export function validateTelegramWebhook(headers, secret = process.env.TELEGRAM_WEBHOOK_SECRET) {
	if (!secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret))
		throw failure(
			'Configure TELEGRAM_WEBHOOK_SECRET and register it with Telegram setWebhook.',
			503
		);
	const supplied = headers.get('x-telegram-bot-api-secret-token') || '';
	const expected = Buffer.from(secret),
		actual = Buffer.from(supplied);
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
		throw failure('Unauthorized webhook', 401);
}
function usernameTaken(db, username, ownId) {
	return (
		db
			.prepare('SELECT user_id FROM auth_credentials WHERE username = ? COLLATE NOCASE')
			.get(username) ||
		db
			.prepare(
				"SELECT id FROM telegram_registrations WHERE username = ? COLLATE NOCASE AND id != ? AND step IN ('password','pending')"
			)
			.get(username, ownId)
	);
}
async function quiet(action) {
	try {
		await action();
	} catch {
		/* Registration state remains valid if Telegram notification fails. */
	}
}
export async function handleTelegramRegistration(
	db,
	message,
	{
		send = sendBotMessage,
		remove = deleteMessage,
		now = Math.floor(Date.now() / 1000),
		hash = (password) => bcrypt.hash(password, 12)
	} = {}
) {
	if (
		message?.chat?.type !== 'private' ||
		message.from?.is_bot ||
		!Number.isSafeInteger(message.from?.id) ||
		message.from.id <= 0 ||
		String(message.chat.id) !== String(message.from.id) ||
		!Number.isSafeInteger(message.message_id)
	)
		return false;
	const id = String(message.from.id),
		text = typeof message.text === 'string' ? message.text : '',
		command = text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
	const roleKeyboard = {
		keyboard: [[{ text: 'Resident' }, { text: 'Attending' }, { text: 'Typist' }]],
		resize_keyboard: true,
		one_time_keyboard: true
	};
	const reply = (body, markup = { remove_keyboard: true }) =>
		quiet(() => send(id, body, undefined, markup));
	const erase = () => quiet(() => remove(message.message_id, id));
	const approved = getApprovedTelegramUser(db, id);
	if (approved) {
		await reply(
			'Your account is approved. Sign in to the website using your chosen username and password.' +
				(approved.role === 'typist'
					? ' You can manage studies and recordings on the website; resident/attending signatures remain restricted.'
					: ' Reply to a study message in the study group with voice/audio to attach a recording.')
		);
		return true;
	}
	db.prepare(
		"UPDATE telegram_registrations SET step='rejected', username=NULL, password_hash=NULL WHERE step IN ('name','role','username','password') AND updated_at < ?"
	).run(now - 1800);
	let registration = db
		.prepare('SELECT * FROM telegram_registrations WHERE telegram_user_id=?')
		.get(id);
	if (registration && message.message_id <= registration.last_message_id) return true;
	if (command === '/cancel') {
		db.prepare(
			"DELETE FROM telegram_registrations WHERE telegram_user_id=? AND step != 'approved'"
		).run(id);
		await reply('Registration cancelled. Send /register to start again.');
		return true;
	}
	if (command === '/start' || command === '/register') {
		if (registration?.step === 'pending') {
			await reply(
				'Your registration is awaiting administrator approval. Your website login is not active yet.'
			);
			return true;
		}
		db.prepare(
			`INSERT INTO telegram_registrations(telegram_user_id,telegram_username,last_message_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET telegram_username=excluded.telegram_username, full_name='',role=NULL,username=NULL,password_hash=NULL,user_id=NULL,step='name',last_message_id=excluded.last_message_id,updated_at=excluded.updated_at`
		).run(id, message.from.username || null, message.message_id, now);
		await reply(
			'Registration is private. Send your full name. Next you will choose resident/attending/typist, a website username, and a unique website password. Do not reuse another account’s password. Telegram bots are not end-to-end encrypted. Send /cancel to cancel.'
		);
		return true;
	}
	if (!registration || registration.step === 'rejected') {
		await reply('Send /register to create a resident, attending or typist website account.');
		return true;
	}
	if (registration.step === 'pending') {
		await erase();
		await reply('Awaiting administrator approval. Your website login is not active yet.');
		return true;
	}
	if (registration.step === 'approved') {
		await reply('Contact an administrator about your existing account.');
		return true;
	}
	const update = (values) =>
		db
			.prepare(
				`UPDATE telegram_registrations SET ${Object.keys(values)
					.map((key) => `${key} = @${key}`)
					.join(
						','
					)}, last_message_id=@message,updated_at=@now WHERE id=@id AND step=@previous AND last_message_id=@last`
			)
			.run({
				...values,
				id: registration.id,
				previous: registration.step,
				last: registration.last_message_id,
				message: message.message_id,
				now
			});
	if (registration.step === 'name') {
		const name = text.trim();
		if (!name || name.length > 100) {
			await reply('Send a full name between 1 and 100 characters.');
			return true;
		}
		update({ full_name: name, step: 'role' });
		await reply(
			'Choose your role using the buttons below. An administrator will verify your role.',
			roleKeyboard
		);
		return true;
	}
	if (registration.step === 'role') {
		const role = text.trim().toLowerCase();
		if (!['resident', 'attending', 'typist'].includes(role)) {
			await reply(
				'Choose Resident, Attending or Typist using the buttons below. An administrator will verify your role.',
				roleKeyboard
			);
			return true;
		}
		update({ role, step: 'username' });
		await reply(
			'Choose a website username: 3–32 lowercase letters, numbers, dots, underscores or hyphens; start with a letter.'
		);
		return true;
	}
	if (registration.step === 'username') {
		const username = text.trim();
		if (!/^[a-z][a-z0-9_.-]{2,31}$/.test(username)) {
			await reply(
				'Use 3–32 lowercase letters, numbers, dots, underscores or hyphens, starting with a letter.'
			);
			return true;
		}
		if (usernameTaken(db, username, registration.id)) {
			await reply('That website username is unavailable. Choose another.');
			return true;
		}
		try {
			update({ username, step: 'password' });
		} catch {
			await reply('That website username is unavailable. Choose another.');
			return true;
		}
		await reply(
			'Send a unique website password of at least 8 characters and at most 72 UTF-8 bytes. The bot will try to delete this message immediately. Only a password hash is stored; it will not be shown to administrators.'
		);
		return true;
	}
	if (registration.step === 'password') {
		await erase();
		if (text.length < 8 || Buffer.byteLength(text, 'utf8') > 72) {
			await reply(
				'Use at least 8 characters and at most 72 UTF-8 bytes. Send a different unique password.'
			);
			return true;
		}
		const password_hash = await hash(text);
		const result = update({ password_hash, step: 'pending' });
		if (result.changes)
			await reply(
				'Registration submitted for administrator approval. Your website username and password will work only after approval.'
			);
		return true;
	}
	return true;
}
export function reviewTelegramRegistration(db, id, { action, role }) {
	if (!Number.isSafeInteger(id) || id <= 0 || !['approve', 'reject'].includes(action))
		throw failure('Invalid registration review');
	return db.transaction(() => {
		const request = db.prepare('SELECT * FROM telegram_registrations WHERE id=?').get(id);
		if (!request) throw failure('Registration not found', 404);
		if (request.step !== 'pending')
			throw failure('Only pending registrations can be reviewed.', 409);
		let user;
		if (action === 'approve') {
			role = role || request.role;
			if (
				!['resident', 'attending', 'typist'].includes(role) ||
				!request.password_hash ||
				!request.username ||
				!request.full_name
			)
				throw failure('Registration is incomplete or role is invalid');
			if (
				usernameTaken(db, request.username, id) ||
				db.prepare('SELECT id FROM users WHERE telegram_user_id=?').get(request.telegram_user_id)
			)
				throw failure('Username or Telegram account is already registered.', 409);
			const created = db
				.prepare('INSERT INTO users(full_name,role,telegram_user_id) VALUES(?,?,?)')
				.run(request.full_name, role, request.telegram_user_id);
			const userId = Number(created.lastInsertRowid);
			db.prepare('INSERT INTO auth_credentials(user_id,username,password_hash) VALUES(?,?,?)').run(
				userId,
				request.username,
				request.password_hash
			);
			db.prepare(
				"UPDATE telegram_registrations SET step='approved',role=?,user_id=?,password_hash=NULL,updated_at=? WHERE id=?"
			).run(role, userId, Math.floor(Date.now() / 1000), id);
			user = { id: userId, full_name: request.full_name, role, username: request.username };
		} else
			db.prepare(
				"UPDATE telegram_registrations SET step='rejected',password_hash=NULL,updated_at=? WHERE id=?"
			).run(Math.floor(Date.now() / 1000), id);
		return {
			ok: true,
			registration: db
				.prepare(`SELECT ${publicColumns} FROM telegram_registrations WHERE id=?`)
				.get(id),
			...(user ? { user } : {})
		};
	})();
}
