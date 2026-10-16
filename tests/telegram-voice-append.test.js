import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { getRecording, configureRecording, appendRecording, appendRecordingAudio } from '../src/lib/server/recordings.js';
import { processRecording, saveRecordingReport } from '../src/lib/server/recording-processing.js';
import { queueVoiceReply, processVoiceJob } from '../src/lib/server/voice-worker.js';
import { buildStudyMessage } from '../src/lib/server/telegram.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const resident = { id: 2, role: 'resident' };
const message = (id, replyId = 42, sender = 200) => ({ from: { id: sender }, chat: { id: -100 }, message_id: id, reply_to_message: { message_id: replyId }, voice: { file_id: `file-${id}` } });

function fixture(t, source = schema) {
	const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(source);
	const directory = mkdtempSync(join(tmpdir(), 'voice-append-'));
	t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
	db.exec(`INSERT INTO users(id,full_name,role,telegram_user_id) VALUES(2,'Resident','resident','200'),(3,'Attending','attending','300'),(4,'Other resident','resident','400'),(5,'Other attending','attending','500');
		INSERT INTO telegram_registrations(telegram_user_id,full_name,role,username,step,user_id) SELECT telegram_user_id,full_name,role,'synthetic-'||id,'approved',id FROM users;
		INSERT INTO modalities VALUES(1,'MR','MRI'); INSERT INTO exam_types VALUES(1,'BRAIN','Brain'); INSERT INTO report_templates(modality_id,exam_type_id,text) VALUES(1,1,'Normal structures.');
		INSERT INTO studies(id,patient_code,patient_firstname,exam_date_jalali,exam_time,corresponding_attending_id,telegram_message_id) VALUES(1,'SYNTHETIC','Patient','1405-07-24','10:00:00',3,'42');`);
	const downloads = [], notices = [], rejections = [];
	const download = async (file, path) => { downloads.push(path); writeFileSync(path, file); return path; };
	const work = (now = 0, customDownload = download) => processVoiceJob(db, customDownload, async study => notices.push(study), directory, now, async (...args) => rejections.push(args));
	return { db, directory, downloads, notices, rejections, download, work };
}

async function rootVoice(context, sender = 200) {
	assert.equal(queueVoiceReply(context.db, message(43, 42, sender), 0), true);
	await context.work();
	return context.db.prepare('SELECT id FROM study_recordings').get().id;
}

test('voice-to-voice replies and reply chains append in order; direct study replies remain separate and retries are idempotent', async t => {
	const c = fixture(t);
	for (const msg of [message(43), message(44, 43), message(45, 44), message(46)]) assert.equal(queueVoiceReply(c.db, msg, 0), true);
	assert.equal(queueVoiceReply(c.db, message(44, 43), 0), true);
	assert.equal(c.db.prepare('SELECT count(*) AS n FROM pending_voice').get().n, 4);
	for (let i = 0; i < 4; i++) await c.work();
	const rows = c.db.prepare('SELECT id FROM study_recordings ORDER BY id').all();
	assert.equal(rows.length, 2);
	const combined = getRecording(c.db, 1, rows[0].id);
	assert.deepEqual(combined.audio_parts.map(part => readFileSync(part.audio_report_path, 'utf8')), ['file-43', 'file-44', 'file-45']);
	assert.equal(combined.text_report_path, null);
	assert.equal(combined.corresponding_resident_id, 2);
	assert.equal(combined.sender_user_id, 2);
	assert.equal(getRecording(c.db, 1, rows[1].id).audio_parts.length, 1);
	assert.match(buildStudyMessage(c.notices.at(-1)), /3 voice parts/);
	c.db.exec('UPDATE pending_voice SET done=0 WHERE reply_message_id IN (43,44)');
	await c.work(); await c.work();
	assert.equal(c.downloads.length, 4);
	assert.equal(getRecording(c.db, 1, rows[0].id).audio_parts.length, 3);
	assert.equal(queueVoiceReply(c.db, { ...message(99, 43), chat: { id: -999 } }, 0), false);
});

