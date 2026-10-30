import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { configureRecording, getRecording } from '../src/lib/server/recordings.js';
import { saveRecordingReport } from '../src/lib/server/recording-processing.js';
import { getStudyDetail } from '../src/lib/server/studies.js';
import { deleteStudy } from '../src/lib/server/study-deletion.js';
import { queueVoiceReply, processVoiceJob } from '../src/lib/server/voice-worker.js';
import { handleTelegramGroupMessage } from '../src/lib/server/telegram-group.js';
import { requestTelegramVoiceDeletion, processTelegramVoiceDeletion } from '../src/lib/server/telegram-voice-deletion.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const chatId = '-100';
const voice = (id, parent = 42, sender = 200) => ({
	chat: { id: -100, type: 'supergroup' }, from: { id: sender, first_name: 'Synthetic' },
	message_id: id, reply_to_message: { message_id: parent }, voice: { file_id: `file-${id}` }
});
const command = (parent = 43, sender = 200, text = '/delete') => ({
	chat: { id: -100, type: 'supergroup' }, from: { id: sender }, message_id: 90,
	text, entities: [{ type: 'bot_command', offset: 0, length: text.length }],
	reply_to_message: { message_id: parent }
});

function environment(t, name, value) {
	const previous = process.env[name];
	if (value === undefined) delete process.env[name]; else process.env[name] = value;
	t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}

function fixture(t) {
	environment(t, 'TELEGRAM_CHAT_ID', chatId);
	const directory = mkdtempSync(join(process.cwd(), '.telegram-voice-deletion-'));
	const database = join(directory, 'test.sqlite');
	const c = { directory, database, db: new Database(database), downloads: [], notices: [], rejections: [] };
	t.after(() => { if (c.db.open) c.db.close(); rmSync(directory, { recursive: true, force: true }); });
	c.db.exec(schema);
	c.db.exec(`INSERT INTO users(id,full_name,role,telegram_user_id) VALUES
		(2,'Resident','resident','200'),(3,'Attending','attending','300'),
		(4,'Other resident','resident','400'),(5,'Typist','typist','500'),(6,'Admin','admin','600');
		INSERT INTO telegram_registrations(telegram_user_id,full_name,role,username,step,user_id)
		SELECT telegram_user_id,full_name,role,'synthetic-'||id,'approved',id FROM users WHERE role != 'admin';
		INSERT INTO modalities VALUES(1,'MR','MRI');
		INSERT INTO exam_types VALUES(1,'BRAIN','Brain'),(2,'SPINE','Spine');
		INSERT INTO studies(id,patient_code,patient_firstname,exam_date_jalali,exam_time,corresponding_attending_id,telegram_message_id)
		VALUES(1,'SYNTHETIC','Patient','1405-07-24','10:00:00',3,'42');`);
	c.download = async (file, path) => { c.downloads.push(path); writeFileSync(path, file); return path; };
	c.work = (download = c.download, now = 0) => processVoiceJob(c.db, download,
		async study => c.notices.push(study), directory, now, async (...args) => c.rejections.push(args));
	c.reopen = () => { c.db.close(); c.db = new Database(database); c.db.pragma('foreign_keys = ON'); };
	return c;
}

function queue(c, id, parent = 42, sender = 200) {
	assert.equal(queueVoiceReply(c.db, voice(id, parent, sender), 0), true);
	return c.db.prepare('SELECT * FROM pending_voice WHERE chat_id = ? AND reply_message_id = ?').get(chatId, id);
}

async function attach(c, id = 43, parent = 42, sender = 200) {
	queue(c, id, parent, sender);
	assert.equal(await c.work(), true);
	const job = c.db.prepare('SELECT * FROM pending_voice WHERE reply_message_id = ?').get(id);
	assert.ok(job.recording_id);
	return job.recording_id;
}

function tombstone(c, id = 43) {
	return c.db.prepare('SELECT * FROM telegram_voice_deletions WHERE chat_id = ? AND message_id = ?').get(chatId, id);
}

