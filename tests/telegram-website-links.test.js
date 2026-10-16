import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { validateWebsiteUrl, queueWebsiteLinks, queueGroupInvitations, processWebsiteLink, processGroupInvitation } from '../src/lib/server/telegram-invitations.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const link = 'https://reports.example.test/login';
function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	initializeSchema(db, schema);
	db.exec("INSERT INTO users(id,full_name,role,telegram_user_id) VALUES(1,'Unlinked','admin',NULL),(2,'Resident','resident','200'),(3,'Attending','attending','300');");
	t.after(() => db.close());
	const job = (id = 2) => db.prepare('SELECT * FROM telegram_website_links WHERE user_id = ?').get(id);
	return { db, job };
}

test('website links accept explicit HTTP(S) addresses only, without embedded credentials', () => {
	assert.equal(validateWebsiteUrl('  https://reports.example.test/login  '), link);
	assert.equal(validateWebsiteUrl('http://192.168.1.2:3000'), 'http://192.168.1.2:3000/');
	for (const value of [undefined, null, 42, '', '/login', 'reports.example.test', 'javascript:alert(1)', 'file:///tmp/test', 'ftp://example.test', 'https://user:password@example.test', `https://example.test/${'a'.repeat(2000)}`])
		assert.throws(() => validateWebsiteUrl(value), (error) => error.status === 400);
});

test('selected website recipients are deduplicated and queued independently from group invitations', async (t) => {
	const { db, job } = fixture(t);
	await queueGroupInvitations(db, [2], async () => 'https://t.me/+synthetic');
	const result = await queueWebsiteLinks(db, [1, 2, 2, 3, 99], link);
	assert.equal(result.queued, 2);
	assert.deepEqual(result.skipped.map((item) => item.id), [1, 99]);
	assert.equal(job().website_url, link);
	assert.equal((await queueWebsiteLinks(db, [2], 'https://different.example.test')).already_queued, 1);
	assert.equal(job().website_url, link);
	assert.equal(db.prepare('SELECT status FROM telegram_group_invitations').get().status, 'pending');
	const calls = [];
	await processWebsiteLink(db, async (...args) => calls.push(args), 1000);
	assert.deepEqual(calls, [['200', `Radiology reporting website: ${link}`, undefined, { inline_keyboard: [[{ text: 'Open website', url: link }]] }]]);
	assert.equal(job().status, 'sent');
	assert.equal(job(3).status, 'pending');
	assert.equal(db.prepare('SELECT status FROM telegram_group_invitations').get().status, 'pending');
	assert.equal((await queueWebsiteLinks(db, [2], 'https://new.example.test')).queued, 1);
	assert.equal(job().website_url, 'https://new.example.test/');
});

test('website queue survives idempotent migration and cascades with account deletion', async (t) => {
	const { db, job } = fixture(t);
	await queueWebsiteLinks(db, [2], link);
	initializeSchema(db, schema);
	initializeSchema(db, schema);
	assert.equal(job().status, 'pending');
	assert.equal(job().website_url, link);
	assert.deepEqual(db.pragma('foreign_key_check'), []);
	db.prepare('DELETE FROM users WHERE id = 2').run();
	assert.equal(job(), undefined);
});

test('website delivery rejects removed or relinked recipients and retries transient errors', async (t) => {
	const { db, job } = fixture(t);
	await queueWebsiteLinks(db, [2, 3], link);
	db.prepare("UPDATE users SET telegram_user_id = '201' WHERE id = 2").run();
	await processWebsiteLink(db, async () => assert.fail('Stale recipient must not be sent a link'), 1000);
	assert.equal(job().status, 'failed');
	await processWebsiteLink(db, async () => { throw new Error('Synthetic connection failure'); }, 1000);
	assert.equal(job(3).status, 'pending');
	assert.equal(job(3).attempts, 1);
	assert.equal(await processWebsiteLink(db, async () => assert.fail('Backoff not expired'), 1029), false);
	await processWebsiteLink(db, async () => {}, 1030);
	assert.equal(job(3).status, 'sent');
	assert.equal(job(3).sent_at, new Date(1030000).toISOString());
});

test('blocked bot delivery fails permanently and can be explicitly resent', async (t) => {
	const { db, job } = fixture(t);
	await queueWebsiteLinks(db, [2], link);
	await processWebsiteLink(db, async () => { throw Object.assign(new Error('Blocked'), { telegram_error_code: 403 }); }, 1000);
	assert.equal(job().status, 'failed');
	assert.equal((await queueWebsiteLinks(db, [2], link)).queued, 1);
	assert.equal(job().attempts, 0);
});

test('Telegram rate limiting delays both website and group delivery', async (t) => {
	const { db } = fixture(t);
	await queueWebsiteLinks(db, [2], link);
	await queueGroupInvitations(db, [3], async () => 'https://t.me/+synthetic');
	await processWebsiteLink(db, async () => { throw Object.assign(new Error('Limited'), { telegram_error_code: 429, retry_after: 120 }); }, 1000);
	assert.equal(await processGroupInvitation(db, async () => assert.fail('Shared rate limit'), 1100), false);
	assert.equal(await processWebsiteLink(db, async () => assert.fail('Shared rate limit'), 1100), false);
	await processGroupInvitation(db, async () => {}, 1120);
	await processWebsiteLink(db, async () => {}, 1120);
	assert.equal(db.prepare('SELECT status FROM telegram_website_links').get().status, 'sent');
});