test('appending preserves the existing report and only manual generation transcribes all parts into one report', async t => {
	const c = fixture(t); const id = await rootVoice(c);
	configureRecording(c.db, 1, id, { modality_id: 1, exam_type_id: 1 });
	const original = saveRecordingReport(c.db, id, 'Original saved report.', c.directory);
	const calls = [];
	const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'synthetic-test-key';
	t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls.push(url);
		if (url.endsWith('/audio/transcriptions')) {
			const voice = await options.body.get('file').text();
			return { ok: true, json: async () => ({ text: voice === 'file-43' ? 'Original dictation.' : 'Additional dictation.' }) };
		}
		assert.equal(url, 'https://api.openai.com/v1/responses');
		assert.match(JSON.parse(options.body).input, /Doctor's dictation:\n"Original dictation\.\nAdditional dictation\."/);
		return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Combined report.' }] }] }) };
	});
	queueVoiceReply(c.db, message(44, 43), 0); await c.work();
	assert.equal(calls.length, 0);
	assert.equal(getRecording(c.db, 1, id).text_report_path, original);
	assert.equal(readFileSync(original, 'utf8'), 'Original saved report.');
	const result = await processRecording(c.db, 1, id, undefined, c.directory);
	assert.equal(result.text, 'Combined report.');
	assert.equal(calls.length, 3);
	assert.equal(c.db.prepare('SELECT count(*) AS n FROM study_recordings').get().n, 1);
});

test('failed or missing later voice parts never replace the previous report', async t => {
	const c = fixture(t); const id = await rootVoice(c);
	configureRecording(c.db, 1, id, { modality_id: 1, exam_type_id: 1 });
	const original = saveRecordingReport(c.db, id, 'Keep this report.', c.directory);
	queueVoiceReply(c.db, message(44, 43), 0); await c.work();
	const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'synthetic-test-key';
	t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async url => {
		assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions'); calls++;
		return calls === 1 ? { ok: true, json: async () => ({ text: 'First part.' }) } : { ok: false, status: 503, text: async () => 'Synthetic failure' };
	});
	await assert.rejects(processRecording(c.db, 1, id, undefined, c.directory), /transcription failed/);
	assert.equal(getRecording(c.db, 1, id).text_report_path, original);
	assert.equal(readFileSync(original, 'utf8'), 'Keep this report.');
	assert.equal(getRecording(c.db, 1, id).processing, 0);
	rmSync(getRecording(c.db, 1, id).audio_parts[1].audio_report_path);
	await assert.rejects(processRecording(c.db, 1, id, undefined, c.directory), /Audio file not found/);
	assert.equal(calls, 2);
	assert.equal(getRecording(c.db, 1, id).text_report_path, original);
});

test('only sender, assigned resident or study attending may append, and signed or processing recordings are blocked', async t => {
	const c = fixture(t); const id = await rootVoice(c, 300);
	configureRecording(c.db, 1, id, { corresponding_resident_id: 2 });
	assert.equal(queueVoiceReply(c.db, message(44, 43, 200), 0), true);
	assert.equal(queueVoiceReply(c.db, message(45, 43, 300), 0), true);
	for (const sender of [400, 500]) assert.throws(() => queueVoiceReply(c.db, message(46, 43, sender), 0), { status: 403 });
	for (const field of ['resident_checked', 'attending_checked', 'typist_checked']) {
		c.db.exec(`UPDATE study_recordings SET ${field}=1 WHERE id=${id}`);
		assert.throws(() => queueVoiceReply(c.db, message(47, 43), 0), /Unsign/);
		c.db.exec(`UPDATE study_recordings SET ${field}=0 WHERE id=${id}`);
	}
	c.db.prepare('UPDATE study_recordings SET processing=1,processing_started_at=? WHERE id=?').run(Math.floor(Date.now()/1000), id);
	assert.throws(() => queueVoiceReply(c.db, message(48, 43), 0), /being processed/);
	assert.equal(c.db.prepare('SELECT count(*) AS n FROM pending_voice').get().n, 3);
});

test('queued replies wait for parent downloads and failed attachment downloads retry safely', async t => {
	const c = fixture(t);
	queueVoiceReply(c.db, message(43), 0); queueVoiceReply(c.db, message(44, 43), 0);
	await c.work(0, async () => { throw new Error('Synthetic download failure'); });
	await c.work(0);
	assert.equal(c.downloads.length, 0);
	assert.ok(c.db.prepare('SELECT process_at FROM pending_voice').all().every(job => job.process_at === 30));
	await c.work(30);
	await c.work(30, async () => { throw new Error('Synthetic attachment failure'); });
	assert.equal(c.db.prepare('SELECT count(*) AS n FROM recording_audio_parts').get().n, 0);
	await c.work(60);
	assert.equal(c.db.prepare('SELECT count(*) AS n FROM recording_audio_parts').get().n, 1);
	assert.equal(c.db.prepare('SELECT count(*) AS n FROM study_recordings').get().n, 1);
});

