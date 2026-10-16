import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { deleteStudy } from '../src/lib/server/study-deletion.js';
import { getStudyDetail } from '../src/lib/server/studies.js';
import { appendRecording, configureRecording, signRecording } from '../src/lib/server/recordings.js';
import { processRecording, saveRecordingReport } from '../src/lib/server/recording-processing.js';
import { queueVoiceReply, processVoiceJob } from '../src/lib/server/voice-worker.js';
import { processStudyNotification } from '../src/lib/server/study-notifications.js';
import { buildStudyMessage, deleteMessage, editStudyMessage } from '../src/lib/server/telegram.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const user = { id: 2, role: 'resident' };
const message = (id, parent = 42) => ({ from: { id: 200 }, chat: { id: -100 }, message_id: id, reply_to_message: { message_id: parent }, voice: { file_id: `synthetic-${id}` } });
const noEdit = async () => assert.fail('Unexpected Telegram edit');

function fixture(t, source = schema) {
	const db = new Database(':memory:'); db.exec(source);
	const directory = mkdtempSync(join(tmpdir(), 'study-delete-'));
	t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
	db.exec(`INSERT INTO users(id,full_name,role,telegram_user_id) VALUES(2,'Synthetic Resident','resident','200'),(3,'Synthetic Attending','attending','300');
		INSERT INTO telegram_registrations(telegram_user_id,full_name,role,username,step,user_id) SELECT telegram_user_id,full_name,role,'synthetic-'||id,'approved',id FROM users;
		INSERT INTO modalities VALUES(1,'MR','MRI'); INSERT INTO exam_types VALUES(1,'BRAIN','Brain'); INSERT INTO report_templates(modality_id,exam_type_id,text) VALUES(1,1,'Normal structures.');
		INSERT INTO studies(id,patient_code,patient_firstname,exam_date_jalali,exam_time,corresponding_attending_id,telegram_message_id) VALUES(1,'SYNTHETIC','Patient','1405-07-24','10:00:00',3,'42');`);
	const audio = join(directory, 'voice.ogg'), report = join(directory, 'old.txt');
	writeFileSync(audio, 'Synthetic voice'); writeFileSync(report, 'Original report.');
	db.prepare(`INSERT INTO study_recordings(id,study_id,modality_id,exam_type_id,corresponding_resident_id,audio_report_path,text_report_path) VALUES(1,1,1,1,2,?,?)`).run(audio, report);
	return { db, directory, audio, report };
}

function voices(db) { queueVoiceReply(db, message(43), 0); queueVoiceReply(db, message(44, 43), 0); }
const confirm = count => ({ confirm_voices: true, telegram_voice_count: count });

async function loadModule(relativePath, key) {
	const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8').replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
		const resolved = specifier === '$lib/server/db'
			? `data:text/javascript,${encodeURIComponent(`export function getDb(){return globalThis[${JSON.stringify(key)}]}`)}`
			: specifier.startsWith('$lib/') ? new URL(`../src/lib/${specifier.slice(5)}.js`.replace(/\.js\.js$/, '.js'), import.meta.url).href
				: specifier.startsWith('.') ? new URL(specifier, new URL(relativePath, import.meta.url)).href : import.meta.resolve(specifier);
		return `from ${JSON.stringify(resolved)}`;
	});
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function telegramMock(t, callback) {
	for (const [key, value] of [['TELEGRAM_BOT_TOKEN', 'synthetic-test-token'], ['TELEGRAM_CHAT_ID', '-100']]) {
		const before = process.env[key]; process.env[key] = value;
		t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
	}
	t.mock.method(globalThis, 'fetch', async (url, options) => callback(String(url).split('/').at(-1), JSON.parse(options.body)));
}