function snapshot(c) {
	return Object.fromEntries(['studies', 'study_recordings', 'recording_audio_parts', 'recording_examinations',
		'pending_voice', 'study_telegram_voices', 'telegram_voice_deletions'].map(table =>
		[table, c.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

function cleanup(c, options = {}) {
	return processTelegramVoiceDeletion(c.db, { now: 100, chatId,
		remove: async () => {}, refresh: async () => {}, ...options });
}

function expectBlockedReplay(c, message) {
	try { assert.equal(queueVoiceReply(c.db, message, 0), false); }
	catch (error) { assert.ok([400, 403, 404, 409].includes(error.status), error.stack); }
}

test('sole attached voice deletion removes its recording, clears files, refreshes and retains an idempotent tombstone', async t => {
	const c = fixture(t), id = await attach(c);
	const before = getRecording(c.db, 1, id);
	const report = saveRecordingReport(c.db, id, 'Synthetic generated report.', c.directory);
	const result = requestTelegramVoiceDeletion(c.db, command());
	assert.deepEqual(result, { studyId: 1 });
	assert.equal(result?.then, undefined);
	assert.equal(getRecording(c.db, 1, id), undefined);
	assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM study_telegram_voices').get().n, 0);
	assert.ok(existsSync(before.audio_report_path));
	assert.ok(existsSync(report));
	assert.equal(tombstone(c).audio_path, before.audio_report_path);
	assert.equal(tombstone(c).report_path, report);
	assert.equal(tombstone(c).sender_user_id, 2);
	assert.deepEqual(requestTelegramVoiceDeletion(c.db, command()), { studyId: 1 });
	const removals = [], refreshes = [];
	assert.equal(await cleanup(c, { messageId: 43, remove: async (...args) => removals.push(args),
		refresh: async (...args) => refreshes.push(args) }), true);
	assert.deepEqual(removals, [[43, chatId]]);
	assert.equal(refreshes.length, 1);
	assert.deepEqual(refreshes[0], [getStudyDetail(c.db, 1), chatId]);
	assert.equal(existsSync(before.audio_report_path), false);
	assert.equal(existsSync(report), false);
	assert.equal(tombstone(c).audio_path, null);
	assert.equal(tombstone(c).report_path, null);
	for (const stage of ['files_deleted', 'telegram_deleted', 'refreshed']) assert.equal(tombstone(c)[stage], 1);
	assert.deepEqual(requestTelegramVoiceDeletion(c.db, command()), { studyId: 1 });
	assert.equal(await cleanup(c, { messageId: 43, remove: async () => assert.fail('Repeated Telegram delete'),
		refresh: async () => assert.fail('Repeated refresh') }), true);
	assert.equal(await cleanup(c), false);
	assert.deepEqual(c.db.pragma('foreign_key_check'), []);
});

for (const selected of [43, 44]) {
	test(`deleting ${selected === 43 ? 'base' : 'appended'} part preserves sibling audio, routing and recording configuration`, async t => {
		const c = fixture(t), id = await attach(c);
		await attach(c, 44, 43, 300);
		await attach(c, 45, 44);
		configureRecording(c.db, 1, id, { modality_id: 1, examinations: [
			{ exam_type_id: 1, exam_details: 'With contrast' }, { exam_type_id: 2, exam_details: 'Lumbar' }
		] });
		const report = saveRecordingReport(c.db, id, 'Report for all three parts.', c.directory);
		const before = getRecording(c.db, 1, id);
		const exams = c.db.prepare('SELECT * FROM recording_examinations ORDER BY position').all();
		const paths = before.audio_parts.map(part => part.audio_report_path);
		const selectedIndex = selected - 43;
		assert.deepEqual(requestTelegramVoiceDeletion(c.db, command(selected, selected === 44 ? 300 : 200)), { studyId: 1 });
		const after = getRecording(c.db, 1, id);
		assert.deepEqual(after.audio_parts.map(part => part.audio_report_path), paths.filter((_, index) => index !== selectedIndex));
		assert.equal(after.text_report_path, null);
		if (selected === 43) assert.equal(after.audio_report_path, null);
		for (const field of ['id', 'study_id', 'modality_id', 'exam_type_id', 'exam_details', 'corresponding_resident_id',
			'sender_user_id', 'sender_role', 'source', 'created_at', 'telegram_voice_job_id']) assert.equal(after[field], before[field], field);
		assert.deepEqual(c.db.prepare('SELECT * FROM recording_examinations ORDER BY position').all(), exams);
		const stub = c.db.prepare('SELECT * FROM pending_voice WHERE reply_message_id = ?').get(selected);
		assert.equal(stub.done, 1);
		assert.equal(stub.file_id, '');
		assert.equal(stub.recording_id, id);
		assert.equal(c.db.prepare('SELECT message_id FROM study_telegram_voices WHERE message_id = ?').get(selected), undefined);
		const child = c.db.prepare('SELECT parent_message_id FROM study_telegram_voices WHERE message_id = ?').get(selected + 1);
		assert.equal(child.parent_message_id, selected === 43 ? null : 43);
		assert.equal(await cleanup(c), true);
		assert.equal(existsSync(report), false);
		assert.equal(existsSync(paths[selectedIndex]), false);
		for (const file of paths.filter((_, index) => index !== selectedIndex)) assert.ok(existsSync(file));
		assert.equal(getStudyDetail(c.db, 1).telegram_voice_count, 2);
		assert.deepEqual(c.db.pragma('foreign_key_check'), []);
	});
}

test('audio attachment deletion leaves an independent recording and its generated report untouched', async t => {
	const c = fixture(t), original = await attach(c);
	const originalReport = saveRecordingReport(c.db, original, 'Independent report.', c.directory);
	const originalAudio = getRecording(c.db, 1, original).audio_report_path;
	const message = voice(44);
	message.audio = message.voice; delete message.voice;
	assert.equal(queueVoiceReply(c.db, message, 0), true);
	await c.work();
	const selected = c.db.prepare('SELECT recording_id FROM pending_voice WHERE reply_message_id=44').get().recording_id;
	assert.notEqual(selected, original);
	const selectedAudio = getRecording(c.db, 1, selected).audio_report_path;
	assert.deepEqual(requestTelegramVoiceDeletion(c.db, command(44)), { studyId: 1 });
	assert.equal(await cleanup(c), true);
	assert.equal(getRecording(c.db, 1, selected), undefined);
	assert.equal(existsSync(selectedAudio), false);
	assert.equal(getRecording(c.db, 1, original).text_report_path, originalReport);
	assert.ok(existsSync(originalAudio)); assert.ok(existsSync(originalReport));
	assert.equal(getStudyDetail(c.db, 1).telegram_voice_count, 1);
});

test('ownership uses the selected pending job sender, not original recording sender or assigned attending', async t => {
	const c = fixture(t), id = await attach(c);
	await attach(c, 44, 43, 300);
	for (const [selected, sender] of [[43, 300], [43, 400], [44, 200], [44, 400]]) {
		const before = snapshot(c);
		assert.throws(() => requestTelegramVoiceDeletion(c.db, command(selected, sender)), { status: 403 });
		assert.deepEqual(snapshot(c), before);
	}
	assert.deepEqual(requestTelegramVoiceDeletion(c.db, command(44, 300)), { studyId: 1 });
	assert.equal(getRecording(c.db, 1, id).audio_parts.length, 1);
	assert.throws(() => requestTelegramVoiceDeletion(c.db, command(44, 200)), { status: 403 });
});

test('only approved non-bot, non-anonymous resident and attending accounts may delete', async t => {
	const c = fixture(t); await attach(c);
	const invalid = [command(43, 500), command(43, 600), command(43, 999),
		{ ...command(), from: { id: 200, is_bot: true } },
		{ ...command(), sender_chat: { id: -100, title: 'Anonymous' } },
		{ ...command(), from: undefined }];
	for (const message of invalid) {
		const before = snapshot(c);
		assert.throws(() => requestTelegramVoiceDeletion(c.db, message), { status: 403 });
		assert.deepEqual(snapshot(c), before);
	}
	c.db.exec("UPDATE telegram_registrations SET step='pending' WHERE user_id=2");
	const before = snapshot(c);
	assert.throws(() => requestTelegramVoiceDeletion(c.db, command()), { status: 403 });
	assert.deepEqual(snapshot(c), before);
});

for (const flag of ['resident_checked', 'attending_checked', 'typist_checked', 'processing', 'disabled']) {
	test(`${flag} protects both attached and queued parts without partial deletion`, async t => {
		const c = fixture(t), id = await attach(c);
		await attach(c, 44, 43);
		queue(c, 45, 44);
		const report = saveRecordingReport(c.db, id, 'Protected report.', c.directory);
		if (flag === 'disabled') c.db.exec('UPDATE studies SET disabled=1');
		else if (flag === 'processing') c.db.prepare('UPDATE study_recordings SET processing=1,processing_started_at=?').run(Math.floor(Date.now() / 1000));
		else c.db.exec(`UPDATE study_recordings SET ${flag}=1`);
		const before = snapshot(c);
		for (const selected of [43, 44, 45]) {
			assert.throws(() => requestTelegramVoiceDeletion(c.db, command(selected)), { status: 409 });
			assert.deepEqual(snapshot(c), before);
		}
		assert.ok(existsSync(report));
		assert.equal(getRecording(c.db, 1, id).audio_parts.length, 2);
	});
}

test('configured chat and same-chat reply validation reject missing, foreign and unknown targets', async t => {
	const c = fixture(t); await attach(c);
	const before = snapshot(c);
	const invalid = [
		[{ ...command(), chat: { id: -999 } }, 403],
		[{ ...command(), reply_to_message: undefined }, 400],
		[{ ...command(), reply_to_message: { message_id: 0 } }, 400],
		[{ ...command(), reply_to_message: { message_id: 43, chat: { id: -999 } } }, 400],
		[{ ...command(), external_reply: { message_id: 43, chat: { id: -999 } } }, 400],
		[{ ...command(), external_reply: { message_id: 43 } }, 400],
		[command(999), 404], [command(42), 404]
	];
	for (const [message, status] of invalid) {
		assert.throws(() => requestTelegramVoiceDeletion(c.db, message), { status });
		assert.deepEqual(snapshot(c), before);
	}
	environment(t, 'TELEGRAM_CHAT_ID', undefined);
	assert.throws(() => requestTelegramVoiceDeletion(c.db, command()), { status: 403 });
	assert.deepEqual(snapshot(c), before);
});

test('same-chat cross-topic external reply takes precedence over the topic starter', async t => {
	const c = fixture(t); await attach(c);
	const msg = { ...command(900), message_thread_id: 900, is_topic_message: true,
		external_reply: { chat: { id: -100 }, message_id: 43 } };
	assert.deepEqual(requestTelegramVoiceDeletion(c.db, msg), { studyId: 1 });
	assert.equal(tombstone(c).message_id, 43);
	assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM study_recordings').get().n, 0);
});

test('local mutation is atomic when deleting the selected voice log fails', async t => {
	const c = fixture(t), id = await attach(c); await attach(c, 44, 43);
	const report = saveRecordingReport(c.db, id, 'Keep on rollback.', c.directory);
	const before = snapshot(c);
	c.db.exec(`CREATE TRIGGER reject_voice_delete BEFORE DELETE ON study_telegram_voices
		BEGIN SELECT RAISE(ABORT, 'synthetic deletion failure'); END;`);
	assert.throws(() => requestTelegramVoiceDeletion(c.db, command(44)), /synthetic deletion failure/);
	assert.deepEqual(snapshot(c), before);
	assert.ok(existsSync(report));
	for (const part of getRecording(c.db, 1, id).audio_parts) assert.ok(existsSync(part.audio_report_path));
});

test('deleting an unprocessed sole voice prevents any download or audio replay after migration', async t => {
	const c = fixture(t); queue(c, 43);
	assert.deepEqual(requestTelegramVoiceDeletion(c.db, command()), { studyId: 1 });
	assert.equal(await c.work(), false);
	assert.equal(c.downloads.length, 0);
	assert.equal(await cleanup(c), true);
	c.reopen();
	initializeSchema(c.db, schema); initializeSchema(c.db, schema);
	expectBlockedReplay(c, voice(43));
	expectBlockedReplay(c, voice(44, 43));
	assert.equal(await c.work(), false);
	assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM study_recordings').get().n, 0);
	assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM study_telegram_voices').get().n, 0);
	assert.ok(tombstone(c));
});

test('unprocessed root deletion promotes earliest child, reparents siblings and preserves descendants', async t => {
	const c = fixture(t);
	queue(c, 43); const first = queue(c, 44, 43); queue(c, 45, 43); queue(c, 46, 44);
	assert.deepEqual(requestTelegramVoiceDeletion(c.db, command()), { studyId: 1 });
	const jobs = c.db.prepare('SELECT * FROM pending_voice WHERE reply_message_id != 43 ORDER BY id').all();
	assert.deepEqual(jobs.map(job => [job.reply_message_id, job.parent_voice_job_id]), [[44, null], [45, first.id], [46, first.id]]);
	for (let i = 0; i < 3; i++) assert.equal(await c.work(), true);
	assert.deepEqual(c.downloads.map(file => readFileSync(file, 'utf8')), ['file-44', 'file-45', 'file-46']);
	assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM study_recordings').get().n, 1);
	const recording = getStudyDetail(c.db, 1).recordings[0];
	assert.equal(recording.audio_parts.length, 3);
	assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM study_telegram_voices WHERE parent_message_id=43').get().n, 0);
	assert.deepEqual(c.db.pragma('foreign_key_check'), []);
});

test('unprocessed middle child deletion routes its descendants to its surviving parent', async t => {
	const c = fixture(t), root = queue(c, 43);
	queue(c, 44, 43); queue(c, 45, 44);
	requestTelegramVoiceDeletion(c.db, command(44));
	assert.equal(c.db.prepare('SELECT parent_voice_job_id FROM pending_voice WHERE reply_message_id=45').get().parent_voice_job_id, root.id);
	assert.equal(c.db.prepare('SELECT parent_message_id FROM study_telegram_voices WHERE message_id=45').get().parent_message_id, 43);
	await c.work(); await c.work();
	assert.deepEqual(c.downloads.map(file => readFileSync(file, 'utf8')), ['file-43', 'file-45']);
	assert.equal(getStudyDetail(c.db, 1).recordings[0].audio_parts.length, 2);
});

test('deleting queued appended audio preserves current report and never downloads the selected voice', async t => {
	const c = fixture(t), id = await attach(c);
	const report = saveRecordingReport(c.db, id, 'Still valid for existing audio.', c.directory);
	queue(c, 44, 43); queue(c, 45, 44);
	requestTelegramVoiceDeletion(c.db, command(44));
	assert.equal(getRecording(c.db, 1, id).text_report_path, report);
	assert.equal(tombstone(c, 44).audio_path, null);
	assert.equal(tombstone(c, 44).report_path, null);
	await cleanup(c); await c.work();
	assert.ok(existsSync(report));
	assert.equal(getRecording(c.db, 1, id).audio_parts.length, 2);
	assert.deepEqual(c.downloads.map(file => readFileSync(file, 'utf8')), ['file-43', 'file-45']);
});

test('last attached part retains recording and metadata while a queued descendant can still append', async t => {
	const c = fixture(t), id = await attach(c);
	configureRecording(c.db, 1, id, { modality_id: 1, exam_type_id: 1, exam_details: 'Preserve me' });
	queue(c, 44, 43);
	requestTelegramVoiceDeletion(c.db, command());
	assert.equal(getRecording(c.db, 1, id).audio_parts.length, 0);
	assert.equal(getRecording(c.db, 1, id).exam_details, 'Preserve me');
	await cleanup(c);
	assert.equal(await c.work(), true);
	const after = getRecording(c.db, 1, id);
	assert.equal(after.audio_parts.length, 1);
	assert.equal(after.modality_id, 1);
	assert.equal(after.corresponding_resident_id, 2);
	assert.equal(readFileSync(after.audio_parts[0].audio_report_path, 'utf8'), 'file-44');
	requestTelegramVoiceDeletion(c.db, command(44));
	assert.equal(getRecording(c.db, 1, id), undefined);
	assert.deepEqual(c.db.pragma('foreign_key_check'), []);
});

for (const appended of [false, true]) {
	test(`deletion during ${appended ? 'appended' : 'root'} download cannot resurrect audio or replace a report`, async t => {
		const c = fixture(t);
		const id = appended ? await attach(c) : null;
		const selected = appended ? 44 : 43;
		const report = appended ? saveRecordingReport(c.db, id, 'Existing report.', c.directory) : null;
		queue(c, selected, appended ? 43 : 42);
		let started, finish;
		const downloading = new Promise(resolve => { started = resolve; });
		const resume = new Promise(resolve => { finish = resolve; });
		let saved;
		const work = c.work(async (file, path) => { saved = path; started(); await resume; writeFileSync(path, file); return path; });
		await downloading;
		let worked;
		try {
			assert.deepEqual(requestTelegramVoiceDeletion(c.db, command(selected)), { studyId: 1 });
			assert.equal(await cleanup(c), true);
		} finally { finish(); worked = await work; }
		assert.equal(worked, true);
		assert.equal(existsSync(saved), false);
		assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM study_telegram_voices WHERE message_id=?').get(selected).n, 0);
		if (appended) {
			assert.equal(getRecording(c.db, 1, id).audio_parts.length, 1);
			assert.equal(getRecording(c.db, 1, id).text_report_path, report);
			assert.ok(existsSync(report));
		} else assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM study_recordings').get().n, 0);
		assert.equal(await c.work(), false);
		expectBlockedReplay(c, voice(selected, appended ? 43 : 42));
	});
}

test('deleted attached routing stub never restores logs or accepts replay/new replies, but surviving chain still works', async t => {
	const c = fixture(t), id = await attach(c);
	await attach(c, 44, 43); await attach(c, 45, 44);
	requestTelegramVoiceDeletion(c.db, command(44)); await cleanup(c);
	c.reopen(); initializeSchema(c.db, schema); initializeSchema(c.db, schema);
	expectBlockedReplay(c, voice(44, 43)); expectBlockedReplay(c, voice(46, 44));
	assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM study_telegram_voices WHERE message_id=44').get().n, 0);
	queue(c, 47, 45); await c.work();
	assert.equal(getRecording(c.db, 1, id).audio_parts.length, 3);
	assert.deepEqual(getRecording(c.db, 1, id).audio_parts.map(part => readFileSync(part.audio_report_path, 'utf8')), ['file-43', 'file-45', 'file-47']);
	assert.equal(tombstone(c, 44).audio_path, null);
});

test('Telegram failure persists cleanup and backoff across reopening, retries only unfinished stages', async t => {
	const c = fixture(t), id = await attach(c);
	const audio = getRecording(c.db, 1, id).audio_report_path;
	const report = saveRecordingReport(c.db, id, 'Delete durably.', c.directory);
	requestTelegramVoiceDeletion(c.db, command());
	let removes = 0, refreshes = 0;
	assert.equal(await cleanup(c, { now: 100, remove: async () => { removes++; throw new Error('Telegram unavailable'); },
		refresh: async (study, chat) => {
			refreshes++; assert.equal(study.id, 1); assert.equal(chat, chatId);
			assert.equal(study.telegram_replies.length, 0);
		} }), false);
	assert.equal(tombstone(c).retry_at, 130);
	assert.equal(tombstone(c).telegram_deleted, 0);
	assert.equal(tombstone(c).files_deleted, 1);
	assert.equal(tombstone(c).refreshed, 1);
	assert.equal(existsSync(audio), false); assert.equal(existsSync(report), false);
	const failed = tombstone(c);
	assert.deepEqual(requestTelegramVoiceDeletion(c.db, command()), { studyId: 1 });
	assert.deepEqual(tombstone(c), failed);
	c.reopen();
	const retry = { remove: async (...args) => { removes++; assert.deepEqual(args, [43, chatId]); },
		refresh: async () => assert.fail('Successful refresh must not be repeated') };
	assert.equal(await cleanup(c, { ...retry, now: 129 }), false);
	assert.equal(removes, 1); assert.equal(refreshes, 1);
	assert.equal(await cleanup(c, { ...retry, now: 130 }), true);
	assert.equal(removes, 2); assert.equal(refreshes, 1);
	assert.equal(tombstone(c).audio_path, null); assert.equal(tombstone(c).report_path, null);
	assert.equal(await cleanup(c, { ...retry, now: 200 }), false);
});

test('refresh failure retries refresh without repeating completed Telegram deletion or filesystem cleanup', async t => {
	const c = fixture(t); await attach(c); requestTelegramVoiceDeletion(c.db, command());
	let removes = 0;
	assert.equal(await cleanup(c, { now: 50, remove: async () => { removes++; },
		refresh: async () => { throw new Error('Refresh unavailable'); } }), false);
	assert.equal(tombstone(c).telegram_deleted, 1);
	assert.equal(tombstone(c).files_deleted, 1);
	assert.equal(tombstone(c).refreshed, 0);
	assert.equal(tombstone(c).retry_at, 80);
	c.reopen();
	assert.equal(await cleanup(c, { now: 80, remove: async () => assert.fail('Telegram already deleted'),
		refresh: async study => assert.equal(study.id, 1) }), true);
	assert.equal(removes, 1);
});

test('filesystem failure remains retryable and a missing file is treated as already cleaned', async t => {
	const c = fixture(t); await attach(c); requestTelegramVoiceDeletion(c.db, command());
	const blocked = tombstone(c).audio_path;
	rmSync(blocked); mkdirSync(blocked);
	assert.equal(await cleanup(c, { now: 10 }), false);
	assert.equal(tombstone(c).files_deleted, 0);
	assert.equal(tombstone(c).telegram_deleted, 1);
	assert.equal(tombstone(c).refreshed, 1);
	assert.equal(tombstone(c).retry_at, 40);
	rmSync(blocked, { recursive: true });
	assert.equal(await cleanup(c, { now: 40,
		remove: async () => assert.fail('Successful Telegram deletion must not be repeated'),
		refresh: async () => assert.fail('Successful refresh must not be repeated') }), true);
	assert.equal(tombstone(c).files_deleted, 1);
	assert.equal(tombstone(c).audio_path, null);
});

test('study deletion drains pending audio/report cleanup before cascading its replay tombstone', async t => {
	const c = fixture(t), id = await attach(c);
	const audio = getRecording(c.db, 1, id).audio_report_path;
	const report = saveRecordingReport(c.db, id, 'Pending study cleanup.', c.directory);
	requestTelegramVoiceDeletion(c.db, command());
	const calls = [];
	const result = await deleteStudy(c.db, 1, { confirm_voices: true, telegram_voice_count: 1 }, async (messageId, chat) => {
		calls.push(messageId);
		assert.equal(existsSync(audio), false); assert.equal(existsSync(report), false);
		assert.ok(tombstone(c));
		if (messageId === 43) assert.equal(chat, chatId);
		else {
			assert.equal(messageId, '42');
			assert.equal(tombstone(c).files_deleted, 1);
			assert.equal(tombstone(c).telegram_deleted, 1);
			assert.equal(tombstone(c).refreshed, 1);
		}
	}, async study => assert.equal(study.telegram_replies.length, 0));
	assert.equal(result.disabled, false);
	assert.deepEqual(calls, [43, '42']);
	assert.equal(getStudyDetail(c.db, 1), undefined);
	assert.equal(tombstone(c), undefined);
	assert.deepEqual(c.db.pragma('foreign_key_check'), []);
});

test('failed pending cleanup retains disabled study and tombstone until a later study deletion succeeds', async t => {
	const c = fixture(t); await attach(c); requestTelegramVoiceDeletion(c.db, command());
	const calls = [];
	const failed = await deleteStudy(c.db, 1, { confirm_voices: true, telegram_voice_count: 1 }, async messageId => {
		calls.push(messageId); throw new Error('Telegram unavailable');
	}, async study => assert.equal(study.telegram_replies.length, 0));
	assert.equal(failed.disabled, true);
	assert.deepEqual(calls, [43]);
	assert.equal(getStudyDetail(c.db, 1).disabled, 1);
	assert.equal(getStudyDetail(c.db, 1).telegram_voice_count, 1);
	assert.equal(tombstone(c).telegram_deleted, 0);
	assert.equal(tombstone(c).files_deleted, 1);
	assert.equal(tombstone(c).refreshed, 1);
	c.reopen(); initializeSchema(c.db, schema);
	assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM study_telegram_voices').get().n, 0);
	const retryTime = tombstone(c).retry_at * 1000;
	t.mock.method(Date, 'now', () => retryTime);
	const retried = await deleteStudy(c.db, 1, { confirm_voices: true, telegram_voice_count: 1 },
		async messageId => calls.push(messageId), async () => assert.fail('Already refreshed'));
	assert.equal(retried.disabled, false);
	assert.deepEqual(calls, [43, 43, '42']);
	assert.equal(getStudyDetail(c.db, 1), undefined);
	assert.equal(tombstone(c), undefined);
	assert.deepEqual(c.db.pragma('foreign_key_check'), []);
});

test('cleanup selectors never consume another chat or message and no ready job returns false', async t => {
	const c = fixture(t); queue(c, 43); queue(c, 44);
	requestTelegramVoiceDeletion(c.db, command()); requestTelegramVoiceDeletion(c.db, command(44));
	assert.equal(await cleanup(c, { chatId: '-999' }), false);
	assert.equal(await cleanup(c, { messageId: 999 }), false);
	const calls = [];
	assert.equal(await cleanup(c, { messageId: 44, remove: async id => calls.push(id) }), true);
	assert.deepEqual(calls, [44]);
	assert.equal(tombstone(c).telegram_deleted, 0);
	assert.equal(await cleanup(c, { messageId: 43 }), true);
	assert.equal(await cleanup(c), false);
});

for (const text of ['/delete', '/delete@SyntheticBot']) {
	test(`group handler executes ${text} with standard bot_command entity before moderating the command`, async t => {
		const c = fixture(t); await attach(c);
		const events = [];
		assert.equal(await handleTelegramGroupMessage(c.db, command(43, 200, text), {
			remove: async (id, chat) => { events.push(['remove', id]); assert.equal(String(chat), chatId); },
			refresh: async study => { events.push(['refresh', study.id]); assert.equal(study.recordings.length, 0); },
			notify: async (chat, body) => { events.push(['notify', body]); assert.equal(String(chat), chatId); }
		}), true);
		assert.ok(tombstone(c));
		assert.equal(tombstone(c).telegram_deleted, 1);
		assert.equal(tombstone(c).refreshed, 1);
		assert.deepEqual(events.filter(event => event[0] === 'remove'), [['remove', 43], ['remove', 90]]);
		assert.equal(events.filter(event => event[0] === 'notify').length, 1);
		assert.match(events.find(event => event[0] === 'notify')[1], /delet|remov/i);
		assert.equal(events.at(-1)[0], 'remove');
	});
}

test('handler reports ownership rejection and removes only the command', async t => {
	const c = fixture(t); await attach(c);
	const before = snapshot(c), removed = [], notices = [];
	await handleTelegramGroupMessage(c.db, command(43, 300), {
		remove: async id => removed.push(id), refresh: async () => assert.fail('Rejected deletion must not refresh'),
		notify: async (chat, text) => notices.push(text)
	});
	assert.deepEqual(snapshot(c), before);
	assert.deepEqual(removed, [90]);
	assert.equal(notices.length, 1);
	assert.match(notices[0], /own|cannot|only|not delet/i);
});

test('handler leaves durable retry after Telegram failure and still notifies and removes command', async t => {
	const c = fixture(t); await attach(c);
	const removed = [], notices = [];
	await handleTelegramGroupMessage(c.db, command(), {
		remove: async id => { removed.push(id); if (id === 43) throw new Error('Telegram unavailable'); },
		refresh: async () => {}, notify: async (chat, text) => notices.push(text)
	});
	assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM study_recordings').get().n, 0);
	assert.equal(tombstone(c).telegram_deleted, 0);
	assert.ok(tombstone(c).retry_at > 0);
	assert.deepEqual(removed, [43, 90]);
	assert.equal(notices.length, 1);
	assert.match(notices[0], /retry|pending|fail|could not|couldn.t|unavailable/i);
});

test('ordinary text, command prefixes, arguments and misplaced/non-command entities never execute deletion', async t => {
	const c = fixture(t); await attach(c);
	const before = snapshot(c);
	const invalid = [
		{ ...command(), entities: undefined },
		command(43, 200, '/deleteall'), command(43, 200, '/delete extra'),
		{ ...command(), text: 'please /delete', entities: [{ type: 'bot_command', offset: 7, length: 7 }] },
		{ ...command(), entities: [{ type: 'bold', offset: 0, length: 7 }] }
	];
	for (const message of invalid) {
		await handleTelegramGroupMessage(c.db, message, { remove: async () => {},
			refresh: async () => assert.fail('Not a deletion command'), notify: async () => assert.fail('Not a deletion command') });
		assert.deepEqual(snapshot(c), before);
	}
});

test('edited_message webhook updates never execute a delete command, original message updates do', async t => {
	const c = fixture(t); await attach(c);
	environment(t, 'TELEGRAM_BOT_TOKEN', 'synthetic-test-token');
	environment(t, 'TELEGRAM_WEBHOOK_SECRET', 'synthetic-webhook-secret');
	const key = `voiceDeletionDb_${randomUUID()}`;
	globalThis[key] = c.db;
	t.after(() => { delete globalThis[key]; });
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls.push({ endpoint: String(url).split('/').at(-1), ...JSON.parse(options.body) });
		return { ok: true, json: async () => ({ ok: true, result: {} }) };
	});
	const source = readFileSync(new URL('../src/routes/api/telegram/webhook/+server.js', import.meta.url), 'utf8')
		.replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
			const resolved = specifier === '$lib/server/db'
				? `data:text/javascript,${encodeURIComponent(`export function getDb(){return globalThis[${JSON.stringify(key)}]}`)}`
				: specifier.startsWith('$lib/') ? new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href
					: import.meta.resolve(specifier);
			return `from ${JSON.stringify(resolved)}`;
		});
	const { POST } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
	const invoke = update => POST({ request: new Request('http://localhost/api/telegram/webhook', {
		method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET },
		body: JSON.stringify(update)
	}) });
	const before = snapshot(c);
	assert.equal((await invoke({ edited_message: command() })).status, 200);
	assert.deepEqual(snapshot(c), before);
	assert.ok(calls.every(call => call.endpoint !== 'deleteMessage' || call.message_id !== 43));
	assert.equal((await invoke({ message: command() })).status, 200);
	assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM study_recordings').get().n, 0);
	assert.equal(tombstone(c).telegram_deleted, 1);
	assert.ok(calls.some(call => call.endpoint === 'deleteMessage' && call.message_id === 43));
});
