import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { queueTelegramStudyRefresh, telegramRefreshStatus, processTelegramStudyRefresh, cancelTelegramStudyRefresh } from '../src/lib/server/telegram-study-refresh.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const chatId = '-1001234567890';
function fixture(t, includeUnlinked = false) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	db.exec(schema);
	db.exec(`INSERT INTO studies(id,patient_code,patient_firstname,exam_date_jalali,exam_time,telegram_message_id,disabled)
		VALUES(1,'SYNTHETIC-1','Patient One','1405-01-01','10:00','42',0),
		(2,'SYNTHETIC-2','Patient Two','1405-01-01','10:00','52',1),
		(3,'SYNTHETIC-3','Unlinked','1405-01-01','10:00',NULL,0),
		(4,'SYNTHETIC-4','Blank link','1405-01-01','10:00','',1);
		INSERT INTO study_recordings(study_id,text_report_path,resident_checked,attending_checked,typist_checked)
		VALUES(1,'synthetic-report.md',1,1,1);
		INSERT INTO study_telegram_voices(study_id,chat_id,message_id,sender_name) VALUES(1,'${chatId}',43,'Resident');`);
	if (!includeUnlinked) db.exec('DELETE FROM studies WHERE id IN (3,4)');
	const original = { TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN };
	process.env.TELEGRAM_CHAT_ID = chatId;
	process.env.TELEGRAM_BOT_TOKEN = 'synthetic-refresh-token';
	t.after(() => {
		db.close();
		for (const [key, value] of Object.entries(original)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	});
	return db;
}

function clinicalSnapshot(db) {
	return ['studies', 'study_recordings', 'study_telegram_voices', 'pending_telegram', 'pending_voice']
		.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
}

test('queue includes linked and unlinked studies including disabled, and deduplicates active requests', (t) => {
	const db = fixture(t, true), before = clinicalSnapshot(db);
	const status = queueTelegramStudyRefresh(db);
	assert.equal(status.queued, 4);
	assert.equal(status.pending, 4);
	assert.deepEqual(db.prepare('SELECT study_id,chat_id,message_id FROM telegram_study_refresh ORDER BY study_id').all(), [
		{ study_id: 1, chat_id: chatId, message_id: '42' }, { study_id: 2, chat_id: chatId, message_id: '52' },
		{ study_id: 3, chat_id: chatId, message_id: '' }, { study_id: 4, chat_id: chatId, message_id: '' }
	]);
	assert.equal(queueTelegramStudyRefresh(db).already_running, true);
	assert.equal(queueTelegramStudyRefresh(db).queued, 0);
	assert.deepEqual(clinicalSnapshot(db), before);
});

test('worker edits originals with fresh reply links and disabled markup, never sends messages or changes clinical data', async (t) => {
	const db = fixture(t);
	queueTelegramStudyRefresh(db);
	db.exec("UPDATE studies SET description='Fresh details' WHERE id=1");
	const before = clinicalSnapshot(db), calls = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls.push({ endpoint: url.split('/').at(-1), ...JSON.parse(options.body) });
		return { json: async () => ({ ok: true, result: {} }) };
	});
	assert.equal(await processTelegramStudyRefresh(db, undefined, 100), true);
	assert.equal(await processTelegramStudyRefresh(db, undefined, 102), false);
	assert.equal(await processTelegramStudyRefresh(db, undefined, 103), true);
	assert.deepEqual(calls.map((call) => call.endpoint), ['editMessageText', 'editMessageText']);
	assert.deepEqual(calls.map((call) => call.message_id), ['42', '52']);
	assert.ok(calls.every((call) => call.chat_id === chatId));
	assert.match(calls[0].text, /Fresh details/);
	assert.match(calls[0].text, /https:\/\/t.me\/c\/1234567890\/43/);
	assert.match(calls[1].text, /disabled/i);
	assert.equal(telegramRefreshStatus(db).refreshed, 2);
	assert.deepEqual(clinicalSnapshot(db), before);
});

