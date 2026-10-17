import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { processGroupInvitation, processWebsiteLink } from '../src/lib/server/telegram-invitations.js';

async function loadModule(relativePath, key) {
	const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8').replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
		let resolved;
		if (['$lib/server/db', '$lib/server/db.js'].includes(specifier)) {
			resolved = `data:text/javascript,${encodeURIComponent(`export function getDb(){globalThis[${JSON.stringify(key + 'Calls')}]++;return globalThis[${JSON.stringify(key)}]}`)}`;
		} else if (specifier.startsWith('$lib/')) resolved = new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href;
		else resolved = import.meta.resolve(specifier);
		return `from ${JSON.stringify(resolved)}`;
	});
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

async function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	initializeSchema(db, readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
	db.exec("INSERT INTO users(id,full_name,role,telegram_user_id) VALUES(1,'Admin','admin',NULL),(2,'Resident','resident','200'),(3,'Typist','typist','300'),(4,'Linked admin','admin','400');");
	const key = `invitationDb_${randomUUID()}`;
	globalThis[key] = db;
	globalThis[key + 'Calls'] = 0;
	t.after(() => { delete globalThis[key]; delete globalThis[key + 'Calls']; db.close(); });
	const { POST, PATCH } = await loadModule('../src/routes/api/users/telegram-invitations/+server.js', key);
	const { PATCH: review } = await loadModule('../src/routes/api/telegram/registrations/[id]/+server.js', key);
	const { GET } = await loadModule('../src/routes/api/users/+server.js', key);
	const requests = [];
	const previous = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
	process.env.TELEGRAM_BOT_TOKEN = 'synthetic-token';
	process.env.TELEGRAM_CHAT_ID = '-100900';
	t.after(() => {
		for (const [name, value] of [['TELEGRAM_BOT_TOKEN', previous.token], ['TELEGRAM_CHAT_ID', previous.chat]]) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		const endpoint = new URL(url).pathname.split('/').at(-1);
		requests.push({ endpoint, payload: JSON.parse(options.body) });
		return { status: 200, json: async () => ({ ok: true, result: endpoint === 'getChat' ? { type: 'supergroup', invite_link: 'https://t.me/+synthetic-invite' } : { message_id: 123 } }) };
	});
	const admin = { id: 1, role: 'admin' };
	const post = (body, user = admin) => POST({ locals: { user }, request: new Request('http://localhost/api/users/telegram-invitations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
	const users = async (user = admin) => {
		const response = await GET({ locals: { user }, url: new URL('http://localhost/api/users') });
		return { status: response.status, rows: await response.json() };
	};
	return { db, key, POST, PATCH, review, post, users, requests };
}

test('invitation POST enforces administrator authorization before body, database or Telegram access', async (t) => {
	const { key, POST, requests } = await fixture(t);
	for (const [user, status] of [[null, 401], [{ id: 2, role: 'resident' }, 403], [{ id: 3, role: 'typist' }, 403]]) {
		const response = await POST({ locals: { user }, request: { json: () => assert.fail('Do not read unauthorized request body') } });
		assert.equal(response.status, status);
	}
	assert.equal(globalThis[key + 'Calls'], 0);
	assert.equal(requests.length, 0);
});

test('invalid invitation payloads fail before database access or Telegram calls', async (t) => {
	const { key, post, POST, requests } = await fixture(t);
	for (const payload of [null, {}, { user_ids: [] }, { user_ids: ['2'] }, { user_ids: [0] }, { user_ids: [2.5] }])
		assert.equal((await post(payload)).status, 400);
	const malformed = await POST({ locals: { user: { id: 1, role: 'admin' } }, request: { json: async () => { throw new SyntaxError('Invalid JSON'); } } });
	assert.equal(malformed.status, 400);
	assert.equal(globalThis[key + 'Calls'], 0);
	assert.equal(requests.length, 0);
});

test('administrator POST queues selected users and exposes pending/sent states only to admins', async (t) => {
	const { db, post, users, requests } = await fixture(t);
	const response = await post({ user_ids: [1, 2, 2, 4, 99] });
	assert.equal(response.status, 200);
	const result = await response.json();
	assert.equal(result.queued, 2);
	assert.deepEqual(result.skipped.map((item) => item.id), [1, 99]);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].endpoint, 'getChat');
	const rows = (await users()).rows;
	assert.equal(rows.find((user) => user.id === 1).has_telegram, 0);
	assert.equal(rows.find((user) => user.id === 2).telegram_invite_status, 'pending');
	assert.equal(rows.find((user) => user.id === 3).telegram_invite_status, null);
	assert.equal(rows.find((user) => user.id === 4).has_telegram, 1);
	assert.ok(rows.every((user) => !Object.hasOwn(user, 'telegram_user_id')));
	await processGroupInvitation(db);
	const sent = requests.find((request) => request.endpoint === 'sendMessage');
	assert.equal(sent.payload.chat_id, '200');
	assert.equal(sent.payload.reply_markup.inline_keyboard[0][0].url, 'https://t.me/+synthetic-invite');
	assert.equal((await users()).rows.find((user) => user.id === 2).telegram_invite_status, 'sent');
	for (const role of ['resident', 'attending', 'typist']) {
		const regular = await users({ id: 2, role });
		assert.equal(regular.status, 200);
		assert.ok(regular.rows.every((user) => !Object.hasOwn(user, 'has_telegram') && !Object.hasOwn(user, 'telegram_invite_status') && !Object.hasOwn(user, 'telegram_website_status') && !Object.hasOwn(user, 'telegram_user_id')));
	}
	assert.equal((await users(null)).status, 401);
	const duplicate = await (await post({ user_ids: [4] })).json();
	assert.equal(duplicate.queued, 0);
	assert.equal(duplicate.already_queued, 1);
});

test('group permission errors leave no jobs and return a concise configuration error', async (t) => {
	const { db, post } = await fixture(t);
	t.mock.method(globalThis, 'fetch', async () => ({
		status: 403,
		json: async () => ({ ok: false, error_code: 403, description: 'Forbidden' })
	}));
	const response = await post({ user_ids: [2] });
	assert.equal(response.status, 503);
	assert.match((await response.json()).error, /bot invite permissions/);
	assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_group_invitations').get().n, 0);
});

test('website POST delivers the entered link without study group lookup or configuration', async (t) => {
	const { db, post, users, requests } = await fixture(t);
	delete process.env.TELEGRAM_CHAT_ID;
	const response = await post({ kind: 'website', website_url: ' https://reports.example.test/login ', user_ids: [1, 2, 4] });
	assert.equal(response.status, 200);
	assert.equal((await response.json()).queued, 2);
	assert.equal(requests.length, 0);
	assert.equal((await users()).rows.find((user) => user.id === 2).telegram_website_status, 'pending');
	await processWebsiteLink(db);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].endpoint, 'sendMessage');
	assert.equal(requests[0].payload.chat_id, '200');
	assert.deepEqual(requests[0].payload.reply_markup.inline_keyboard, [[{ text: 'Open website', url: 'https://reports.example.test/login' }]]);
	assert.equal((await users()).rows.find((user) => user.id === 2).telegram_website_status, 'sent');
	assert.equal((await users()).rows.find((user) => user.id === 2).telegram_invite_status, null);
});

