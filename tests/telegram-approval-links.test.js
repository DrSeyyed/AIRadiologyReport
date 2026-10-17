import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { reviewTelegramRegistration } from '../src/lib/server/telegram-registration.js';
import { setTelegramWebsiteUrl } from '../src/lib/server/telegram-settings.js';
import { processGroupInvitation, processWebsiteLink } from '../src/lib/server/telegram-invitations.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	initializeSchema(db, schema);
	t.after(() => db.close());
	const register = (id, role = 'resident') => db.prepare(`INSERT INTO telegram_registrations
		(id,telegram_user_id,full_name,role,username,password_hash,step) VALUES(?,?,?,?,?,?,'pending')`)
		.run(id, String(900 + id), 'Synthetic User', role, `synthetic_${id}`, 'synthetic-hash');
	const approve = (id) => reviewTelegramRegistration(db, id, { action: 'approve' });
	return { db, register, approve };
}

test('approvals atomically queue independent group/channel and saved website links for every role', async (t) => {
	const { db, register, approve } = fixture(t);
	setTelegramWebsiteUrl(db, 'https://reports.example.test/login');
	for (const [index, role] of ['resident', 'attending', 'typist'].entries()) {
		register(index + 1, role);
		const result = approve(index + 1);
		assert.equal(result.link_warning, null);
		const group = db.prepare('SELECT * FROM telegram_group_invitations WHERE user_id=?').get(result.user.id);
		const website = db.prepare('SELECT * FROM telegram_website_links WHERE user_id=?').get(result.user.id);
		assert.equal(group.status, 'pending');
		assert.equal(group.invite_link, '');
		assert.equal(group.telegram_user_id, String(901 + index));
		assert.equal(website.status, 'pending');
		assert.equal(website.website_url, 'https://reports.example.test/login');
		assert.throws(() => approve(index + 1), /Only pending/);
	}
	initializeSchema(db, schema);
	assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_group_invitations').get().n, 3);
	assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_website_links').get().n, 3);
	const sent = [];
	await processGroupInvitation(db, async (...args) => sent.push(args), 1000, async () => 'https://t.me/+synthetic');
	await processWebsiteLink(db, async (...args) => sent.push(args), 1000);
	assert.deepEqual(sent.map(call => call[3].inline_keyboard[0][0]), [
		{ text: 'Join study group', url: 'https://t.me/+synthetic' },
		{ text: 'Open website', url: 'https://reports.example.test/login' }
	]);
	assert.ok(sent.every(call => call[0] === '901'));
});

test('unconfigured website warns without blocking group invitation; rejection queues neither link', (t) => {
	const { db, register, approve } = fixture(t);
	register(1);
	assert.match(approve(1).link_warning, /configure the saved website link/);
	assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_group_invitations').get().n, 1);
	assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_website_links').get().n, 0);
	register(2);
	reviewTelegramRegistration(db, 2, { action: 'reject' });
	assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_group_invitations').get().n, 1);
	assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
});

test('a queue write failure rolls back approval, credentials and both delivery jobs', (t) => {
	const { db, register, approve } = fixture(t);
	setTelegramWebsiteUrl(db, 'https://reports.example.test');
	register(1);
	db.exec("CREATE TRIGGER fail_website BEFORE INSERT ON telegram_website_links BEGIN SELECT RAISE(ABORT, 'Synthetic queue failure'); END;");
	assert.throws(() => approve(1), /Synthetic queue failure/);
	assert.equal(db.prepare('SELECT step FROM telegram_registrations WHERE id=1').get().step, 'pending');
	for (const table of ['users', 'auth_credentials', 'telegram_group_invitations', 'telegram_website_links'])
		assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
});

test('group link lookup failures retry independently and retain approval across reinitialization', async (t) => {
	const { db, register, approve } = fixture(t);
	setTelegramWebsiteUrl(db, 'https://reports.example.test');
	register(1);
	const { user } = approve(1);
	const job = () => db.prepare('SELECT * FROM telegram_group_invitations WHERE user_id=?').get(user.id);
	let lookups = 0;
	const lookup = async () => { if (++lookups === 1) throw new Error('Synthetic timeout'); return 'https://t.me/+synthetic'; };
	await processGroupInvitation(db, () => assert.fail('No invite resolved yet'), 1000, lookup);
	assert.equal(job().status, 'pending');
	assert.equal(job().attempts, 1);
	assert.equal(job().invite_link, '');
	initializeSchema(db, schema);
	assert.equal(await processGroupInvitation(db, () => assert.fail('Backoff not expired'), 1029, lookup), false);
	await processWebsiteLink(db, async () => {}, 1000);
	assert.equal(db.prepare('SELECT status FROM telegram_website_links').get().status, 'sent');
	await processGroupInvitation(db, async () => { throw new Error('Synthetic send failure'); }, 1030, lookup);
	assert.equal(job().invite_link, 'https://t.me/+synthetic');
	await processGroupInvitation(db, async () => {}, 1090, () => assert.fail('Reuse already resolved invite'));
	assert.equal(job().status, 'sent');
	assert.equal(db.prepare('SELECT step FROM telegram_registrations').get().step, 'approved');
});

test('recipient identity and delivery lease are rechecked after asynchronous invite lookup', async (t) => {
	for (const change of ['relink', 'delete', 'lease']) await t.test(change, async (t) => {
		const { db, register, approve } = fixture(t);
		register(1);
		const { user } = approve(1);
		await processGroupInvitation(db, () => assert.fail('Stale recipient or delivery lease'), 1000, async () => {
			if (change === 'relink') db.prepare('UPDATE users SET telegram_user_id=? WHERE id=?').run('999', user.id);
			else if (change === 'delete') db.prepare('DELETE FROM users WHERE id=?').run(user.id);
			else db.prepare('UPDATE telegram_group_invitations SET lease_until=2000 WHERE user_id=?').run(user.id);
			return 'https://t.me/+synthetic';
		});
		const job = db.prepare('SELECT * FROM telegram_group_invitations').get();
		if (change === 'relink') assert.equal(job.status, 'failed');
		else if (change === 'delete') assert.equal(job, undefined);
		else { assert.equal(job.lease_until, 2000); assert.equal(job.invite_link, ''); }
	});
});

test('deleted or relinked recipients do not trigger invitation lookup or delivery', async (t) => {
	const { db, register, approve } = fixture(t);
	register(1);
	const { user } = approve(1);
	db.prepare('UPDATE users SET telegram_user_id=? WHERE id=?').run('999', user.id);
	await processGroupInvitation(db, () => assert.fail('Stale recipient'), 1000, () => assert.fail('Do not resolve invite'));
	assert.equal(db.prepare('SELECT status FROM telegram_group_invitations').get().status, 'failed');
});