test('unchanged Telegram messages count as successfully refreshed', async (t) => {
	const db = fixture(t);
	queueTelegramStudyRefresh(db);
	t.mock.method(globalThis, 'fetch', async () => ({ json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }) }));
	await processTelegramStudyRefresh(db, undefined, 100);
	assert.equal(telegramRefreshStatus(db).refreshed, 1);
	assert.equal(telegramRefreshStatus(db).failed, 0);
});

test('Telegram 429 pauses the whole refresh queue and honors retry_after', async (t) => {
	const db = fixture(t);
	queueTelegramStudyRefresh(db);
	await processTelegramStudyRefresh(db, async () => { throw Object.assign(new Error('rate limited'), { telegram_error_code: 429, retry_after: 25 }); }, 100);
	assert.equal(telegramRefreshStatus(db).pending, 2);
	assert.equal(await processTelegramStudyRefresh(db, async () => assert.fail('Too early'), 124), false);
	assert.equal(await processTelegramStudyRefresh(db, async () => {}, 125), true);
	assert.equal(telegramRefreshStatus(db).refreshed, 1);
});

test('short Telegram retry_after values still preserve three-second pacing', async (t) => {
	const db = fixture(t);
	queueTelegramStudyRefresh(db);
	await processTelegramStudyRefresh(db, async () => { throw Object.assign(new Error('Rate limited'), { telegram_error_code: 429, retry_after: 1 }); }, 100);
	assert.equal(await processTelegramStudyRefresh(db, async () => assert.fail('Too early'), 102), false);
	assert.equal(await processTelegramStudyRefresh(db, async () => {}, 103), true);
});

test('temporary failures retry with backoff and stop after five failures', async (t) => {
	const db = fixture(t);
	db.exec('DELETE FROM studies WHERE id=2');
	queueTelegramStudyRefresh(db);
	let now = 100;
	for (let attempt = 1; attempt <= 5; attempt++) {
		await processTelegramStudyRefresh(db, async () => { throw new Error('Network unavailable'); }, now);
		const job = db.prepare('SELECT * FROM telegram_study_refresh').get();
		assert.equal(job.attempts, attempt);
		assert.equal(job.status, attempt === 5 ? 'failed' : 'pending');
		if (attempt < 5) assert.equal(await processTelegramStudyRefresh(db, async () => assert.fail('No early retries'), job.retry_at - 1), false);
		now = job.retry_at;
	}
	assert.equal(await processTelegramStudyRefresh(db, async () => assert.fail('Retry limit reached'), now), false);
	assert.equal(queueTelegramStudyRefresh(db).queued, 1);
	assert.equal(db.prepare('SELECT attempts FROM telegram_study_refresh').get().attempts, 0);
});

test('missing messages and permissions fail without blocking other studies', async (t) => {
	for (const code of [400, 401, 403]) {
		await t.test(`Telegram ${code}`, async (t) => {
			const db = fixture(t);
			queueTelegramStudyRefresh(db);
			await processTelegramStudyRefresh(db, async () => { throw Object.assign(new Error('Sensitive Telegram error'), { telegram_error_code: code }); }, 100);
			assert.equal(telegramRefreshStatus(db).failed, 1);
			assert.doesNotMatch(db.prepare('SELECT last_error FROM telegram_study_refresh WHERE study_id=1').get().last_error, /Sensitive/);
			await processTelegramStudyRefresh(db, async () => {}, 103);
			assert.equal(telegramRefreshStatus(db).pending, 0);
			assert.equal(telegramRefreshStatus(db).refreshed, 1);
		});
	}
});