test('migration preserves existing studies and voice mappings, defaults active and is idempotent', t => {
	const oldSchema = schema.replace(/,\r?\n {4}disabled INTEGER[^\n]*\r?\n {4}telegram_send_started_at INTEGER/, '')
		.replace(/CREATE TABLE IF NOT EXISTS study_telegram_voices \([\s\S]*?CREATE INDEX IF NOT EXISTS idx_study_telegram_voices[^;]*;/, '');
	const { db } = fixture(t, oldSchema);
	db.exec("INSERT INTO pending_voice(study_id,chat_id,reply_message_id,file_id,process_at,done) VALUES(1,'-100',43,'synthetic',0,1)");
	initializeSchema(db, schema); initializeSchema(db, schema);
	assert.equal(getStudyDetail(db, 1).disabled, 0);
	assert.equal(getStudyDetail(db, 1).telegram_voice_count, 1);
	db.exec('UPDATE studies SET disabled=1; UPDATE study_telegram_voices SET deleted=1');
	initializeSchema(db, schema);
	assert.equal(getStudyDetail(db, 1).disabled, 1);
	assert.equal(getStudyDetail(db, 1).telegram_voice_count, 0);
	assert.equal(db.prepare('SELECT count(*) AS n FROM study_recordings').get().n, 1);
	assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('deleting a study without Telegram messages requires no external call', async t => {
	const { db } = fixture(t); db.exec('UPDATE studies SET telegram_message_id=NULL');
	assert.equal((await deleteStudy(db, 1, {}, async () => assert.fail('No Telegram message'), noEdit)).disabled, false);
	assert.equal(getStudyDetail(db, 1), undefined);
	assert.equal(db.prepare('SELECT count(*) AS n FROM study_recordings').get().n, 0);
});

test('all linked voices including reply chains and previously removed recordings are confirmed and deleted before the study message', async t => {
	const { db } = fixture(t); voices(db);
	db.exec('UPDATE pending_voice SET recording_id=1; DELETE FROM study_recordings WHERE id=1');
	assert.equal(getStudyDetail(db, 1).telegram_voice_count, 2);
	const calls = [];
	const result = await deleteStudy(db, 1, confirm(2), async (...args) => calls.push(args), noEdit);
	assert.deepEqual(calls, [[44, '-100'], [43, '-100'], ['42']]);
	assert.equal(result.disabled, false);
	for (const table of ['studies', 'pending_voice', 'study_telegram_voices']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
	assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('missing or stale voice confirmation and processing recordings cause no deletion or state changes', async t => {
	const { db } = fixture(t); voices(db);
	for (const confirmation of [{}, { confirm_voices: false, telegram_voice_count: 2 }, confirm(1)]) {
		await assert.rejects(deleteStudy(db, 1, confirmation, async () => assert.fail('Unconfirmed'), noEdit), /2 linked Telegram/);
	}
	assert.equal(getStudyDetail(db, 1).disabled, 0);
	assert.equal(db.prepare('SELECT sum(done) AS n FROM pending_voice').get().n, 0);
	db.exec('UPDATE study_recordings SET processing=1');
	await assert.rejects(deleteStudy(db, 1, confirm(2)), /being processed/);
	assert.equal(getStudyDetail(db, 1).disabled, 0);
	await assert.rejects(deleteStudy(db, 999), error => error.status === 404);
});

test('Telegram deletion failure retains reports and signatures as disabled, marks the original message and blocks new replies and changes', async t => {
	const { db, directory, report } = fixture(t); voices(db);
	db.exec('UPDATE study_recordings SET resident_checked=1,attending_checked=1,typist_checked=1; INSERT INTO pending_telegram(study_id) VALUES(1)');
	const before = db.prepare('SELECT * FROM study_recordings').get(), edits = [], calls = [];
	const result = await deleteStudy(db, 1, confirm(2), async id => { calls.push(id); throw new Error('Too old'); }, async study => edits.push(buildStudyMessage(study)));
	assert.equal(result.disabled, true);
	assert.deepEqual(calls, [44, 43]);
	assert.match(edits[0], /DISABLED.*replies are not processed<\/b>\n<s>[\s\S]*<\/s>$/);
	assert.doesNotMatch(edits[0], /Original report/);
	assert.deepEqual(db.prepare('SELECT * FROM study_recordings').get(), before);
	assert.equal(readFileSync(report, 'utf8'), 'Original report.');
	assert.equal(db.prepare('SELECT sum(done) AS n FROM pending_voice').get().n, 2);
	assert.equal(db.prepare('SELECT count(*) AS n FROM pending_telegram').get().n, 0);
	for (const parent of [42, 43, 44]) assert.throws(() => queueVoiceReply(db, message(99, parent), 0), /disabled/);
	assert.throws(() => appendRecording(db, 1, 'unused'), /disabled/);
	assert.throws(() => configureRecording(db, 1, 1, {}), /disabled/);
	assert.throws(() => signRecording(db, 1, 1, user, 'resident', false), /disabled/);
	assert.throws(() => saveRecordingReport(db, 1, 'Replacement', directory), /disabled/);
	await assert.rejects(processRecording(db, 1, 1, async () => assert.fail('No AI'), directory), /disabled/);
	assert.equal(db.prepare('SELECT count(*) AS n FROM pending_voice').get().n, 2);
});

test('partial deletion records progress, preserves disabled state across migrations and retries only remaining voices', async t => {
	const { db } = fixture(t); voices(db);
	const result = await deleteStudy(db, 1, confirm(2), async id => { if (id === 43) throw new Error('Missing permission'); }, async () => {});
	assert.equal(result.disabled, true);
	initializeSchema(db, schema);
	assert.equal(getStudyDetail(db, 1).telegram_voice_count, 1);
	assert.equal(getStudyDetail(db, 1).disabled, 1);
	const calls = [];
	assert.equal((await deleteStudy(db, 1, confirm(1), async id => calls.push(id), noEdit)).disabled, false);
	assert.deepEqual(calls, [43, '42']);
	assert.equal(getStudyDetail(db, 1), undefined);
});

test('study message deletion or edit failure is explicit and never loses the website study; retry needs no voice confirmation once voices are gone', async t => {
	const { db } = fixture(t); voices(db);
	const calls = [];
	const result = await deleteStudy(db, 1, confirm(2), async id => { calls.push(id); if (id === '42') throw new Error('Expired'); }, async () => { throw new Error('No edit permission'); });
	assert.equal(result.disabled, true); assert.match(result.notification_warning, /may still look active/);
	assert.deepEqual(calls, [44, 43, '42']);
	assert.equal(getStudyDetail(db, 1).telegram_voice_count, 0);
	const retry = [];
	await deleteStudy(db, 1, {}, async id => retry.push(id), noEdit);
	assert.deepEqual(retry, ['42']);
});

test('concurrent deletion is rejected and the study is disabled before the first network request', async t => {
	const { db } = fixture(t);
	let release;
	const pending = deleteStudy(db, 1, {}, async () => new Promise(resolve => { release = resolve; }), noEdit);
	assert.equal(getStudyDetail(db, 1).disabled, 1);
	assert.throws(() => queueVoiceReply(db, message(43), 0), /disabled/);
	await assert.rejects(deleteStudy(db, 1), /already in progress/);
	release(); await pending;
});

test('in-flight voice downloads cannot attach audio or recreate a study after deletion or disabling', async t => {
	for (const disable of [false, true]) await t.test(disable ? 'disabled fallback' : 'deleted', async t => {
		const { db, directory } = fixture(t); queueVoiceReply(db, message(43), 0);
		let saved;
		await processVoiceJob(db, async (_, destination) => {
			await deleteStudy(db, 1, confirm(1), async () => { if (disable) throw new Error('Too old'); }, async () => {});
			saved = destination; writeFileSync(saved, 'Late voice'); return saved;
		}, async () => assert.fail('No notification'), directory, 0, async () => {});
		assert.equal(existsSync(saved), false);
		assert.equal(db.prepare('SELECT count(*) AS n FROM study_recordings').get().n, disable ? 1 : 0);
		if (disable) assert.equal(getStudyDetail(db, 1).disabled, 1);
	});
});

test('disabled studies never send queued Telegram notifications, and an in-flight notification must finish before deletion', async t => {
	const { db } = fixture(t); db.exec('UPDATE studies SET telegram_message_id=NULL; INSERT INTO pending_telegram(study_id) VALUES(1)');
	let release;
	const pending = processStudyNotification(db, async () => new Promise(resolve => { release = resolve; }), 0);
	await assert.rejects(deleteStudy(db, 1), /notification is being processed/);
	assert.equal(getStudyDetail(db, 1).disabled, 0);
	release({ message_id: 42 }); await pending;
	assert.equal(getStudyDetail(db, 1).telegram_message_id, '42');
	assert.equal(getStudyDetail(db, 1).telegram_send_started_at, null);
	db.exec('UPDATE studies SET disabled=1,telegram_message_id=NULL; INSERT INTO pending_telegram(study_id) VALUES(1)');
	await processStudyNotification(db, async () => assert.fail('No disabled notification'), 0);
	assert.equal(db.prepare('SELECT count(*) AS n FROM pending_telegram').get().n, 0);
});

test('study deletion API enforces authentication and confirmation and returns disabled fallback; disabled APIs reject edits', async t => {
	const { db, report } = fixture(t); voices(db);
	const key = `deletion_${randomUUID()}`; globalThis[key] = db; t.after(() => { delete globalThis[key]; });
	const route = await loadModule('../src/routes/api/studies/[id]/+server.js', key);
	const event = (body = {}, role = 'resident') => ({ locals: { user: role ? { id: 2, role } : null }, params: { id: '1' }, request: { json: async () => body } });
	assert.equal((await route.DELETE(event({}, null))).status, 401);
	assert.equal((await route.DELETE(event({}, 'typist'))).status, 403);
	assert.equal((await route.DELETE(event())).status, 409);
	telegramMock(t, async endpoint => ({ json: async () => endpoint === 'deleteMessage' ? { ok: false, error_code: 400, description: "message can't be deleted" } : { ok: true, result: true } }));
	const response = await route.DELETE(event(confirm(2)));
	assert.equal(response.status, 200); assert.equal((await response.json()).disabled, true);
	assert.equal((await route.PATCH(event({ description: 'Unwanted change' }))).status, 409);
	const attention = await loadModule('../src/routes/api/studies/[id]/attention/+server.js', key);
	assert.equal((await attention.PATCH(event({ needs_attention: true, attention_note: 'Unwanted' }))).status, 409);
	const recordings = await loadModule('../src/lib/server/recording-http.js', key);
	const recordEvent = { ...event({ role: 'resident', checked: true }), params: { id: '1', recordingId: '1' } };
	for (const action of ['configure', 'remove', 'writeReport', 'sign', 'generate']) assert.equal((await recordings[action](recordEvent)).status, 409, action);
	const preview = await recordings.readReport(recordEvent);
	assert.equal(preview.status, 200); assert.equal((await preview.json()).text, readFileSync(report, 'utf8'));
});

test('Telegram deletion is idempotent only for missing messages, not age or permission failures; repeated disabled edits succeed', async t => {
	let description = 'message to delete not found';
	telegramMock(t, async () => ({ json: async () => ({ ok: false, error_code: 400, description }) }));
	assert.equal(await deleteMessage(42), true);
	for (description of ["message can't be deleted", 'not enough rights']) await assert.rejects(deleteMessage(42));
	description = 'message is not modified';
	assert.equal(await editStudyMessage({ telegram_message_id: 42, disabled: 1 }), true);
});
