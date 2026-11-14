import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { handleTelegramPrivateMenu, privateBotCommands } from '../src/lib/server/telegram-private-menu.js';
import { configurePrivateBotMenu, answerBotCallback } from '../src/lib/server/telegram.js';

function fixture(t) {
	const db = new Database(':memory:');
	initializeSchema(db, readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
	t.after(() => db.close());
	const sent = [], answers = [], configurations = [];
	const options = {
		now: 10000,
		send: async (id, text, replyTo, markup) => sent.push({ id, text, replyTo, markup }),
		answer: async (id) => answers.push(id),
		configure: async (id, commands) => configurations.push({ id, commands })
	};
	const message = (text = '/menu', id = 101) => ({ message_id: 10, from: { id, is_bot: false }, chat: { id, type: 'private' }, text });
	const invoke = (text, extra = {}) => handleTelegramPrivateMenu(db, { message: message(text) }, { ...options, ...extra });
	const callback = (data = 'pacs:menu', id = 101) => ({ callback_query: {
		id: 'synthetic-callback', data, from: { id, is_bot: false },
		message: { ...message(), from: { id: 999, is_bot: true } }
	} });
	const registration = (step, updated = 10000) => db.prepare(`INSERT INTO telegram_registrations(telegram_user_id,step,updated_at)
		VALUES('101',?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET step=excluded.step,updated_at=excluded.updated_at`).run(step, updated);
	const approve = (role = 'resident') => {
		registration('approved');
		db.prepare("INSERT INTO users(id,full_name,role,telegram_user_id) VALUES(1,'Synthetic Reviewer',?,'101')").run(role);
		db.exec("UPDATE telegram_registrations SET user_id=1 WHERE telegram_user_id='101'");
	};
	return { db, sent, answers, configurations, options, message, invoke, callback, registration, approve };
}

test('start welcomes without starting registration, installs commands and provides private navigation buttons', async (t) => {
	const c = fixture(t);
	assert.equal(await c.invoke('/start invitation'), true);
	assert.match(c.sent[0].text, /Personal Taleghani PACS.*\n/);
	assert.match(c.sent[0].text, /Not registered/);
	assert.equal(c.db.prepare('SELECT count(*) AS n FROM telegram_registrations').get().n, 0);
	assert.deepEqual(c.configurations, [{ id: 101, commands: privateBotCommands }]);
	const buttons = c.sent[0].markup.inline_keyboard.flat();
	assert.deepEqual(buttons.map(({ text }) => text), ['My account', 'My statistics', 'Registration', 'Help', 'Website', 'Main menu']);
	assert.ok(buttons.every(({ callback_data }) => callback_data.startsWith('pacs:')));
	await c.invoke('/menu@synthetic_bot');
	assert.equal(c.configurations.length, 1);
});

test('menu, help, status and unknown commands never change or consume an active registration draft', async (t) => {
	const c = fixture(t);
	for (const step of ['name', 'role', 'username', 'password']) {
		c.registration(step);
		const before = c.db.prepare('SELECT * FROM telegram_registrations').all();
		for (const text of ['/start', '/help', '/status', '/registration', '/unknown']) {
			await c.invoke(text);
			assert.deepEqual(c.db.prepare('SELECT * FROM telegram_registrations').all(), before);
		}
		await c.invoke('/status');
		assert.match(c.sent.at(-1).text, /Registration in progress/);
		assert.match(c.sent.at(-1).text, /does not reset your progress/);
	}
	await c.invoke('/help');
	assert.match(c.sent.at(-1).text, /not end-to-end encrypted/);
	assert.match(c.sent.at(-1).text, /never your Telegram password/);
	assert.equal(await c.invoke('/register'), false);
	assert.equal(await c.invoke('/cancel'), false);
	assert.equal(await c.invoke('Synthetic name'), false);
});

test('status reports pending, rejected, expired and disconnected accounts without changing them', async (t) => {
	const c = fixture(t);
	for (const [step, updated, expected] of [
		['pending', 10000, /Awaiting administrator approval/],
		['rejected', 10000, /Registration rejected or expired/],
		['name', 8199, /Registration expired/],
		['approved', 10000, /Account link unavailable/]
	]) {
		c.registration(step, updated);
		await c.invoke('/status');
		assert.match(c.sent.at(-1).text, expected);
		assert.equal(c.db.prepare('SELECT step FROM telegram_registrations').get().step, step);
	}
});

test('approved current roles including admin are recognized; stale links do not grant access', async (t) => {
	const c = fixture(t);
	c.approve();
	for (const role of ['resident', 'attending', 'typist', 'admin']) {
		c.db.prepare('UPDATE users SET role=? WHERE id=1').run(role);
		await c.invoke('/status');
		assert.match(c.sent.at(-1).text, /Account approved/);
		assert.ok(c.sent.at(-1).text.includes(role));
		for (const command of ['/register', '/cancel']) {
			assert.equal(await c.invoke(command), true);
			assert.match(c.sent.at(-1).text, /Account approved/);
			assert.equal(c.db.prepare('SELECT step FROM telegram_registrations').get().step, 'approved');
		}
	}
	c.db.exec("UPDATE users SET telegram_user_id='202'");
	await c.invoke('/status');
	assert.match(c.sent.at(-1).text, /Account link unavailable/);
	assert.doesNotMatch(c.sent.at(-1).text, /Synthetic Reviewer/);
});

test('website buttons use only a validated saved link and otherwise give configuration guidance', async (t) => {
	const c = fixture(t);
	for (const url of ['', 'javascript:alert(1)', 'https://user:secret@example.invalid']) {
		c.db.prepare("INSERT OR REPLACE INTO application_settings(key,value) VALUES('telegram_website_url',?)").run(url);
		await c.invoke('/website');
		assert.match(c.sent.at(-1).text, /has not been configured/);
		assert.ok(c.sent.at(-1).markup.inline_keyboard.flat().every((button) => !button.url));
		assert.doesNotMatch(c.sent.at(-1).text, /secret/);
	}
	c.db.exec("UPDATE application_settings SET value='https://example.invalid/pacs/' WHERE key='telegram_website_url'");
	await c.invoke('/website');
	assert.deepEqual(c.sent.at(-1).markup.inline_keyboard.flat().find(({ url }) => url), { text: 'Open website', url: 'https://example.invalid/pacs/' });
});

test('private callbacks acknowledge presses, resolve the pressing user and preserve registration state', async (t) => {
	const c = fixture(t);
	c.approve();
	for (const action of ['menu', 'help', 'status', 'registration', 'website']) {
		assert.equal(await handleTelegramPrivateMenu(c.db, c.callback(`pacs:${action}`), c.options), true);
		assert.equal(c.sent.at(-1).id, '101');
	}
	assert.equal(c.answers.length, 5);
	assert.match(c.sent.find(({ text }) => text.startsWith('Account approved')).text, /Synthetic Reviewer/);
	assert.equal(c.db.prepare('SELECT step FROM telegram_registrations').get().step, 'approved');
	await handleTelegramPrivateMenu(c.db, c.callback(), { ...c.options, answer: async () => { throw new Error('Expired query'); } });
	assert.equal(c.sent.length, 6);
});

test('statistics buttons use existing permission-checked statistics and offer date shortcuts', async (t) => {
	const c = fixture(t);
	await handleTelegramPrivateMenu(c.db, c.callback('pacs:stats'), c.options);
	assert.match(c.sent.at(-1).text, /require an approved Telegram registration/);
	c.approve();
	for (const action of ['pacs:stats', 'pacs:stats:today', 'pacs:stats:week', 'pacs:stats:month']) {
		await handleTelegramPrivateMenu(c.db, c.callback(action), c.options);
		assert.match(c.sent.at(-1).text, /Study statistics\nScope: Your assigned studies/);
		assert.deepEqual(c.sent.at(-1).markup.inline_keyboard[0].map(({ text }) => text), ['Today', '7 days', '30 days']);
	}
	c.db.exec("UPDATE users SET telegram_user_id='202'");
	await handleTelegramPrivateMenu(c.db, c.callback('pacs:stats:today'), c.options);
	assert.match(c.sent.at(-1).text, /require an approved Telegram registration/);
});

test('edited, spoofed, group, bot and malformed menu updates never access the database or send responses', async () => {
	const valid = { message_id: 10, from: { id: 101, is_bot: false }, chat: { id: 101, type: 'private' }, text: '/start' };
	const noDb = { prepare() { throw new Error('Database accessed'); } };
	const options = { send() { throw new Error('Sent message'); }, answer() { throw new Error('Answered callback'); } };
	for (const update of [
		{}, { edited_message: valid }, { message: { ...valid, edit_date: 1 } },
		{ message: { ...valid, chat: { id: -100, type: 'supergroup' } } },
		{ message: { ...valid, from: { id: 102, is_bot: false } } },
		{ message: { ...valid, from: { id: 101, is_bot: true } } },
		{ message: { ...valid, chat: { id: '101', type: 'private' } } },
		{ message: { ...valid, sender_chat: {} } },
		{ callback_query: { id: 'q', data: 'pacs:menu', from: valid.from } },
		{ callback_query: { id: 'q', data: 'pacs:unknown', from: valid.from, message: valid } },
		{ callback_query: { id: 'q', data: 'pacs:menu', from: { id: 202, is_bot: false }, message: valid } },
		{ callback_query: { id: 'q', data: 'pacs:menu', from: valid.from, message: { ...valid, chat: { id: -100, type: 'supergroup' } } } }
	]) assert.equal(await handleTelegramPrivateMenu(noDb, update, options), false);
});

test('inline navigation still works when Telegram command-menu configuration fails', async (t) => {
	const c = fixture(t);
	assert.equal(await c.invoke('/start', { configure: async () => { throw new Error('Unavailable'); } }), true);
	assert.equal(c.sent.length, 1);
	assert.ok(c.sent[0].markup.inline_keyboard.length);
});

test('Telegram menu API calls are private-chat scoped and callback acknowledgements contain no account data', async (t) => {
	const previous = process.env.TELEGRAM_BOT_TOKEN;
	process.env.TELEGRAM_BOT_TOKEN = 'synthetic-token';
	t.after(() => {
		if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
		else process.env.TELEGRAM_BOT_TOKEN = previous;
	});
	const requests = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		requests.push({ endpoint: url.split('/').at(-1), body: JSON.parse(options.body) });
		return { json: async () => ({ ok: true, result: true }) };
	});
	await configurePrivateBotMenu(101, privateBotCommands);
	await answerBotCallback('synthetic-query');
	assert.deepEqual(requests, [
		{ endpoint: 'setMyCommands', body: { commands: privateBotCommands, scope: { type: 'chat', chat_id: 101 } } },
		{ endpoint: 'setChatMenuButton', body: { chat_id: 101, menu_button: { type: 'commands' } } },
		{ endpoint: 'answerCallbackQuery', body: { callback_query_id: 'synthetic-query' } }
	]);
	for (const id of [-100, 'all_private_chats', 0]) await assert.rejects(configurePrivateBotMenu(id, privateBotCommands), /Private chat ID/);
	assert.equal(requests.length, 3);
});
