import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { telegramIndexStatus, queueTelegramIndexRebuild, processTelegramTopicIndex } from '../src/lib/server/telegram-study-index.js';
import { processTelegramStudyRefresh, queueTelegramStudyRefresh } from '../src/lib/server/telegram-study-refresh.js';
import { processStudyNotification } from '../src/lib/server/study-notifications.js';
import { previewStudyImport, commitStudyImport } from '../src/lib/server/study-import.js';
import { insertStudy, getStudyDetail } from '../src/lib/server/studies.js';
import { sendStudyMessage } from '../src/lib/server/telegram.js';
import { handleTelegramGroupMessage } from '../src/lib/server/telegram-group.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const chatId = '-1001234567890';
function fixture(t, source = schema) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	db.exec(source);
	db.exec(`INSERT INTO users(id,full_name,role) VALUES(1,'Synthetic Admin','admin'),(3,'Dr Alpha','attending'),(4,'Dr Beta','attending');
		INSERT INTO modalities(id,code,name) VALUES(1,'CT','CT');
		INSERT INTO studies(id,patient_code,patient_fullname,exam_date_jalali,exam_time,corresponding_attending_id,telegram_message_id,disabled,source_modality,description)
		VALUES(1,'SYNTHETIC-1','Patient One','1405-07-28','08:00',3,'42',0,'CT','Chest'),
		(2,'SYNTHETIC-2','Patient Two','1405-07-29','07:59',3,'52',1,'MR','Brain'),
		(3,'SYNTHETIC-3','Patient Three','1405-07-29','08:00',4,'62',0,'CT','Abdomen'),
		(4,'SYNTHETIC-4','Patient Four','1405-07-29','12:00',NULL,'72',0,'CT','Knee'),
		(5,'SYNTHETIC-5','Unlinked','1405-07-29','12:00',NULL,NULL,0,'CT','Spine');
		INSERT INTO study_recordings(study_id,text_report_path,resident_checked,attending_checked,typist_checked)
		VALUES(1,'synthetic-report.md',1,1,1);
		INSERT INTO study_telegram_voices(study_id,chat_id,message_id,sender_name) VALUES(1,'${chatId}',43,'Synthetic Resident');`);
	const original = { TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN };
	process.env.TELEGRAM_CHAT_ID = chatId;
	process.env.TELEGRAM_BOT_TOKEN = 'synthetic-index-token';
	t.after(() => {
		db.close();
		for (const [key, value] of Object.entries(original)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	});
	const calls = [];
	let now = 1000, next = 10000;
	const clock = () => now;
	const api = {
		create: async (...args) => { calls.push({ operation: 'create', args }); return ++next; },
		send: async (...args) => { calls.push({ operation: 'send', args }); return ++next; },
		edit: async (...args) => { calls.push({ operation: 'edit', args }); }
	};
	const step = async (custom = api) => { const result = await processTelegramTopicIndex(db, custom, clock); now += 3; return result; };
	const drain = async () => {
		for (let n = 0; n < 200 && telegramIndexStatus(db).active; n++) await step();
		assert.equal(telegramIndexStatus(db).active, false, 'Index queue must finish');
	};
	return { db, api, calls, clock, step, drain, advance: (seconds) => { now += seconds; } };
}

function clinicalSnapshot(db) {
	return ['studies', 'study_recordings', 'study_telegram_voices', 'pending_voice', 'pending_telegram']
		.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
}

test('existing studies automatically get clinical-day topics and separate attending lists without touching originals or reports', async (t) => {
	const { db, calls, drain } = fixture(t);
	const before = clinicalSnapshot(db);
	await drain();
	assert.equal(telegramIndexStatus(db).topics, 2);
	assert.equal(telegramIndexStatus(db).synced, 3);
	assert.equal(calls.filter((call) => call.operation === 'create').length, 2);
	assert.equal(calls.filter((call) => call.operation === 'send').length, 3);
	const pages = db.prepare('SELECT * FROM telegram_index_pages ORDER BY clinical_day,attending_id').all();
	assert.match(pages[0].sent_text, /Dr Alpha/);
	assert.match(pages[0].sent_text, /SYNTHETIC-1/);
	assert.match(pages[0].sent_text, /SYNTHETIC-2/);
	assert.match(pages[0].sent_text, /disabled/i);
	assert.match(pages[0].sent_text, /https:\/\/t.me\/c\/1234567890\/42/);
	assert.equal(pages[0].clinical_day, '1405-07-28');
	assert.match(pages[1].sent_text, /Unassigned attending/);
	assert.match(pages[2].sent_text, /Dr Beta/);
	assert.ok(pages.every((page) => !page.sent_text.includes('SYNTHETIC-5')));
	assert.deepEqual(clinicalSnapshot(db), before);
});