test('changed study links and group configuration are skipped; removed studies cascade safely', async (t) => {
	const db = fixture(t);
	queueTelegramStudyRefresh(db);
	db.exec("UPDATE studies SET telegram_message_id='99' WHERE id=1");
	await processTelegramStudyRefresh(db, async () => assert.fail('Relinked study must not edit'), 100);
	process.env.TELEGRAM_CHAT_ID = '-1009999999999';
	await processTelegramStudyRefresh(db, async () => assert.fail('Changed group must not edit'), 103);
	assert.equal(telegramRefreshStatus(db).skipped, 2);
	queueTelegramStudyRefresh(db);
	db.exec('DELETE FROM studies WHERE id=2');
	assert.equal(telegramRefreshStatus(db).total, 1);
	assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('migration preserves jobs and pacing across restarts; expired leases recover', async (t) => {
	const db = fixture(t);
	db.exec('DROP TABLE telegram_study_refresh');
	initializeSchema(db, schema);
	queueTelegramStudyRefresh(db);
	db.exec("UPDATE telegram_study_refresh SET lease_until=160,lease_token='crashed-worker' WHERE study_id=1");
	initializeSchema(db, schema);
	const restarted = new Database(db.serialize());
	t.after(() => restarted.close());
	await processTelegramStudyRefresh(restarted, async (study) => assert.equal(study.id, 2), 100);
	const resumed = new Database(restarted.serialize());
	t.after(() => resumed.close());
	assert.equal(await processTelegramStudyRefresh(resumed, async () => assert.fail('Pacing survives restart'), 102), false);
	assert.equal(await processTelegramStudyRefresh(resumed, async () => assert.fail('Lease not expired'), 159), false);
	await processTelegramStudyRefresh(resumed, async (study) => assert.equal(study.id, 1), 160);
	assert.equal(telegramRefreshStatus(resumed).refreshed, 2);
	assert.deepEqual(resumed.pragma('foreign_key_check'), []);
});

test('overlapping workers respect pacing and a stale lease cannot overwrite a recovered job', async (t) => {
	const db = fixture(t);
	db.exec('DELETE FROM studies WHERE id=2');
	queueTelegramStudyRefresh(db);
	let finish;
	const pending = processTelegramStudyRefresh(db, () => new Promise((resolve) => { finish = resolve; }), 100);
	assert.equal(await processTelegramStudyRefresh(db, async () => assert.fail('Concurrent claim'), 100), false);
	await processTelegramStudyRefresh(db, async () => {}, 160);
	finish();
	await pending;
	assert.equal(telegramRefreshStatus(db).refreshed, 1);
});

test('stale rate-limit failures cannot delay a recovered or new refresh run', async (t) => {
	const db = fixture(t);
	db.exec('DELETE FROM studies WHERE id=2');
	queueTelegramStudyRefresh(db);
	let fail;
	const pending = processTelegramStudyRefresh(db, () => new Promise((resolve, reject) => { fail = reject; }), 100);
	await processTelegramStudyRefresh(db, async () => {}, 160);
	queueTelegramStudyRefresh(db);
	fail(Object.assign(new Error('Late rate limit'), { telegram_error_code: 429, retry_after: 3600 }));
	await pending;
	assert.equal(await processTelegramStudyRefresh(db, async () => {}, 163), true);
	assert.equal(telegramRefreshStatus(db).refreshed, 1);
});

test('cancellation persists across restarts, preserves completed work and clinical data, and is idempotent without configuration', async (t) => {
	const db = fixture(t, true);
	db.exec('INSERT INTO pending_telegram(study_id) VALUES(3)');
	queueTelegramStudyRefresh(db);
	await processTelegramStudyRefresh(db, async () => {}, 100);
	const before = clinicalSnapshot(db);
	const pacing = db.prepare("SELECT value FROM application_settings WHERE key='telegram_refresh_next_at'").get();
	delete process.env.TELEGRAM_BOT_TOKEN;
	const result = cancelTelegramStudyRefresh(db);
	assert.equal(result.cancelled, 3);
	assert.equal(result.pending, 0);
	assert.equal(result.skipped, 3);
	assert.equal(result.refreshed, 1);
	assert.equal(cancelTelegramStudyRefresh(db).cancelled, 0);
	assert.deepEqual(clinicalSnapshot(db), before);
	assert.deepEqual(db.prepare("SELECT value FROM application_settings WHERE key='telegram_refresh_next_at'").get(), pacing);
	const restarted = new Database(db.serialize());
	t.after(() => restarted.close());
	process.env.TELEGRAM_BOT_TOKEN = 'synthetic-refresh-token';
	assert.equal(await processTelegramStudyRefresh(restarted, async () => assert.fail('Cancelled jobs cannot resume'), 1000), false);
	assert.equal(queueTelegramStudyRefresh(restarted).queued, 4, 'a new explicit refresh is allowed');
});

test('cancelling during an edit prevents a missing-message replacement or failure retry', async (t) => {
	for (const code of [400, 429, undefined]) {
		await t.test(`failure ${code}`, async (t) => {
			const db = fixture(t);
			queueTelegramStudyRefresh(db);
			let fail;
			const work = processTelegramStudyRefresh(db, () => new Promise((_resolve, reject) => { fail = reject; }), 100,
				async () => assert.fail('Cancelled edit must not send a replacement'));
			assert.equal(cancelTelegramStudyRefresh(db).cancelled, 2);
			fail(Object.assign(new Error('message to edit not found'), { telegram_error_code: code, retry_after: 3600 }));
			await work;
			assert.equal(telegramRefreshStatus(db).pending, 0);
			assert.equal(telegramRefreshStatus(db).skipped, 2);
			assert.equal(await processTelegramStudyRefresh(db, async () => assert.fail('Cancelled retry'), 5000), false);
		});
	}
});

test('an already-sent edit may complete after cancellation without changing cancelled or newly queued jobs', async (t) => {
	const db = fixture(t);
	queueTelegramStudyRefresh(db);
	let finish;
	const work = processTelegramStudyRefresh(db, () => new Promise((resolve) => { finish = resolve; }), 100);
	cancelTelegramStudyRefresh(db);
	assert.equal(queueTelegramStudyRefresh(db).queued, 2);
	finish();
	await work;
	assert.equal(telegramRefreshStatus(db).pending, 2);
	assert.equal(telegramRefreshStatus(db).refreshed, 0);
	assert.equal(await processTelegramStudyRefresh(db, async () => assert.fail('Pacing is preserved'), 102), false);
});

test('cancelling during a replacement send still saves the returned message ID and releases the notification lease', async (t) => {
	const db = fixture(t, true);
	queueTelegramStudyRefresh(db, 3);
	let finish;
	const work = processTelegramStudyRefresh(db, undefined, 100, () => new Promise((resolve) => { finish = resolve; }));
	assert.equal(cancelTelegramStudyRefresh(db).cancelled, 1);
	finish({ message_id: 401 });
	await work;
	assert.deepEqual(db.prepare('SELECT telegram_message_id,telegram_send_started_at FROM studies WHERE id=3').get(),
		{ telegram_message_id: '401', telegram_send_started_at: null });
	assert.equal(telegramRefreshStatus(db).pending, 0);
	assert.equal(telegramRefreshStatus(db).skipped, 1);
});

test('missing Telegram configuration cannot queue edits or start work', async (t) => {
	const db = fixture(t);
	delete process.env.TELEGRAM_BOT_TOKEN;
	assert.throws(() => queueTelegramStudyRefresh(db), { status: 503 });
	assert.equal(telegramRefreshStatus(db).configured, false);
	assert.equal(await processTelegramStudyRefresh(db, async () => assert.fail('Not configured'), 100), false);
	assert.equal(telegramRefreshStatus(db).total, 0);
});

test('single-study requests preserve other pending work and can retry completed jobs', async (t) => {
	const db = fixture(t, true);
	assert.throws(() => queueTelegramStudyRefresh(db, 999), { status: 404 });
	assert.equal(queueTelegramStudyRefresh(db, 1).queued, 1);
	assert.equal(queueTelegramStudyRefresh(db, 3).queued, 1);
	assert.equal(queueTelegramStudyRefresh(db, 1).already_running, true);
	assert.equal(queueTelegramStudyRefresh(db).queued, 2, 'bulk action extends pending single-study work');
	assert.equal(queueTelegramStudyRefresh(db).already_running, true);
	await processTelegramStudyRefresh(db, async () => {}, 100);
	assert.equal(queueTelegramStudyRefresh(db, 1).queued, 1);
	assert.deepEqual(db.prepare("SELECT study_id FROM telegram_study_refresh WHERE status='pending' ORDER BY study_id").all(), [{ study_id: 1 }, { study_id: 2 }, { study_id: 3 }, { study_id: 4 }]);
});

test('missing and blank links are created for active and disabled studies using current status', async (t) => {
	const db = fixture(t, true), calls = [];
	queueTelegramStudyRefresh(db, 3);
	queueTelegramStudyRefresh(db, 4);
	db.exec("UPDATE studies SET description='Latest status' WHERE id=3; INSERT INTO pending_telegram(study_id) VALUES(3)");
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls.push({ endpoint: url.split('/').at(-1), ...JSON.parse(options.body) });
		return { json: async () => ({ ok: true, result: { message_id: 100 + calls.length } }) };
	});
	await processTelegramStudyRefresh(db, undefined, 100);
	await processTelegramStudyRefresh(db, undefined, 103);
	assert.deepEqual(calls.map(({ endpoint }) => endpoint), ['sendMessage', 'sendMessage']);
	assert.match(calls[0].text, /Latest status/);
	assert.match(calls[1].text, /DISABLED/);
	assert.deepEqual(db.prepare('SELECT telegram_message_id,disabled FROM studies WHERE id IN (3,4) ORDER BY id').all(), [
		{ telegram_message_id: '101', disabled: 0 }, { telegram_message_id: '102', disabled: 1 }
	]);
	assert.equal(db.prepare('SELECT count(*) AS n FROM pending_telegram').get().n, 0);
	assert.equal(telegramRefreshStatus(db).refreshed, 2);
	assert.equal(db.prepare('SELECT count(*) AS n FROM studies WHERE telegram_send_started_at IS NOT NULL').get().n, 0);
});