test('invalid website links and link types fail before database or Telegram access', async (t) => {
	const { post, key, requests } = await fixture(t);
	for (const website_url of ['', '/login', 'javascript:alert(1)', 'https://user:password@example.test'])
		assert.equal((await post({ kind: 'website', website_url, user_ids: [2] })).status, 400);
	assert.equal((await post({ kind: 'unknown', user_ids: [2] })).status, 400);
	assert.equal(globalThis[key + 'Calls'], 0);
	assert.equal(requests.length, 0);
});

test('selecting only an unlinked admin skips delivery without calling Telegram', async (t) => {
	const { post, requests } = await fixture(t);
	const response = await post({ user_ids: [1] });
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { queued: 0, already_queued: 0, skipped: [{ id: 1, reason: 'No Telegram account.' }] });
	assert.equal(requests.length, 0);
});

const settingsRequest = (website_url) => new Request('http://localhost/api/users/telegram-invitations', {
	method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ website_url })
});

test('only admins can change the persistent website link, before any body or database access', async (t) => {
	const { PATCH, key, requests } = await fixture(t);
	for (const user of [null, { role: 'resident' }, { role: 'attending' }, { role: 'typist' }]) {
		const response = await PATCH({ locals: { user }, request: { json: () => assert.fail('Unauthorized body access') } });
		assert.equal(response.status, user ? 403 : 401);
	}
	assert.equal(globalThis[key + 'Calls'], 0);
	assert.equal(requests.length, 0);
});

