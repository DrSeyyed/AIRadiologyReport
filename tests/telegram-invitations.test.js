import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { queueGroupInvitations, processGroupInvitation } from '../src/lib/server/telegram-invitations.js';
import { getStudyGroupInviteLink } from '../src/lib/server/telegram.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const link = 'https://t.me/+synthetic-invite';
function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	initializeSchema(db, schema);
	db.exec("INSERT INTO users(id,full_name,role,telegram_user_id) VALUES(1,'Admin','admin',NULL),(2,'Resident','resident','200'),(3,'Attending','attending','300'),(4,'Typist','typist','400'),(5,'Linked admin','admin','500'),(6,'Unlinked resident','resident',NULL);");
	t.after(() => db.close());
	const queue = (ids, getLink = async () => link) => queueGroupInvitations(db, ids, getLink);
	const job = (id = 2) => db.prepare('SELECT * FROM telegram_group_invitations WHERE user_id = ?').get(id);
	return { db, queue, job };
}
function mockTelegram(t, responder) {
	const previous = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
	process.env.TELEGRAM_BOT_TOKEN = 'synthetic-test-token';
	process.env.TELEGRAM_CHAT_ID = '-100900';
	t.after(() => {
		for (const [name, value] of [['TELEGRAM_BOT_TOKEN', previous.token], ['TELEGRAM_CHAT_ID', previous.chat]]) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	const requests = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		const endpoint = new URL(url).pathname.split('/').at(-1);
		const payload = JSON.parse(options.body);
		requests.push({ endpoint, payload });
		return { status: 200, json: async () => responder(endpoint, payload) };
	});
	return requests;
}

test('group lookup reuses the configured study group public link without creating an invite', async (t) => {
	const calls = mockTelegram(t, () => ({ ok: true, result: { type: 'supergroup', username: 'synthetic_studies' } }));
	assert.equal(await getStudyGroupInviteLink(), 'https://t.me/synthetic_studies');
	assert.deepEqual(calls, [{ endpoint: 'getChat', payload: { chat_id: '-100900' } }]);
});

test('private group lookup reuses its existing invitation link', async (t) => {
	const calls = mockTelegram(t, () => ({ ok: true, result: { type: 'supergroup', invite_link: link } }));
	assert.equal(await getStudyGroupInviteLink(), link);
	assert.equal(calls.length, 1);
});

test('private group lookup creates an invitation only when no existing link is available', async (t) => {
	const calls = mockTelegram(t, (endpoint) => ({ ok: true, result: endpoint === 'getChat' ? { type: 'group' } : { invite_link: link } }));
	assert.equal(await getStudyGroupInviteLink(), link);
	assert.deepEqual(calls[1], { endpoint: 'createChatInviteLink', payload: { chat_id: '-100900', name: 'Website invitations' } });
});

test('unavailable group permissions, private chats and invalid links are not accepted', async (t) => {
	let response = { ok: false, error_code: 403, description: 'Forbidden' };
	mockTelegram(t, () => response);
	await assert.rejects(getStudyGroupInviteLink(), (error) => error.telegram_error_code === 403);
	response = { ok: true, result: { type: 'private' } };
	await assert.rejects(getStudyGroupInviteLink(), /group or channel/);
	response = { ok: true, result: { type: 'supergroup', invite_link: 'https://example.invalid/invite' } };
	await assert.rejects(getStudyGroupInviteLink(), /Invalid Telegram invite link/);
});

test('only selected linked users are queued once, including linked admins but excluding unlinked admins', async (t) => {
	const { db, queue, job } = fixture(t);
	let lookups = 0;
	const result = await queue([1, 2, 2, 3, 4, 5, 6, 99], async () => { lookups++; return link; });
	assert.equal(result.queued, 4);
	assert.equal(result.already_queued, 0);
	assert.deepEqual(result.skipped.map((user) => user.id), [1, 6, 99]);
	assert.equal(lookups, 1);
	assert.equal(job(5).telegram_user_id, '500');
	assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_group_invitations').get().n, 4);
	const again = await queue([2, 3], async () => assert.fail('Do not look up another link for pending jobs'));
	assert.equal(again.queued, 0);
	assert.equal(again.already_queued, 2);
});

test('invalid selections and all-unlinked selections do not look up or send a group link', async (t) => {
	const { queue } = fixture(t);
	const forbidden = async () => assert.fail('No Telegram call expected');
	for (const ids of [null, [], '2', [0], [-1], ['2'], [2.5], [Number.MAX_SAFE_INTEGER + 1]])
		await assert.rejects(queue(ids, forbidden), (error) => error.status === 400);
	const result = await queue([1, 6, 99], forbidden);
	assert.equal(result.queued, 0);
	assert.equal(result.skipped.length, 3);
});

test('failed group lookup leaves no queued jobs and concurrent requests do not duplicate recipients', async (t) => {
	const { queue, db } = fixture(t);
	await assert.rejects(queue([2], async () => { throw new Error('Unavailable'); }), /Unavailable/);
	assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_group_invitations').get().n, 0);
	let release;
	const first = queue([2], () => new Promise((resolve) => { release = resolve; }));
	await queue([2]);
	release(link);
	assert.equal((await first).already_queued, 1);
	assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_group_invitations').get().n, 1);
});