test('a confirmed deleted Telegram root is replaced once without modifying recordings or signatures', async (t) => {
	const db = fixture(t), calls = [];
	queueTelegramStudyRefresh(db, 1);
	const recordings = db.prepare('SELECT * FROM study_recordings').all();
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		const endpoint = url.split('/').at(-1);
		calls.push({ endpoint, ...JSON.parse(options.body) });
		return { json: async () => endpoint === 'editMessageText'
			? { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }
			: { ok: true, result: { message_id: 200 } } };
	});
	await processTelegramStudyRefresh(db, undefined, 100);
	assert.deepEqual(calls.map(({ endpoint }) => endpoint), ['editMessageText', 'sendMessage']);
	assert.match(calls[1].text, /Reports: 1/);
	assert.match(calls[1].text, /Signed: Resident 1.*Attending 1.*Typist \(printed\) 1/);
	assert.equal(db.prepare('SELECT telegram_message_id FROM studies WHERE id=1').get().telegram_message_id, '200');
	assert.deepEqual(db.prepare('SELECT * FROM study_recordings').all(), recordings);
	assert.equal(await processTelegramStudyRefresh(db, undefined, 103), false);
});

test('uneditable messages and Telegram permission or network errors never create replacements', async (t) => {
	for (const [code, message] of [[400, "message can't be edited"], [403, 'Forbidden'], [401, 'Unauthorized'], [429, 'Rate limited'], [undefined, 'Network timeout']]) {
		await t.test(message, async (t) => {
			const db = fixture(t);
			queueTelegramStudyRefresh(db, 1);
			await processTelegramStudyRefresh(db, async () => { throw Object.assign(new Error(message), { telegram_error_code: code }); }, 100,
				async () => assert.fail('Must not create a replacement'));
			assert.equal(db.prepare('SELECT telegram_message_id FROM studies WHERE id=1').get().telegram_message_id, '42');
		});
	}
});