test('new study and Excel import use entered examination dates and only index after original notification is linked', async (t) => {
	const { db, calls, drain } = fixture(t);
	await drain();
	calls.length = 0;
	const id = insertStudy(db, { patient_code: 'NEW-STUDY', patient_fullname: 'New Patient', exam_date_jalali: '1405-07-30', exam_time: '07:30', corresponding_attending_id: 3 });
	db.prepare('INSERT INTO pending_telegram(study_id) VALUES (?)').run(id);
	await drain();
	assert.equal(calls.length, 0);
	await processStudyNotification(db, async (study) => { assert.equal(study.id, id); return { message_id: 82 }; }, 0);
	await drain();
	assert.equal(db.prepare("SELECT clinical_day FROM telegram_index_pages WHERE sent_text LIKE '%NEW-STUDY%'").get().clinical_day, '1405-07-29');
	const row = { row: 2, source_study_uid: 'synthetic-import-uid', patient_code: 'EXCEL-STUDY', patient_fullname: 'Excel Patient', patient_gender: 'unknown', patient_age: null, patient_age_unit: 'Y', modality_code: 'CT', source_description: 'Excel chest', exam_date_jalali: '1405-08-01', exam_time: '07:59:59', errors: [] };
	const preview = previewStudyImport(db, [row]);
	assert.equal(preview.rows[0].status, 'ready');
	assert.equal(commitStudyImport(db, preview, [2], { corresponding_attending_id: 4 }, { queueTelegram: true }).inserted, 1);
	await processStudyNotification(db, async () => ({ message_id: 92 }), 0);
	await drain();
	assert.equal(db.prepare("SELECT clinical_day FROM telegram_index_pages WHERE sent_text LIKE '%EXCEL-STUDY%'").get().clinical_day, '1405-07-30');
});

test('reassignment, examination date changes, demographics, modality and attending-name edits reconcile old and new lists', async (t) => {
	const { db, calls, drain } = fixture(t);
	await drain();
	const originalMessage = db.prepare("SELECT message_id FROM telegram_index_pages WHERE clinical_day='1405-07-28'").get().message_id;
	db.exec("UPDATE studies SET corresponding_attending_id=4,exam_date_jalali='1405-07-29',patient_fullname='Renamed Patient',description='Updated chest',source_modality='XR' WHERE id=1; UPDATE users SET full_name='Dr Renamed' WHERE id=4");
	await drain();
	const old = db.prepare('SELECT * FROM telegram_index_pages WHERE message_id=?').get(originalMessage);
	assert.doesNotMatch(old.sent_text, /SYNTHETIC-1/);
	assert.match(old.sent_text, /SYNTHETIC-2/);
	const updated = db.prepare("SELECT * FROM telegram_index_pages WHERE clinical_day='1405-07-29' AND attending_id=4").get();
	for (const text of ['SYNTHETIC-1', 'Renamed Patient', 'Updated chest', 'XR', 'Dr Renamed']) assert.ok(updated.sent_text.includes(text));
	assert.equal(calls.filter((call) => call.operation === 'create').length, 2, 'Existing topics are reused');
	assert.ok(calls.some((call) => call.operation === 'edit' && call.args[1] === originalMessage));
});