test('worker rechecks signatures and permissions after download and removes rejected attachment files', async t => {
	for (const change of ['sign', 'revoke', 'reassign', 'delete']) {
		await t.test(change, async t => {
			const c = fixture(t); const id = await rootVoice(c);
			const sender = change === 'reassign' ? 300 : 200;
			queueVoiceReply(c.db, message(44, 43, sender), 0);
			let rejectedPath;
			await c.work(0, async (file, path) => {
				rejectedPath = await c.download(file, path);
				if (change === 'sign') c.db.prepare('UPDATE study_recordings SET resident_checked=1 WHERE id=?').run(id);
				if (change === 'revoke') c.db.exec("UPDATE telegram_registrations SET step='rejected' WHERE user_id=2");
				if (change === 'reassign') c.db.exec('UPDATE studies SET corresponding_attending_id=5 WHERE id=1');
				if (change === 'delete') c.db.prepare('DELETE FROM study_recordings WHERE id=?').run(id);
				return path;
			});
			assert.equal(existsSync(rejectedPath), false);
			assert.equal(c.db.prepare('SELECT count(*) AS n FROM recording_audio_parts').get().n, 0);
			assert.equal(c.rejections.length, 1);
			assert.deepEqual(c.db.pragma('foreign_key_check'), []);
		});
	}
});

test('existing Telegram voice mappings survive idempotent migration and appended parts cascade on recording deletion', async t => {
	const oldSchema = schema.replace(/CREATE TABLE IF NOT EXISTS recording_audio_parts \([\s\S]*?CREATE INDEX IF NOT EXISTS idx_audio_parts_recording[^;]*;/, '')
		.replace(/^ {2}(parent_voice_job_id|recording_id) INTEGER REFERENCES .*\r?\n/gm, '');
	const c = fixture(t, oldSchema);
	const original = join(c.directory, 'original.ogg'); writeFileSync(original, 'original');
	c.db.exec("INSERT INTO pending_voice(id,study_id,chat_id,reply_message_id,file_id,process_at,done,sender_user_id,sender_role) VALUES(1,1,'-100',43,'legacy',0,1,2,'resident')");
	c.db.prepare("INSERT INTO study_recordings(id,study_id,audio_report_path,telegram_voice_job_id,sender_user_id,sender_role,source,corresponding_resident_id) VALUES(1,1,?,1,2,'resident','telegram',2)").run(original);
	initializeSchema(c.db, schema); initializeSchema(c.db, schema);
	queueVoiceReply(c.db, message(44, 43), 0); await c.work();
	assert.equal(getRecording(c.db, 1, 1).audio_parts.length, 2);
	c.db.exec('DELETE FROM study_recordings WHERE id=1');
	assert.equal(c.db.prepare('SELECT count(*) AS n FROM recording_audio_parts').get().n, 0);
	assert.deepEqual(c.db.pragma('foreign_key_check'), []);
});

async function loadHttp(db, t) {
	const key = `voiceAppendHttp_${randomUUID()}`; globalThis[key] = db; t.after(() => { delete globalThis[key]; });
	const url = new URL('../src/lib/server/recording-http.js', import.meta.url);
	const source = readFileSync(url, 'utf8').replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
		const resolved = specifier === '$lib/server/db' ? `data:text/javascript,${encodeURIComponent(`export function getDb(){return globalThis[${JSON.stringify(key)}]}`)}`
			: specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier);
		return `from ${JSON.stringify(resolved)}`;
	});
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('audio playback serves each owned part with ranges and never exposes another recording or arbitrary paths', async t => {
	const c = fixture(t); const id = await rootVoice(c); queueVoiceReply(c.db, message(44, 43), 0); await c.work();
	const other = appendRecording(c.db, 1, getRecording(c.db, 1, id).audio_report_path, { senderUserId: 2 });
	appendRecordingAudio(c.db, 1, other.id, getRecording(c.db, 1, id).audio_report_path, 999, resident);
	const { audio } = await loadHttp(c.db, t);
	const partId = getRecording(c.db, 1, id).audio_parts[1].id;
	const request = (part, range) => audio({ params: { id: '1', recordingId: String(id) }, locals: { user: { id: 3, role: 'typist' } }, request: new Request(`http://localhost/audio?part=${part}`, { headers: range ? { range } : {} }) });
	assert.equal(await (await request(0)).text(), 'file-43');
	assert.equal(await (await request(partId)).text(), 'file-44');
	const ranged = await request(partId, 'bytes=1-3');
	assert.equal(ranged.status, 206); assert.equal(await ranged.text(), 'ile');
	assert.equal((await request('../secret')).status, 404);
	assert.equal((await request(getRecording(c.db, 1, other.id).audio_parts[1].id)).status, 404);
});