test('notification send leases prevent concurrent recovery; latest changed links are not overwritten', async (t) => {
	const db = fixture(t, true);
	queueTelegramStudyRefresh(db, 3);
	db.prepare('UPDATE studies SET telegram_send_started_at=? WHERE id=3').run(Math.floor(Date.now() / 1000));
	await processTelegramStudyRefresh(db, undefined, 100, async () => assert.fail('Notification owns the send lease'));
	assert.equal(telegramRefreshStatus(db).pending, 1);
	const retryAt = db.prepare('SELECT retry_at FROM telegram_study_refresh').get().retry_at;
	db.exec("UPDATE studies SET telegram_message_id='99',telegram_send_started_at=NULL WHERE id=3");
	await processTelegramStudyRefresh(db, undefined, retryAt, async () => assert.fail('Link already created'));
	assert.equal(telegramRefreshStatus(db).skipped, 1);
});

test('notification and recovery workers do not duplicate simultaneous sends in either order', async (t) => {
	const { processStudyNotification } = await import('../src/lib/server/study-notifications.js');
	for (const recoveryFirst of [false, true]) {
		await t.test(recoveryFirst ? 'recovery first' : 'notification first', async (t) => {
			const db = fixture(t, true);
			db.exec('INSERT INTO pending_telegram(study_id) VALUES(3)');
			queueTelegramStudyRefresh(db, 3);
			let finish;
			const send = () => new Promise((resolve) => { finish = () => resolve({ message_id: 301 }); });
			const work = recoveryFirst ? processTelegramStudyRefresh(db, undefined, 100, send) : processStudyNotification(db, send, 100);
			if (recoveryFirst) assert.equal(await processStudyNotification(db, async () => assert.fail('Duplicate send'), 100), false);
			else await processTelegramStudyRefresh(db, undefined, 100, async () => assert.fail('Duplicate send'));
			finish();
			await work;
			if (!recoveryFirst) await processTelegramStudyRefresh(db, undefined, 130, async () => assert.fail('Already sent'));
			assert.equal(db.prepare('SELECT telegram_message_id FROM studies WHERE id=3').get().telegram_message_id, '301');
			assert.equal(db.prepare('SELECT count(*) AS n FROM pending_telegram').get().n, 0);
			assert.equal(telegramRefreshStatus(db).pending, 0);
		});
	}
});

