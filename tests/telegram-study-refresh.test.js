import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { queueTelegramStudyRefresh, telegramRefreshStatus, processTelegramStudyRefresh } from '../src/lib/server/telegram-study-refresh.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const chatId = '-1001234567890';
function fixture(t) {
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

test('queue includes every linked study including disabled, excludes unlinked, and deduplicates active requests', (t) => {
	const db = fixture(t), before = clinicalSnapshot(db);
	const status = queueTelegramStudyRefresh(db);
	assert.equal(status.queued, 2);
	assert.equal(status.pending, 2);
	assert.deepEqual(db.prepare('SELECT study_id,chat_id,message_id FROM telegram_study_refresh ORDER BY study_id').all(), [
		{ study_id: 1, chat_id: chatId, message_id: '42' }, { study_id: 2, chat_id: chatId, message_id: '52' }
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
	db.exec('UPDATE studies SET telegram_message_id=NULL WHERE id=2');
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
	db.exec('UPDATE studies SET telegram_message_id=NULL WHERE id=2');
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
	db.exec('UPDATE studies SET telegram_message_id=NULL WHERE id=2');
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

test('missing Telegram configuration cannot queue edits or start work', async (t) => {
	const db = fixture(t);
	delete process.env.TELEGRAM_BOT_TOKEN;
	assert.throws(() => queueTelegramStudyRefresh(db), { status: 503 });
	assert.equal(telegramRefreshStatus(db).configured, false);
	assert.equal(await processTelegramStudyRefresh(db, async () => assert.fail('Not configured'), 100), false);
	assert.equal(telegramRefreshStatus(db).total, 0);
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
	const { GET, POST } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
	delete globalThis[key];
	for (const handler of [GET, POST]) {
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
});