test('saved website settings persist, are reused without entry, and can be changed or cleared', async (t) => {
	const { db, PATCH, post, requests } = await fixture(t);
	const locals = { user: { id: 1, role: 'admin' } };
	assert.equal((await post({ kind: 'website', user_ids: [2] })).status, 400);
	for (const value of [undefined, null, '/login', 'javascript:alert(1)', 'https://example.test/' + 'x'.repeat(2000)])
		assert.equal((await PATCH({ locals, request: settingsRequest(value) })).status, 400);
	assert.equal((await PATCH({ locals, request: settingsRequest(' https://reports.example.test/login ') })).status, 200);
	initializeSchema(db, readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
	assert.equal(db.prepare("SELECT value FROM application_settings WHERE key='telegram_website_url'").get().value, 'https://reports.example.test/login');
	assert.equal((await post({ kind: 'website', user_ids: [2] })).status, 200);
	assert.equal(db.prepare('SELECT website_url FROM telegram_website_links WHERE user_id=2').get().website_url, 'https://reports.example.test/login');
	await PATCH({ locals, request: settingsRequest('https://new.example.test/') });
	assert.equal((await post({ kind: 'website', user_ids: [3] })).status, 200);
	assert.equal(db.prepare('SELECT website_url FROM telegram_website_links WHERE user_id=3').get().website_url, 'https://new.example.test/');
	assert.equal(db.prepare('SELECT website_url FROM telegram_website_links WHERE user_id=2').get().website_url, 'https://reports.example.test/login');
	await PATCH({ locals, request: settingsRequest('') });
	assert.equal((await post({ kind: 'website', user_ids: [4] })).status, 400);
	assert.equal(requests.length, 0);
});

test('approval route queues both links even if the immediate approval notice fails', async (t) => {
	const { db, PATCH, review } = await fixture(t);
	const locals = { user: { id: 1, role: 'admin' } };
	await PATCH({ locals, request: settingsRequest('https://reports.example.test/login') });
	db.exec("INSERT INTO telegram_registrations(id,telegram_user_id,full_name,role,username,password_hash,step) VALUES(1,'900','Synthetic New User','resident','synthetic_user','synthetic-hash','pending')");
	t.mock.method(globalThis, 'fetch', async () => { throw new Error('Synthetic network failure'); });
	const response = await review({ locals, params: { id: '1' }, request: new Request('http://localhost/api/telegram/registrations/1', { method: 'PATCH', body: JSON.stringify({ action: 'approve' }) }) });
	assert.equal(response.status, 200);
	const result = await response.json();
	assert.match(result.notification_warning, /notification failed/);
	assert.equal(db.prepare('SELECT status FROM telegram_group_invitations WHERE user_id=?').get(result.user.id).status, 'pending');
	assert.equal(db.prepare('SELECT status FROM telegram_website_links WHERE user_id=?').get(result.user.id).status, 'pending');
	assert.equal(db.prepare('SELECT step FROM telegram_registrations WHERE id=1').get().step, 'approved');
});