test('recovery send blocks deletion and restoration until completion and releases its lease on errors', async (t) => {
	const db = fixture(t, true);
	const { deleteStudy, restoreStudy } = await import('../src/lib/server/study-deletion.js');
	queueTelegramStudyRefresh(db, 4);
	let fail;
	const work = processTelegramStudyRefresh(db, undefined, 100, () => new Promise((_resolve, reject) => { fail = reject; }));
	await assert.rejects(deleteStudy(db, 4), { status: 409 });
	assert.throws(() => restoreStudy(db, 4), { status: 409 });
	fail(new Error('Send failed'));
	await work;
	assert.equal(db.prepare('SELECT telegram_send_started_at FROM studies WHERE id=4').get().telegram_send_started_at, null);
	assert.equal(telegramRefreshStatus(db).pending, 1);
});

test('a deletion already in progress cannot recreate a root message', async (t) => {
	const db = fixture(t);
	const { deleteStudy } = await import('../src/lib/server/study-deletion.js');
	queueTelegramStudyRefresh(db, 2);
	let finish;
	const deletion = deleteStudy(db, 2, {}, () => new Promise((resolve) => { finish = resolve; }));
	await processTelegramStudyRefresh(db, async () => assert.fail('Deleting study must not be edited'), 100, async () => assert.fail('Deleting study must not be recreated'));
	assert.equal(telegramRefreshStatus(db).pending, 1);
	finish();
	await deletion;
	assert.equal(telegramRefreshStatus(db).total, 0);
});