test('deletion and shrinking multipage lists remove stale entries without deleting topics or clinical data', async (t) => {
	const { db, drain } = fixture(t);
	const insert = db.prepare(`INSERT INTO studies(patient_code,patient_fullname,exam_date_jalali,exam_time,corresponding_attending_id,telegram_message_id,description)
		VALUES(?,?,'1405-07-28','10:00',3,?,?)`);
	for (let n = 0; n < 30; n++) insert.run(`LONG-${n}`, `Synthetic Patient ${n}`, String(200 + n), 'Long description '.repeat(20));
	await drain();
	assert.ok(db.prepare("SELECT COUNT(*) AS n FROM telegram_index_pages WHERE clinical_day='1405-07-28'").get().n > 1);
	db.exec("DELETE FROM studies WHERE patient_code LIKE 'LONG-%'; DELETE FROM studies WHERE id=1");
	await drain();
	const pages = db.prepare("SELECT sent_text FROM telegram_index_pages WHERE clinical_day='1405-07-28' ORDER BY page_number").all();
	assert.ok(pages.every((page) => !/LONG-|SYNTHETIC-1/.test(page.sent_text)));
	assert.ok(pages.slice(1).every((page) => /No studies currently/.test(page.sent_text)));
	db.exec('DELETE FROM studies WHERE id=2');
	await drain();
	assert.equal(telegramIndexStatus(db).topics, 2);
	assert.ok(db.prepare("SELECT sent_text FROM telegram_index_pages WHERE clinical_day='1405-07-28'").all().every((row) => /No studies currently/.test(row.sent_text)));
	assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('unchanged plans do not send edits; explicit rebuild refreshes saved index posts and deduplicates active requests', async (t) => {
	const { db, calls, drain, step } = fixture(t);
	assert.equal(queueTelegramIndexRebuild(db).already_running, true);
	await drain();
	calls.length = 0;
	db.exec("UPDATE studies SET description=description WHERE id=1");
	await drain();
	assert.equal(calls.length, 0);
	assert.equal(queueTelegramIndexRebuild(db).already_running, false);
	assert.equal(queueTelegramIndexRebuild(db).already_running, true);
	await drain();
	assert.equal(calls.filter((call) => call.operation === 'edit').length, 3);
	assert.equal(await step(), false);
});

test('rate limits share durable cooldown with original-message refresh and honor time of failure', async (t) => {
	const { db, api, clock, step, advance } = fixture(t);
	await step({ ...api, create: async () => { advance(10); throw Object.assign(new Error('Limited'), { telegram_error_code: 429, retry_after: 25 }); } });
	queueTelegramStudyRefresh(db);
	assert.equal(await processTelegramStudyRefresh(db, async () => assert.fail('Shared Telegram cooldown'), clock()), false);
	assert.equal(await step(), false);
	advance(25);
	assert.equal(await step(), true);
	assert.equal(await processTelegramStudyRefresh(db, async () => assert.fail('Pacing shared'), clock() - 1), false);
});

test('missing Topics or permissions pause indexing safely and an admin rebuild resumes without reposting originals', async (t) => {
	const { db, api, step, drain } = fixture(t);
	await step({ ...api, create: async () => { throw Object.assign(new Error('Sensitive raw message'), { telegram_error_code: 400 }); } });
	let status = telegramIndexStatus(db);
	assert.equal(status.paused, true);
	assert.equal(status.active, false);
	assert.equal(status.failed, 1);
	assert.match(status.last_error, /Manage Topics/);
	assert.doesNotMatch(status.last_error, /Sensitive/);
	assert.equal(await step(), false);
	assert.equal(queueTelegramIndexRebuild(db).already_running, false);
	await drain();
	status = telegramIndexStatus(db);
	assert.equal(status.paused, false);
	assert.equal(status.failed, 0);
	assert.equal(status.last_error, null);
	assert.equal(status.synced, 3);
	assert.equal(db.prepare('SELECT telegram_message_id FROM studies WHERE id=1').get().telegram_message_id, '42');
});

test('temporary failures back off, then synchronize successfully and clear error feedback', async (t) => {
	const { db, api, step, drain, advance } = fixture(t);
	await step({ ...api, create: async () => { throw new Error('Network unavailable'); } });
	assert.equal(telegramIndexStatus(db).failed, 0);
	assert.ok(telegramIndexStatus(db).last_error);
	advance(30);
	await drain();
	assert.equal(telegramIndexStatus(db).last_error, null);
	assert.equal(telegramIndexStatus(db).synced, 3);
});

test('temporary failures stop after five attempts and an admin rebuild resets the retry budget', async (t) => {
	const { db, api, clock, step, drain, advance } = fixture(t);
	db.exec('DELETE FROM studies WHERE id != 1');
	for (let attempt = 1; attempt <= 5; attempt++) {
		await step({ ...api, create: async () => { throw new Error('Persistent network failure'); } });
		const job = db.prepare('SELECT * FROM telegram_index_pages').get();
		assert.equal(job.attempts, attempt);
		assert.equal(job.status, attempt === 5 ? 'failed' : 'pending');
		advance(Math.max(0, job.retry_at - clock()));
	}
	assert.equal(telegramIndexStatus(db).active, false);
	assert.equal(await step(), false);
	queueTelegramIndexRebuild(db);
	await drain();
	assert.equal(telegramIndexStatus(db).synced, 1);
	assert.equal(telegramIndexStatus(db).failed, 0);
});

test('a nonrecoverable index edit failure does not mark success or block other lists', async (t) => {
	const { db, api, step, drain } = fixture(t);
	await drain();
	queueTelegramIndexRebuild(db);
	await step({ ...api, edit: async () => { throw Object.assign(new Error('Bad Request: message cannot be edited'), { telegram_error_code: 400 }); } });
	await drain();
	assert.equal(telegramIndexStatus(db).failed, 1);
	assert.equal(telegramIndexStatus(db).synced, 2);
	assert.equal(telegramIndexStatus(db).paused, false);
	queueTelegramIndexRebuild(db);
	await drain();
	assert.equal(telegramIndexStatus(db).synced, 3);
	assert.equal(telegramIndexStatus(db).last_error, null);
});

test('deleted index posts and topics are recreated without creating new study messages', async (t) => {
	const { db, api, step, drain } = fixture(t);
	await drain();
	queueTelegramIndexRebuild(db);
	await step({ ...api, edit: async () => { throw Object.assign(new Error('Bad Request: message to edit not found'), { telegram_error_code: 400 }); } });
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_index_pages WHERE message_id IS NULL').get().n, 1);
	await step({ ...api, send: async () => { throw Object.assign(new Error('Bad Request: message thread not found'), { telegram_error_code: 400 }); } });
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_index_topics WHERE message_thread_id IS NULL').get().n, 1);
	await drain();
	assert.equal(telegramIndexStatus(db).synced, 3);
	assert.equal(telegramIndexStatus(db).topics, 2);
});

test('idempotent upgrade preserves original data and saved topics/pages across restart, with expired lease recovery', async (t) => {
	const oldSchema = schema.replace(/CREATE TABLE IF NOT EXISTS telegram_index_revision \([\s\S]*?(?=CREATE TABLE IF NOT EXISTS telegram_study_refresh \()/, '');
	const { db, api, clock, drain } = fixture(t, oldSchema);
	const before = clinicalSnapshot(db);
	initializeSchema(db, schema);
	initializeSchema(db, schema);
	assert.deepEqual(clinicalSnapshot(db), before);
	await drain();
	const topics = db.prepare('SELECT * FROM telegram_index_topics').all();
	queueTelegramIndexRebuild(db);
	db.prepare('UPDATE telegram_index_state SET lease_token=?,lease_until=? WHERE chat_id=?').run('crashed-worker', clock() + 60, chatId);
	const restarted = new Database(db.serialize());
	t.after(() => restarted.close());
	assert.equal(await processTelegramTopicIndex(restarted, api, clock), false);
	assert.equal(await processTelegramTopicIndex(restarted, api, () => clock() + 60), true);
	assert.deepEqual(restarted.prepare('SELECT * FROM telegram_index_topics').all(), topics);
	assert.deepEqual(restarted.pragma('foreign_key_check'), []);
});

test('overlapping workers cannot claim a topic twice and expired callbacks cannot overwrite a new lease', async (t) => {
	const { db, api, clock, advance } = fixture(t);
	let resolve;
	const pending = processTelegramTopicIndex(db, { ...api, create: () => new Promise((done) => { resolve = done; }) }, clock);
	assert.equal(await processTelegramTopicIndex(db, api, clock), false);
	advance(60);
	await processTelegramTopicIndex(db, api, clock);
	const thread = db.prepare('SELECT message_thread_id FROM telegram_index_topics WHERE message_thread_id IS NOT NULL').get().message_thread_id;
	resolve(999999);
	await pending;
	assert.equal(db.prepare('SELECT message_thread_id FROM telegram_index_topics WHERE message_thread_id IS NOT NULL').get().message_thread_id, thread);
});

test('a study edited during an outgoing request is reconciled again after the request completes', async (t) => {
	const { db, api, clock, step, drain } = fixture(t);
	await step();
	let resolve;
	const pending = processTelegramTopicIndex(db, { ...api, send: () => new Promise((done) => { resolve = done; }) }, clock);
	db.exec("UPDATE studies SET patient_fullname='Changed in flight' WHERE id=3");
	resolve(123456);
	await pending;
	await drain();
	assert.match(db.prepare('SELECT sent_text FROM telegram_index_pages WHERE attending_id=4').get().sent_text, /Changed in flight/);
});

test('forum service messages and saved index posts survive audio-only moderation', async (t) => {
	const { db, drain } = fixture(t);
	await drain();
	const dependencies = { remove: async () => assert.fail('Do not delete forum service/index posts') };
	for (const key of ['forum_topic_created', 'forum_topic_edited', 'forum_topic_closed', 'forum_topic_reopened', 'general_forum_topic_hidden', 'general_forum_topic_unhidden']) {
		assert.equal(await handleTelegramGroupMessage(db, { chat: { id: Number(chatId) }, message_id: 700, [key]: {} }, dependencies), false);
	}
	const index = db.prepare('SELECT message_id FROM telegram_index_pages LIMIT 1').get();
	assert.equal(await handleTelegramGroupMessage(db, { chat: { id: Number(chatId) }, message_id: index.message_id, text: 'Index' }, dependencies), false);
	let removed = false;
	await handleTelegramGroupMessage(db, { chat: { id: Number(chatId) }, message_id: 999, text: 'Unrelated topic text' }, { remove: async () => { removed = true; } });
	assert.equal(removed, true);
});

test('actual Telegram payloads create topics and scoped index posts while original study posts stay in General', async (t) => {
	const { db, clock, advance } = fixture(t);
	const calls = [];
	let id = 20000;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		const endpoint = url.split('/').at(-1), payload = JSON.parse(options.body);
		calls.push({ endpoint, ...payload });
		return { json: async () => endpoint === 'editMessageText' ? ({ ok: false, error_code: 400, description: 'message is not modified' })
			: ({ ok: true, result: endpoint === 'createForumTopic' ? { message_thread_id: ++id } : { message_id: ++id } }) };
	});
	for (let n = 0; n < 20 && telegramIndexStatus(db).active; n++) { await processTelegramTopicIndex(db, undefined, clock); advance(3); }
	assert.equal(telegramIndexStatus(db).synced, 3);
	assert.equal(calls.filter((call) => call.endpoint === 'createForumTopic').length, 2);
	assert.ok(calls.filter((call) => call.endpoint === 'sendMessage').every((call) => call.message_thread_id > 0 && call.parse_mode === 'HTML'));
	queueTelegramIndexRebuild(db);
	await processTelegramTopicIndex(db, undefined, clock);
	assert.ok(calls.some((call) => call.endpoint === 'editMessageText'));
	await sendStudyMessage(getStudyDetail(db, 1));
	assert.equal(calls.at(-1).message_thread_id, undefined);
	assert.match(calls.at(-1).text, /SYNTHETIC-1/);
});

test('index API authorizes admins only, reports safe status and refuses rebuild when Telegram is not configured', async (t) => {
	const { db, drain } = fixture(t);
	const key = `indexDb_${randomUUID()}`;
	t.after(() => delete globalThis[key]);
	const source = readFileSync(new URL('../src/routes/api/telegram/study-indexes/+server.js', import.meta.url), 'utf8')
		.replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
			const resolved = specifier === '$lib/server/db'
				? `data:text/javascript,${encodeURIComponent(`export function getDb(){if(!globalThis[${JSON.stringify(key)}])throw Error('Unauthorized database access');return globalThis[${JSON.stringify(key)}]}`)}`
				: specifier.startsWith('$lib/') ? new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href : import.meta.resolve(specifier);
			return `from ${JSON.stringify(resolved)}`;
		});
	const { GET, POST } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
	for (const handler of [GET, POST]) {
		assert.equal(handler({ locals: {} }).status, 401);
		for (const role of ['resident', 'attending', 'typist']) assert.equal(handler({ locals: { user: { role } } }).status, 403);
	}
	globalThis[key] = db;
	const event = { locals: { user: { role: 'admin' } } };
	assert.equal((await POST(event).json()).already_running, true);
	await drain();
	const status = await GET(event).json();
	assert.equal(status.synced, 3);
	assert.doesNotMatch(JSON.stringify(status), /SYNTHETIC|Patient|synthetic-index-token/);
	assert.equal((await POST(event).json()).already_running, false);
	delete process.env.TELEGRAM_BOT_TOKEN;
	assert.equal(POST(event).status, 503);
	assert.equal(await processTelegramTopicIndex(db), false);
	assert.equal((await GET(event).json()).configured, false);
});
