import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import {
	handleTelegramRegistration,
	reviewTelegramRegistration,
	listTelegramRegistrations,
	getApprovedTelegramUser,
	validateTelegramWebhook
} from '../src/lib/server/telegram-registration.js';
const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	initializeSchema(db, schema);
	t.after(() => db.close());
	const sent = [],
		removed = [];
	let sequence = 0;
	const options = {
		now: 10000,
		send: async (id, text) => sent.push({ id, text }),
		remove: async (message, id) => removed.push({ message, id }),
		hash: (password) => bcrypt.hash(password, 4)
	};
	const message = (text, id = 200) => ({
		message_id: ++sequence,
		from: { id, username: 'synthetic' },
		chat: { id, type: 'private' },
		text
	});
	const send = (text, id = 200, overrides = {}) =>
		handleTelegramRegistration(db, message(text, id), { ...options, ...overrides });
	const state = (id = 200) =>
		db.prepare('SELECT * FROM telegram_registrations WHERE telegram_user_id=?').get(String(id));
	const draft = async (id = 200, username = 'new_resident', role = 'resident') => {
		for (const text of ['/register', 'Synthetic Reviewer', role, username]) await send(text, id);
	};
	const register = async (id = 200, username = 'new_resident', role = 'resident') => {
		await draft(id, username, role);
		await send('Synthetic-password-42', id);
		return state(id);
	};
	return { db, sent, removed, options, message, send, state, draft, register };
}
test('private registration stores only a hash and creates no login before administrator approval', async (t) => {
	const { db, register, state, sent, removed } = fixture(t);
	const request = await register();
	assert.equal(request.step, 'pending');
	assert.notEqual(request.password_hash, 'Synthetic-password-42');
	assert.ok(await bcrypt.compare('Synthetic-password-42', request.password_hash));
	assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
	assert.equal(db.prepare('SELECT count(*) AS n FROM auth_credentials').get().n, 0);
	assert.equal(getApprovedTelegramUser(db, 200), undefined);
	assert.equal(removed.length, 1);
	assert.ok(!JSON.stringify(sent).includes('Synthetic-password-42'));
	assert.ok(!JSON.stringify(listTelegramRegistrations(db)).includes(request.password_hash));
	const result = reviewTelegramRegistration(db, request.id, { action: 'approve' });
	assert.equal(result.user.role, 'resident');
	assert.equal(state().password_hash, null);
	assert.equal(getApprovedTelegramUser(db, 200).id, result.user.id);
	const credentials = db.prepare('SELECT * FROM auth_credentials').get();
	assert.ok(await bcrypt.compare('Synthetic-password-42', credentials.password_hash));
	assert.ok(!JSON.stringify(result).includes(credentials.password_hash));
	assert.throws(
		() => reviewTelegramRegistration(db, request.id, { action: 'approve' }),
		/Only pending/
	);
});
test('administrator verifies requested role and rejection clears the temporary hash', async (t) => {
	const { register, db, state } = fixture(t);
	const first = await register();
	const approved = reviewTelegramRegistration(db, first.id, {
		action: 'approve',
		role: 'attending'
	});
	assert.equal(approved.user.role, 'attending');
	const second = await register(201, 'second_resident');
	reviewTelegramRegistration(db, second.id, { action: 'reject' });
	assert.equal(state(201).step, 'rejected');
	assert.equal(state(201).password_hash, null);
	assert.equal(getApprovedTelegramUser(db, 201), undefined);
	assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
});
test('registration ignores groups, spoofed private chat IDs and bot accounts', async (t) => {
	const { db, options, message } = fixture(t);
	for (const change of [
		{ chat: { id: -1, type: 'group' } },
		{ chat: { id: 201, type: 'private' } },
		{ from: { id: 200, is_bot: true } },
		{ from: { id: 0 } },
		{ from: { id: '200' } }
	])
		assert.equal(
			await handleTelegramRegistration(db, { ...message('/register'), ...change }, options),
			false
		);
	assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_registrations').get().n, 0);
});
test('invalid roles, usernames and passwords do not advance; password messages are deleted best-effort', async (t) => {
	const { send, state, removed } = fixture(t);
	await send('/register');
	await send('Reviewer');
	await send('admin');
	assert.equal(state().step, 'role');
	await send('resident');
	await send('UPPERCASE');
	assert.equal(state().step, 'username');
	await send('valid_user');
	assert.equal(state().step, 'password');
	await send('short');
	await send('é'.repeat(40));
	assert.equal(state().step, 'password');
	assert.equal(state().password_hash, null);
	assert.equal(removed.length, 2);
	await send('Synthetic-password-42', 200, {
		remove: async () => {
			throw Error('Unavailable');
		}
	});
	assert.equal(state().step, 'pending');
});
test('existing and pending website usernames are reserved case-insensitively', async (t) => {
	const { db, draft, send, state, register } = fixture(t);
	db.exec(
		"INSERT INTO users(id,full_name,role) VALUES(1,'Existing','admin');INSERT INTO auth_credentials VALUES(1,'Taken_Name','hash');"
	);
	await draft(200, 'taken_name');
	assert.equal(state().step, 'username');
	await send('reserved_name');
	assert.equal(state().step, 'password');
	await draft(201, 'reserved_name');
	assert.equal(state(201).step, 'username');
	await send('/cancel', 200);
	await send('reserved_name', 201);
	assert.equal(state(201).step, 'password');
	await send('Synthetic-password-42', 201);
	const pending = state(201);
	db.exec(
		"INSERT INTO users(id,full_name,role) VALUES(2,'Collision','typist');INSERT INTO auth_credentials VALUES(2,'reserved_name','hash');"
	);
	assert.throws(
		() => reviewTelegramRegistration(db, pending.id, { action: 'approve' }),
		/already registered/
	);
	assert.equal(state(201).step, 'pending');
	assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 2);
	const request = await register(202, 'third_reviewer');
	assert.throws(
		() => reviewTelegramRegistration(db, request.id, { action: 'approve', role: 'admin' }),
		/role is invalid/
	);
});
test('duplicate and out-of-order messages do not corrupt the conversation or hash passwords twice', async (t) => {
	const { db, message, options, state } = fixture(t);
	const start = message('/register');
	await handleTelegramRegistration(db, start, options);
	await handleTelegramRegistration(db, start, options);
	assert.equal(state().step, 'name');
	const name = message('Reviewer');
	await handleTelegramRegistration(db, name, options);
	await handleTelegramRegistration(db, name, options);
	assert.equal(state().step, 'role');
	for (const text of ['resident', 'reviewer', 'Synthetic-password-42']) {
		const msg = message(text);
		await handleTelegramRegistration(db, msg, options);
		await handleTelegramRegistration(db, msg, {
			...options,
			hash: () => assert.fail('Duplicate hash')
		});
	}
	assert.equal(state().step, 'pending');
	assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_registrations').get().n, 1);
});
test('expired drafts release usernames and cancellation during hashing cannot submit an old password', async (t) => {
	const { draft, send, state, db } = fixture(t);
	await draft();
	await send('New message', 201, { now: 12000 });
	assert.equal(state().step, 'rejected');
	assert.equal(state().username, null);
	await draft();
	let resolve, started;
	const begun = new Promise((r) => (started = r));
	const pending = send('Synthetic-password-42', 200, {
		hash: () => {
			started();
			return new Promise((r) => (resolve = r));
		}
	});
	await begun;
	await send('/cancel');
	await draft(200, 'replacement');
	resolve('discarded-hash');
	await pending;
	assert.equal(state().step, 'password');
	assert.equal(state().password_hash, null);
	assert.equal(db.prepare('SELECT count(*) AS n FROM auth_credentials').get().n, 0);
});
test('existing website accounts migrate safely without resetting credentials or sessions', (t) => {
	const db = new Database(':memory:');
	t.after(() => db.close());
	db.pragma('foreign_keys = ON');
	db.exec(
		"CREATE TABLE users(id INTEGER PRIMARY KEY,full_name TEXT NOT NULL,role TEXT NOT NULL,email TEXT);CREATE TABLE auth_credentials(user_id INTEGER UNIQUE REFERENCES users(id),username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL);INSERT INTO users VALUES(1,'Existing Admin','admin',NULL);INSERT INTO auth_credentials VALUES(1,'existing_admin','existing-hash');"
	);
	initializeSchema(db, schema);
	initializeSchema(db, schema);
	assert.equal(
		db.prepare('SELECT telegram_user_id FROM users WHERE id=1').get().telegram_user_id,
		null
	);
	assert.equal(
		db.prepare('SELECT password_hash FROM auth_credentials WHERE user_id=1').get().password_hash,
		'existing-hash'
	);
	assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('webhook authentication requires configured valid secret and timing-safe matching header', () => {
	assert.throws(() => validateTelegramWebhook(new Headers(), ''), /Configure/);
	assert.throws(() => validateTelegramWebhook(new Headers(), 'bad secret'), /Configure/);
	assert.throws(
		() => validateTelegramWebhook(new Headers(), 'synthetic_secret'),
		(error) => error.status === 401
	);
	assert.throws(
		() =>
			validateTelegramWebhook(
				new Headers({ 'X-Telegram-Bot-Api-Secret-Token': 'different_secret' }),
				'synthetic_secret'
			),
		(error) => error.status === 401
	);
	assert.doesNotThrow(() =>
		validateTelegramWebhook(
			new Headers({ 'X-Telegram-Bot-Api-Secret-Token': 'synthetic_secret' }),
			'synthetic_secret'
		)
	);
});