test('single-study API enforces admin access and strict IDs before DB access and queues only the requested study', async (t) => {
	const db = fixture(t, true), key = `refreshDb_${randomUUID()}`;
	t.after(() => delete globalThis[key]);
	const source = readFileSync(new URL('../src/routes/api/studies/[id]/telegram-refresh/+server.js', import.meta.url), 'utf8')
		.replace(/from (['"])([^'"]+)\1/g, (_statement, _quote, specifier) => {
			const resolved = specifier === '$lib/server/db'
				? `data:text/javascript,${encodeURIComponent(`export function getDb(){if(!globalThis[${JSON.stringify(key)}])throw Error('Unauthorized database access');return globalThis[${JSON.stringify(key)}]}`)}`
				: specifier.startsWith('$lib/') ? new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href : import.meta.resolve(specifier);
			return `from ${JSON.stringify(resolved)}`;
		});
	const { POST } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
	assert.equal(POST({ locals: {}, params: { id: '1' } }).status, 401);
	for (const role of ['resident', 'attending', 'typist'])
		assert.equal(POST({ locals: { user: { role } }, params: { id: '1' } }).status, 403);
	const admin = { locals: { user: { role: 'admin' } } };
	for (const id of ['0', '-1', '1.5', '1x', '01', '9007199254740992'])
		assert.equal(POST({ ...admin, params: { id } }).status, 400);
	globalThis[key] = db;
	assert.equal(POST({ ...admin, params: { id: '999' } }).status, 404);
	assert.equal((await POST({ ...admin, params: { id: '4' } }).json()).queued, 1);
	assert.equal((await POST({ ...admin, params: { id: '4' } }).json()).already_running, true);
	assert.equal(telegramRefreshStatus(db).pending, 1);
	delete process.env.TELEGRAM_BOT_TOKEN;
	assert.equal(POST({ ...admin, params: { id: '1' } }).status, 503);
});

test('refresh API denies anonymous and all non-admin roles before accessing the database', async (t) => {
	const db = fixture(t), key = `refreshDb_${randomUUID()}`;
	globalThis[key] = db;
	t.after(() => delete globalThis[key]);
	const source = readFileSync(new URL('../src/routes/api/telegram/study-refresh/+server.js', import.meta.url), 'utf8')
		.replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
			const resolved = specifier === '$lib/server/db'
				? `data:text/javascript,${encodeURIComponent(`export function getDb(){if(!globalThis[${JSON.stringify(key)}])throw Error('Unauthorized database access');return globalThis[${JSON.stringify(key)}]}`)}`
				: specifier.startsWith('$lib/') ? new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href : import.meta.resolve(specifier);
			return `from ${JSON.stringify(resolved)}`;
		});
	const { GET, POST, DELETE } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
	delete globalThis[key];
	for (const handler of [GET, POST, DELETE]) {
		assert.equal(handler({ locals: {} }).status, 401);
		for (const role of ['resident', 'attending', 'typist']) assert.equal(handler({ locals: { user: { role } } }).status, 403);
	}
	globalThis[key] = db;
	const admin = { locals: { user: { role: 'admin' } } };
	assert.equal((await GET(admin).json()).total, 0);
	assert.equal((await POST(admin).json()).queued, 2);
	assert.equal((await POST(admin).json()).already_running, true);
	assert.equal((await GET(admin).json()).pending, 2);
	delete process.env.TELEGRAM_BOT_TOKEN;
	assert.equal(POST(admin).status, 503);
	const cancelled = await DELETE(admin).json();
	assert.equal(cancelled.cancelled, 2);
	assert.equal(cancelled.pending, 0);
	assert.equal((await DELETE(admin).json()).cancelled, 0);
	delete globalThis[key];
	assert.equal(DELETE(admin).status, 500);
	assert.equal((await DELETE(admin).json()).error, 'Unable to cancel Telegram study refresh.');
});
