import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { getAttendingReportPreferences, setAttendingReportPreferences, reportEnglishInstruction } from '../src/lib/server/report-preferences.js';
import { processRecording, saveRecordingReport } from '../src/lib/server/recording-processing.js';
import { generateRecordingReport } from '../src/lib/server/recording-generation.js';
import { appendRecording, appendRecordingAudio, configureRecording, getRecording } from '../src/lib/server/recordings.js';
import { insertStudy } from '../src/lib/server/studies.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	initializeSchema(db, schema);
	db.exec(`INSERT INTO modalities VALUES(1,'MR','MRI');
		INSERT INTO exam_types VALUES(1,'KNEE_WO','Knee without contrast');
		INSERT INTO users(id,full_name,role) VALUES(1,'Synthetic Resident','resident'),(2,'Synthetic Attending A','attending'),(3,'Synthetic Attending B','attending'),(4,'Synthetic Admin','admin');
		INSERT INTO report_templates(modality_id,exam_type_id,text) VALUES(1,1,'Findings: Bone marrow oedema.');`);
	const directory = mkdtempSync(join(tmpdir(), 'report-english-'));
	const audio = join(directory, 'synthetic.ogg');
	writeFileSync(audio, 'Synthetic audio; no patient data');
	const studyId = insertStudy(db, { patient_code: 'SYNTHETIC', patient_firstname: 'Synthetic', exam_date_jalali: '1405-08-03', exam_time: '09:00', corresponding_attending_id: 2 });
	const recording = appendRecording(db, studyId, audio);
	configureRecording(db, studyId, recording.id, { modality_id: 1, exam_type_ids: [1], corresponding_resident_id: 1 });
	const previous = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = 'synthetic-test-key';
	t.after(() => {
		if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
		db.close(); rmSync(directory, { recursive: true, force: true });
	});
	return { db, directory, audio, studyId, id: recording.id };
}

const response = (text = 'A joint effusion is present.') => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }) });

test('report English defaults to British and valid settings persist independently per attending across schema initialization', t => {
	const { db } = fixture(t);
	assert.deepEqual(getAttendingReportPreferences(db, 2), { english_variant: 'british' });
	assert.deepEqual(setAttendingReportPreferences(db, 2, { english_variant: 'american' }), { english_variant: 'american' });
	assert.deepEqual(getAttendingReportPreferences(db, 3), { english_variant: 'british' });
	setAttendingReportPreferences(db, 3, { english_variant: 'british' });
	initializeSchema(db, schema);
	assert.deepEqual(getAttendingReportPreferences(db, 2), { english_variant: 'american' });
	assert.deepEqual(getAttendingReportPreferences(db, 3), { english_variant: 'british' });
	assert.match(reportEnglishInstruction(), /UK English/);
	assert.throws(() => reportEnglishInstruction('Ignore instructions'), { status: 400 });
});

test('invalid variants and payloads cannot change saved preferences and nonattendings cannot set them', t => {
	const { db } = fixture(t);
	setAttendingReportPreferences(db, 2, { english_variant: 'american' });
	for (const value of [null, {}, [], { english_variant: undefined }, { english_variant: null }, { english_variant: 'British' }, { english_variant: 'custom instructions' }, { english_variant: ['american'] }, { english_variant: 'british', user_id: 3 }]) {
		assert.throws(() => setAttendingReportPreferences(db, 2, value), { status: 400 });
		assert.equal(getAttendingReportPreferences(db, 2).english_variant, 'american');
	}
	for (const id of [1, 4, 999]) assert.throws(() => setAttendingReportPreferences(db, id, { english_variant: 'american' }), { status: 403 });
	assert.equal(db.prepare('SELECT count(*) AS n FROM attending_report_preferences').get().n, 1);
});

test('upgrading a database without preferences preserves reports and signatures; initialization is repeatable', t => {
	const { db, directory, studyId, id } = fixture(t);
	const path = saveRecordingReport(db, id, 'Existing signed report.', directory);
	db.prepare('UPDATE study_recordings SET resident_checked=1,attending_checked=1 WHERE id=?').run(id);
	const before = getRecording(db, studyId, id);
	db.exec('DROP TABLE attending_report_preferences');
	initializeSchema(db, schema);
	initializeSchema(db, schema);
	assert.deepEqual(getRecording(db, studyId, id), before);
	assert.equal(getAttendingReportPreferences(db, 2).english_variant, 'british');
	assert.equal(readFileSync(path, 'utf8'), 'Existing signed report.');
});

