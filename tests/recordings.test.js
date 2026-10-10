import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { insertStudy, getStudyDetail } from '../src/lib/server/studies.js';
import {
	appendRecording,
	configureRecording,
	getRecording,
	signRecording
} from '../src/lib/server/recordings.js';
import { processRecording, saveRecordingReport } from '../src/lib/server/recording-processing.js';
import { queueVoiceReply, processVoiceJob } from '../src/lib/server/voice-worker.js';
import { buildStudyMessage, buildFinalReportMessage } from '../src/lib/server/telegram.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	initializeSchema(db, schema);
	db.exec(
		"INSERT INTO modalities VALUES(1,'MR','MRI'),(2,'CT','CT'); INSERT INTO exam_types VALUES(1,'BRAIN_WC','Brain with contrast'),(2,'KNEE_WO','Knee without contrast'); INSERT INTO users(id,full_name,role) VALUES(1,'Admin','admin'),(2,'Resident','resident'),(3,'Attending','attending'); INSERT INTO report_templates(modality_id,exam_type_id,text) VALUES(1,1,'Brain template'),(1,2,'Knee template');"
	);
	const directory = mkdtempSync(join(tmpdir(), 'radiology-recordings-'));
	const studyId = insertStudy(db, {
		patient_code: '001',
		patient_firstname: 'Synthetic',
		patient_lastname: 'Patient',
		patient_age: 8,
		patient_age_unit: 'M',
		exam_date_jalali: '1405-07-18',
		exam_time: '10:00',
		corresponding_resident_id: 2,
		corresponding_attending_id: 3
	});
	const audio = join(directory, 'audio.ogg');
	writeFileSync(audio, Buffer.from('synthetic audio fixture'));
	t.after(() => {
		db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return { db, directory, studyId, audio };
}
const admin = { id: 1, role: 'admin' },
	resident = { id: 2, role: 'resident' },
	attending = { id: 3, role: 'attending' };

const legacyStudies = `CREATE TABLE studies (
 id INTEGER PRIMARY KEY AUTOINCREMENT, patient_code TEXT NOT NULL,
 patient_firstname TEXT NOT NULL DEFAULT '', patient_lastname TEXT NOT NULL DEFAULT '',
 patient_gender TEXT NOT NULL DEFAULT 'unknown', patient_age INTEGER, patient_age_unit TEXT NOT NULL DEFAULT 'Y',
 source_study_uid TEXT, source_component TEXT, source_description TEXT,
 modality_id INTEGER NOT NULL REFERENCES modalities(id), exam_type_id INTEGER NOT NULL REFERENCES exam_types(id),
 exam_details TEXT, exam_date_jalali TEXT NOT NULL, exam_time TEXT NOT NULL,
 corresponding_resident_id INTEGER REFERENCES users(id), corresponding_attending_id INTEGER REFERENCES users(id),
 audio_report_path TEXT, text_report_path TEXT, resident_checked INTEGER NOT NULL DEFAULT 0, attending_checked INTEGER NOT NULL DEFAULT 0,
 dicom_url TEXT, description TEXT, telegram_message_id TEXT, UNIQUE(source_study_uid, source_component));`;

function legacyFixture(t) {
	const context = fixture(t),
		{ db } = context;
	db.pragma('foreign_keys = OFF');
	db.exec(`DROP TABLE study_recordings; DROP TABLE studies; ${legacyStudies}
 INSERT INTO studies(id,patient_code,patient_firstname,modality_id,exam_type_id,exam_details,exam_date_jalali,exam_time,source_study_uid,source_component,source_description,audio_report_path,text_report_path,resident_checked,attending_checked,telegram_message_id)
 VALUES(7,'001','Synthetic',1,1,'', '1405-07-18','10:00:00','1.2.3','1:','Combined','old_audio.ogg','old_report.txt',1,1,'42'),
 (8,'001','Synthetic',1,2,'Right','1405-07-18','10:00:00','1.2.3','2:RIGHT','Combined','second_audio.ogg',NULL,0,0,'43');
 INSERT INTO pending_voice(study_id,chat_id,reply_message_id,file_id,process_at) VALUES(7,'test',44,'file',0);
 INSERT INTO pending_telegram(study_id) VALUES(8);
 CREATE TABLE study_import_mappings(id INTEGER PRIMARY KEY); CREATE TABLE study_import_components(id INTEGER PRIMARY KEY, mapping_id INTEGER REFERENCES study_import_mappings(id));
 INSERT INTO study_import_mappings VALUES(1); INSERT INTO study_import_components VALUES(1,1);
 INSERT INTO sessions(id,user_id,expires_at) VALUES('test',1,'2099-01-01');`);
	db.pragma('foreign_keys = ON');
	return context;
}

test('automatic migration preserves legacy recordings, reports, signatures, study IDs and pending jobs', (t) => {
	const { db } = legacyFixture(t);
	initializeSchema(db, schema);
	const first = getStudyDetail(db, 7),
		second = getStudyDetail(db, 8);
	assert.equal(first.recordings[0].audio_report_path, 'old_audio.ogg');
	assert.equal(first.recordings[0].text_report_path, 'old_report.txt');
	assert.equal(first.recordings[0].resident_checked, 1);
	assert.equal(first.recordings[0].attending_checked, 1);
	assert.equal(second.recordings[0].exam_details, 'Right');
	assert.equal(first.source_modality, 'MR');
	assert.equal(first.telegram_message_id, '42');
	assert.equal(db.prepare('SELECT study_id FROM pending_voice').get().study_id, 7);
	assert.equal(db.prepare('SELECT study_id FROM pending_telegram').get().study_id, 8);
	assert.equal(db.prepare('SELECT count(*) AS n FROM report_templates').get().n, 2);
	assert.equal(db.prepare('SELECT id FROM sessions').get().id, 'test');
	assert.equal(
		db.prepare("SELECT name FROM sqlite_master WHERE name = 'study_import_mappings'").get(),
		undefined
	);
	assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
	assert.deepEqual(db.pragma('foreign_key_check'), []);
	initializeSchema(db, schema);
	assert.equal(db.prepare('SELECT count(*) AS n FROM study_recordings').get().n, 2);
	assert.equal(db.prepare('SELECT count(*) AS n FROM studies').get().n, 2);
});

test('migration failure rolls back and restores foreign key enforcement', (t) => {
	const { db } = legacyFixture(t);
	db.pragma('foreign_keys = OFF');
	db.prepare('UPDATE studies SET modality_id = 999 WHERE id = 7').run();
	db.pragma('foreign_keys = ON');
	assert.throws(() => initializeSchema(db, schema), /foreign key validation/);
	assert.ok(
		db
			.prepare('PRAGMA table_info(studies)')
			.all()
			.some((c) => c.name === 'audio_report_path')
	);
	assert.equal(
		db.prepare('SELECT text_report_path FROM studies WHERE id = 7').get().text_report_path,
		'old_report.txt'
	);
	assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});

test('multiple recordings append without overwriting and start without guessed examinations', (t) => {
	const { db, studyId, audio } = fixture(t);
	const first = appendRecording(db, studyId, audio),
		second = appendRecording(db, studyId, audio);
	assert.notEqual(first.id, second.id);
	assert.equal(first.modality_id, null);
	assert.equal(second.exam_type_id, null);
	assert.equal(getStudyDetail(db, studyId).recording_count, 2);
	assert.throws(() => appendRecording(db, 999, audio), /Study not found/);
	assert.throws(
		() => configureRecording(db, 999, first.id, { modality_id: 1 }),
		/Recording not found/
	);
});

test('configuration preserves contrast-specific exam and side; only its own report is invalidated', (t) => {
	const { db, studyId, audio, directory } = fixture(t);
	const first = appendRecording(db, studyId, audio),
		second = appendRecording(db, studyId, audio);
	configureRecording(db, studyId, first.id, {
		modality_id: 1,
		exam_type_id: 1,
		exam_details: '  Left  '
	});
	saveRecordingReport(db, first.id, 'First report', directory);
	saveRecordingReport(db, second.id, 'Second report', directory);
	const unchanged = configureRecording(db, studyId, first.id, {
		modality_id: 1,
		exam_type_id: 1,
		exam_details: 'Left'
	});
	assert.ok(unchanged.text_report_path);
	const changed = configureRecording(db, studyId, first.id, {
		exam_type_id: 2,
		exam_details: 'Right'
	});
	assert.equal(changed.exam_type_code, 'KNEE_WO');
	assert.equal(changed.exam_details, 'Right');
	assert.equal(changed.text_report_path, null);
	assert.equal(
		readFileSync(getRecording(db, studyId, second.id).text_report_path, 'utf8'),
		'Second report'
	);
	assert.throws(
		() => configureRecording(db, studyId, first.id, { exam_type_id: 999 }),
		/valid exam_type/
	);
});

test('combined processing makes no model calls until examination, audio and template are ready', async (t) => {
	const { db, studyId, audio } = fixture(t);
	const recording = appendRecording(db, studyId, audio);
	const never = async () => assert.fail('Model must not be called');
	await assert.rejects(processRecording(db, studyId, recording.id, never), /Select and save/);
	configureRecording(db, studyId, recording.id, { modality_id: 2, exam_type_id: 2 });
	await assert.rejects(processRecording(db, studyId, recording.id, never), /No report template/);
	configureRecording(db, studyId, recording.id, { modality_id: 1 });
	db.prepare('UPDATE study_recordings SET audio_report_path = ? WHERE id = ?').run(
		'missing_audio.ogg',
		recording.id
	);
	await assert.rejects(processRecording(db, studyId, recording.id, never), /Audio file not found/);
});

test('independent reports use each selected template, examination and shared study demographics', async (t) => {
	const { db, studyId, audio, directory } = fixture(t);
	const first = appendRecording(db, studyId, audio),
		second = appendRecording(db, studyId, audio);
	configureRecording(db, studyId, first.id, { modality_id: 1, exam_type_id: 1 });
	configureRecording(db, studyId, second.id, {
		modality_id: 1,
		exam_type_id: 2,
		exam_details: 'Right'
	});
	const generate = async (recording, template) => {
		assert.equal(recording.patient_code, '001');
		assert.equal(recording.patient_age_unit, 'M');
		return `${template}; ${recording.exam_type_code}; ${recording.exam_details}`;
	};
	const a = await processRecording(db, studyId, first.id, generate, directory);
	const b = await processRecording(db, studyId, second.id, generate, directory);
	assert.notEqual(a.path, b.path);
	assert.match(readFileSync(a.path, 'utf8'), /Brain template; BRAIN_WC/);
	assert.match(readFileSync(b.path, 'utf8'), /Knee template; KNEE_WO; Right/);
	assert.equal(getStudyDetail(db, studyId).report_count, 2);
	assert.equal(getRecording(db, studyId, first.id).processing, 0);
});

test('processing locks block simultaneous generation/configuration and clear after failed calls', async (t) => {
	const { db, studyId, audio, directory } = fixture(t);
	const recording = appendRecording(db, studyId, audio);
	configureRecording(db, studyId, recording.id, { modality_id: 1, exam_type_id: 1 });
	await assert.rejects(
		processRecording(
			db,
			studyId,
			recording.id,
			async () => {
				assert.throws(
					() => configureRecording(db, studyId, recording.id, { exam_details: 'Right' }),
					/being processed/
				);
				await assert.rejects(
					processRecording(db, studyId, recording.id, async () => 'Duplicate', directory),
					/being processed/
				);
				throw new Error('Provider unavailable');
			},
			directory
		),
		/Provider unavailable/
	);
	assert.equal(getRecording(db, studyId, recording.id).processing, 0);
	db.prepare(
		'UPDATE study_recordings SET processing = 1, processing_started_at = 1 WHERE id = ?'
	).run(recording.id);
	assert.equal(getRecording(db, studyId, recording.id).processing, 0);
});

test('signatures enforce assignment and order, and never affect another recording', (t) => {
	const { db, studyId, audio, directory } = fixture(t);
	const first = appendRecording(db, studyId, audio),
		second = appendRecording(db, studyId, audio);
	saveRecordingReport(db, first.id, 'Report', directory);
	assert.throws(
		() => signRecording(db, studyId, first.id, { id: 4, role: 'resident' }, 'resident', true),
		/corresponding reviewer/
	);
	assert.throws(
		() => signRecording(db, studyId, first.id, attending, 'attending', true),
		/Resident must sign/
	);
	signRecording(db, studyId, first.id, resident, 'resident', true);
	signRecording(db, studyId, first.id, attending, 'attending', true);
	assert.equal(getRecording(db, studyId, second.id).attending_checked, 0);
	assert.throws(
		() => configureRecording(db, studyId, first.id, { exam_details: 'Right' }),
		/Unsign/
	);
	assert.throws(
		() => signRecording(db, studyId, first.id, resident, 'resident', false),
		/Cannot unsign/
	);
	const reset = signRecording(db, studyId, first.id, admin, 'resident', false);
	assert.equal(reset.resident_checked, 0);
	assert.equal(reset.attending_checked, 0);
	assert.throws(
		() => signRecording(db, studyId, second.id, admin, 'resident', true),
		/Generate or save/
	);
});

test('Telegram reply retries are idempotent and multiple voices append without auto-generation', async (t) => {
	const { db, studyId, directory } = fixture(t);
	db.prepare('UPDATE studies SET telegram_message_id = ? WHERE id = ?').run('42', studyId);
	const message = {
		chat: { id: -1 },
		message_id: 43,
		reply_to_message: { message_id: 42 },
		voice: { file_id: 'fake' }
	};
	assert.equal(queueVoiceReply(db, message, 0), true);
	queueVoiceReply(db, message, 0);
	assert.equal(db.prepare('SELECT count(*) AS n FROM pending_voice').get().n, 1);
	queueVoiceReply(db, { ...message, message_id: 44 }, 0);
	const download = async (_, path) => {
		writeFileSync(path, 'fake voice');
		return path;
	};
	let notices = 0;
	const notify = async (study) => {
		assert.ok(study.recordings.length);
		notices++;
	};
	await processVoiceJob(db, download, notify, directory, 0);
	await processVoiceJob(db, download, notify, directory, 0);
	const study = getStudyDetail(db, studyId);
	assert.equal(study.recordings.length, 2);
	assert.equal(study.report_count, 0);
	assert.ok(study.recordings.every((r) => r.exam_type_id === null));
	assert.notEqual(study.recordings[0].audio_report_path, study.recordings[1].audio_report_path);
	assert.equal(notices, 2);
	db.prepare('UPDATE pending_voice SET done = 0 WHERE id = 1').run();
	await processVoiceJob(db, download, notify, directory, 0);
	assert.equal(getStudyDetail(db, studyId).recording_count, 2);
	assert.equal(await processVoiceJob(db, download, notify, directory, 0), false);
});

test('Telegram download failures retry without creating empty recordings', async (t) => {
	const { db, studyId, directory } = fixture(t);
	db.prepare('UPDATE studies SET telegram_message_id = ? WHERE id = ?').run('42', studyId);
	queueVoiceReply(
		db,
		{
			chat: { id: -1 },
			message_id: 43,
			reply_to_message: { message_id: 42 },
			audio: { file_id: 'fake' }
		},
		0
	);
	await processVoiceJob(
		db,
		async () => {
			throw new Error('Unavailable');
		},
		async () => assert.fail('No notification'),
		directory,
		0
	);
	assert.equal(getStudyDetail(db, studyId).recording_count, 0);
	assert.equal(db.prepare('SELECT process_at,done FROM pending_voice').get().process_at, 30);
});

test('Telegram templates describe attachment/selection and identify individual signed reports safely', (t) => {
	const { db, studyId, audio } = fixture(t);
	appendRecording(db, studyId, audio);
	const study = getStudyDetail(db, studyId);
	const summary = buildStudyMessage(study);
	assert.match(summary, /Reply to this study message/);
	assert.match(summary, /Awaiting examination selection/);
	assert.match(summary, /Recordings: 1/);
	const final = buildFinalReportMessage(
		study,
		{ id: 2, exam_type_code: 'KNEE_WO', modality_code: 'MR', exam_details: 'Right' },
		'<script>&'.repeat(2000)
	);
	assert.match(final, /Recording #2/);
	assert.match(final, /KNEE_WO Right, MR/);
	assert.match(final, /&lt;script&gt;&amp;/);
	assert.ok(final.length <= 4000);
	assert.ok(final.includes('</pre>'));
});

test('study deletion cascades recordings/queues but never deletes uploaded files', (t) => {
	const { db, studyId, audio } = fixture(t);
	appendRecording(db, studyId, audio);
	db.prepare('DELETE FROM studies WHERE id = ?').run(studyId);
	assert.equal(db.prepare('SELECT count(*) AS n FROM study_recordings').get().n, 0);
	assert.ok(existsSync(audio));
});