test('delivery sends a private join button, marks sent and permits an explicit resend', async (t) => {
	const { db, queue, job } = fixture(t);
	await queue([2]);
	const calls = [];
	await processGroupInvitation(db, async (...args) => calls.push(args), 100);
	assert.equal(calls[0][0], '200');
	assert.equal(calls[0][1], `Study group: ${link}`);
	assert.deepEqual(calls[0][3], { inline_keyboard: [[{ text: 'Join study group', url: link }]] });
	assert.equal(job().status, 'sent');
	assert.ok(job().sent_at);
	assert.equal(await processGroupInvitation(db, async () => assert.fail('No duplicate delivery'), 101), false);
	assert.equal((await queue([2])).queued, 1);
	assert.equal(job().status, 'pending');
	assert.equal(job().sent_at, null);
});

test('deleted or relinked accounts are not sent invitations for stale identities', async (t) => {
	const { db, queue, job } = fixture(t);
	await queue([2, 3]);
	db.prepare('DELETE FROM users WHERE id = 3').run();
	assert.equal(job(3), undefined);
	db.prepare("UPDATE users SET telegram_user_id = '999' WHERE id = 2").run();
	await processGroupInvitation(db, async () => assert.fail('Do not send stale invitation'), 100);
	assert.equal(job().status, 'failed');
});

test('transient failures retry later while Telegram blocks are shown as failed', async (t) => {
	const { db, queue, job } = fixture(t);
	await queue([2]);
	await processGroupInvitation(db, async () => { throw new Error('Network unavailable'); }, 100);
	assert.equal(job().status, 'pending');
	assert.equal(job().retry_at, 130);
	assert.equal(await processGroupInvitation(db, async () => assert.fail('Too early'), 129), false);
	await processGroupInvitation(db, async () => {}, 130);
	assert.equal(job().status, 'sent');
	await queue([2]);
	await processGroupInvitation(db, async () => { throw Object.assign(new Error('Blocked'), { telegram_error_code: 403 }); }, 200);
	assert.equal(job().status, 'failed');
	assert.equal(job().attempts, 1);
	assert.equal(await processGroupInvitation(db, async () => assert.fail('Blocked user not retried'), 999), false);
});

test('repeated transient failures stop after five attempts', async (t) => {
	const { db, queue, job } = fixture(t);
	await queue([2]);
	let now = 100;
	for (let attempt = 1; attempt <= 5; attempt++) {
		await processGroupInvitation(db, async () => { throw new Error('Unavailable'); }, now);
		assert.equal(job().attempts, attempt);
		now = job().retry_at;
	}
	assert.equal(job().status, 'failed');
});

test('Telegram retry_after pauses the whole pending queue', async (t) => {
	const { db, queue, job } = fixture(t);
	await queue([2, 3]);
	await processGroupInvitation(db, async () => { throw Object.assign(new Error('Rate limited'), { telegram_error_code: 429, retry_after: 120 }); }, 100);
	assert.equal(job().retry_at, 220);
	assert.equal(job(3).retry_at, 220);
	assert.equal(await processGroupInvitation(db, async () => assert.fail('Rate limit pause'), 219), false);
	await processGroupInvitation(db, async () => {}, 220);
	assert.equal(job().status, 'sent');
});

test('delivery leases prevent overlapping sends and expired leases recover after a restart', async (t) => {
	const { db, queue, job } = fixture(t);
	await queue([2]);
	let finish;
	const first = processGroupInvitation(db, () => new Promise((resolve) => { finish = resolve; }), 100);
	assert.equal(await processGroupInvitation(db, async () => assert.fail('Already leased'), 101), false);
	finish();
	await first;
	await queue([2]);
	db.prepare('UPDATE telegram_group_invitations SET lease_until = 200 WHERE user_id = 2').run();
	assert.equal(await processGroupInvitation(db, async () => assert.fail('Lease not expired'), 199), false);
	await processGroupInvitation(db, async () => {}, 200);
	assert.equal(job().status, 'sent');
});

test('schema upgrades create and retain queued invitations and user references idempotently', async (t) => {
	const { db, queue, job } = fixture(t);
	db.exec('DROP TABLE telegram_group_invitations');
	initializeSchema(db, schema);
	await queue([2]);
	db.exec('ALTER TABLE users ADD COLUMN email TEXT');
	initializeSchema(db, schema);
	initializeSchema(db, schema);
	assert.equal(job().status, 'pending');
	assert.equal(job().telegram_user_id, '200');
	assert.deepEqual(db.pragma('foreign_key_check'), []);
	assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 6);
});

test('missing study-group configuration fails without a Telegram request', async (t) => {
	const calls = mockTelegram(t, () => assert.fail('No Telegram request expected'));
	delete process.env.TELEGRAM_CHAT_ID;
	await assert.rejects(getStudyGroupInviteLink(), /Missing TELEGRAM_CHAT_ID/);
	assert.equal(calls.length, 0);
});

test('users removed while resolving the group link are rechecked before enqueueing', async (t) => {
	const { db, queue, job } = fixture(t);
	let release;
	const pending = queue([2, 3], () => new Promise((resolve) => { release = resolve; }));
	db.prepare('DELETE FROM users WHERE id = 3').run();
	release(link);
	const result = await pending;
	assert.equal(result.queued, 1);
	assert.deepEqual(result.skipped.map((user) => user.id), [3]);
	assert.equal(job(3), undefined);
});

test('large selections queue every eligible recipient without SQLite bind-limit truncation', async (t) => {
	const { db, queue } = fixture(t);
	const insert = db.prepare('INSERT INTO users(id,full_name,role,telegram_user_id) VALUES(?, ?, ?, ?)');
	const ids = Array.from({ length: 1500 }, (_, index) => index + 1000);
	db.transaction(() => {
		for (const id of ids) insert.run(id, `Synthetic ${id}`, 'typist', String(id + 100000));
	})();
	assert.equal((await queue(ids)).queued, 1500);
	assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_group_invitations').get().n, 1500);
});