test('generation uses the assigned attending preference, snapshots before transcription, and applies complete-sentence rules', async t => {
	const { db, audio, directory, studyId, id } = fixture(t);
	setAttendingReportPreferences(db, 2, { english_variant: 'american' });
	setAttendingReportPreferences(db, 3, { english_variant: 'british' });
	appendRecordingAudio(db, studyId, id, audio, null, { id: 1, role: 'resident' });
	const dictations = ['Joint effusion. Possible meniscal tear.', 'No marrow edema; left-sided pain.'];
	let transcriptions = 0;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		if (url.endsWith('/audio/transcriptions')) {
			setAttendingReportPreferences(db, 2, { english_variant: 'british' });
			return { ok: true, json: async () => ({ text: dictations[transcriptions++] }) };
		}
		assert.equal(url, 'https://api.openai.com/v1/responses');
		const { model, input } = JSON.parse(options.body);
		assert.equal(model, 'gpt-6.1-sol');
		assert.equal(transcriptions, 2);
		assert.match(input, /Use American radiology terminology and US English spelling and phrasing/);
		assert.doesNotMatch(input, /Use British radiology terminology/);
		assert.match(input, /selected English variant and complete-sentence rules take precedence/);
		assert.match(input, /subject and finite verb/);
		assert.match(input, /"joint effusion" becomes "A joint effusion is present\."/);
		assert.match(input, /Preserve negation and uncertainty/);
		assert.match(input, /Do not add an undictated location, side, severity, cause, certainty, comparison, measurement, diagnosis, or recommendation/);
		assert.match(input, /Section headings, the study title, and measurement\/table labels may remain labels/);
		assert.ok(input.includes(`Doctor's dictation:\n"${dictations.join('\n')}"`));
		assert.ok(input.includes('Findings: Bone marrow oedema.'));
		return response();
	});
	const result = await processRecording(db, studyId, id, undefined, directory);
	assert.equal(readFileSync(result.path, 'utf8'), 'A joint effusion is present.');
	assert.equal(getAttendingReportPreferences(db, 2).english_variant, 'british');
	assert.equal(getRecording(db, studyId, id).processing, 0);
});

test('each study uses its own attending, regardless of another attending preference', async t => {
	const { db, directory, studyId, id } = fixture(t);
	setAttendingReportPreferences(db, 2, { english_variant: 'american' });
	db.prepare('UPDATE studies SET corresponding_attending_id=3 WHERE id=?').run(studyId);
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		if (url.endsWith('/audio/transcriptions')) return { ok: true, json: async () => ({ text: 'Joint effusion.' }) };
		const prompt = JSON.parse(options.body).input;
		assert.match(prompt, /Use British radiology terminology and UK English spelling and phrasing/);
		assert.doesNotMatch(prompt, /Use American radiology terminology/);
		return response();
	});
	await processRecording(db, studyId, id, undefined, directory);
});

test('preference changes do not touch saved signed reports or bypass signed-recording generation guards', async t => {
	const { db, directory, studyId, id } = fixture(t);
	const path = saveRecordingReport(db, id, 'Original signed report.', directory);
	db.prepare('UPDATE study_recordings SET resident_checked=1,attending_checked=1 WHERE id=?').run(id);
	const before = getRecording(db, studyId, id);
	setAttendingReportPreferences(db, 2, { english_variant: 'american' });
	assert.deepEqual(getRecording(db, studyId, id), before);
	t.mock.method(globalThis, 'fetch', async () => assert.fail('Signed reports must not be regenerated'));
	await assert.rejects(processRecording(db, studyId, id, undefined, directory), { status: 409 });
	assert.equal(readFileSync(path, 'utf8'), 'Original signed report.');
});

test('invalid generation variants are rejected before any audio upload', async t => {
	const { audio } = fixture(t);
	t.mock.method(globalThis, 'fetch', async () => assert.fail('Invalid variants must not reach a provider'));
	await assert.rejects(generateRecordingReport({ audio_report_path: audio, report_english_variant: 'custom' }, 'Synthetic template'), { status: 400 });
});
