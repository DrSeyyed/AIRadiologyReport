import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { insertStudy } from '../src/lib/server/studies.js';
import { appendRecording, configureRecording, getRecording } from '../src/lib/server/recordings.js';
import { processRecording, saveRecordingReport } from '../src/lib/server/recording-processing.js';
import { recordingTemplate } from '../src/lib/server/recording-templates.js';
import { generateRecordingReport } from '../src/lib/server/recording-generation.js';
import { reportTitle } from '../src/lib/report-title.js';
import { buildStudyMessage } from '../src/lib/server/telegram.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	initializeSchema(db, schema);
	db.exec(`INSERT INTO modalities VALUES(1,'MR','MRI'),(2,'CT','CT');
		INSERT INTO exam_types VALUES(1,'BRAIN_WO','Brain without contrast'),(2,'CSPINE_WO','Cervical spine without contrast'),(3,'HAND_WC','Hand with contrast');
		INSERT INTO users(id,full_name,role) VALUES(1,'Resident','resident'),(2,'Attending','attending');
		INSERT INTO report_templates(modality_id,exam_type_id,text) VALUES(1,1,'  Brain findings\nConclusion: normal  '),(1,2,'Spine findings');`);
	const directory = mkdtempSync(join(tmpdir(), 'multi-examinations-'));
	const audio = join(directory, 'synthetic.ogg');
	writeFileSync(audio, 'Synthetic audio only');
	const studyId = insertStudy(db, { patient_code: 'SYNTHETIC', patient_firstname: 'Synthetic', patient_lastname: 'Patient', exam_date_jalali: '1405-07-18', exam_time: '10:00', corresponding_attending_id: 2 });
	const recording = appendRecording(db, studyId, audio);
	configureRecording(db, studyId, recording.id, { modality_id: 1, exam_type_ids: [1, 2], corresponding_resident_id: 1 });
	t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
	return { db, studyId, id: recording.id, audio, directory };
}

function selected(db, id) {
	return db.prepare('SELECT exam_type_id, position FROM recording_examinations WHERE recording_id = ? ORDER BY position').all(id);
}

test('ordered selections persist with a compatible primary examination; reordering invalidates only its report', (t) => {
	const { db, studyId, id, audio, directory } = fixture(t);
	const other = appendRecording(db, studyId, audio);
	const firstPath = saveRecordingReport(db, id, 'First report', directory);
	const otherPath = saveRecordingReport(db, other.id, 'Other report', directory);
	const unchanged = configureRecording(db, studyId, id, { exam_type_ids: [1, 2] });
	assert.equal(unchanged.text_report_path, firstPath);
	assert.deepEqual(unchanged.exam_type_ids, [1, 2]);
	assert.deepEqual(unchanged.exam_types.map((exam) => exam.code), ['BRAIN_WO', 'CSPINE_WO']);
	const changed = configureRecording(db, studyId, id, { exam_type_ids: [2, 1] });
	assert.deepEqual(selected(db, id), [{ exam_type_id: 2, position: 0 }, { exam_type_id: 1, position: 1 }]);
	assert.equal(changed.exam_type_id, 2);
	assert.equal(changed.exam_type_code, 'CSPINE_WO');
	assert.equal(changed.modality_id, 1);
	assert.equal(changed.text_report_path, null);
	assert.equal(getRecording(db, studyId, other.id).text_report_path, otherPath);
	assert.deepEqual(configureRecording(db, studyId, id, { exam_type_id: 3 }).exam_type_ids, [3]);
	assert.deepEqual(configureRecording(db, studyId, id, { exam_type_ids: [] }).exam_type_ids, []);
	assert.equal(getRecording(db, studyId, id).exam_type_id, null);
});

test('invalid and conflicting selections never modify the saved configuration or report', (t) => {
	const { db, studyId, id, directory } = fixture(t);
	const path = saveRecordingReport(db, id, 'Saved report', directory);
	for (const input of [
		{ exam_type_ids: null }, { exam_type_ids: '1,2' }, { exam_type_ids: [1, 1] },
		{ exam_type_ids: ['1'] }, { exam_type_ids: [0] }, { exam_type_ids: [-1] },
		{ exam_type_ids: [1.5] }, { exam_type_ids: [Number.MAX_SAFE_INTEGER + 1] },
		{ exam_type_ids: [1, 999] }, { exam_type_ids: [2, 1], exam_type_id: 1 },
		{ exam_type_ids: [1], modality_id: 999 }
	]) {
		assert.throws(() => configureRecording(db, studyId, id, input), { status: 400 });
		const saved = getRecording(db, studyId, id);
		assert.deepEqual(saved.exam_type_ids, [1, 2]);
		assert.equal(saved.text_report_path, path);
	}
	assert.deepEqual(configureRecording(db, studyId, id, { exam_type_ids: [1, 2], exam_type_id: 1 }).exam_type_ids, [1, 2]);
});

test('ordered child writes and report invalidation roll back together on a database failure', (t) => {
	const { db, studyId, id, directory } = fixture(t);
	const path = saveRecordingReport(db, id, 'Saved report', directory);
	db.exec("CREATE TRIGGER fail_selection BEFORE INSERT ON recording_examinations BEGIN SELECT RAISE(ABORT, 'Synthetic failure'); END;");
	assert.throws(() => configureRecording(db, studyId, id, { exam_type_ids: [2, 1] }), /Synthetic failure/);
	assert.deepEqual(getRecording(db, studyId, id).exam_type_ids, [1, 2]);
	assert.equal(getRecording(db, studyId, id).text_report_path, path);
	assert.equal(getRecording(db, studyId, id).exam_type_id, 1);
});

test('all signing, processing and disabled guards protect plural selection changes', (t) => {
	const { db, studyId, id } = fixture(t);
	for (const column of ['resident_checked', 'attending_checked', 'typist_checked', 'processing']) {
		db.prepare(`UPDATE study_recordings SET ${column} = 1 WHERE id = ?`).run(id);
		assert.throws(() => configureRecording(db, studyId, id, { exam_type_ids: [2, 1] }), { status: 409 });
		db.prepare(`UPDATE study_recordings SET ${column} = 0 WHERE id = ?`).run(id);
	}
	db.prepare('UPDATE studies SET disabled = 1 WHERE id = ?').run(studyId);
	assert.throws(() => configureRecording(db, studyId, id, { exam_type_ids: [2, 1] }), { status: 409 });
	assert.deepEqual(getRecording(db, studyId, id).exam_type_ids, [1, 2]);
});

test('upgrading backfills singular selections idempotently without changing signed reports or plural order', (t) => {
	const { db, studyId, id, audio } = fixture(t);
	const legacy = appendRecording(db, studyId, audio);
	db.prepare("UPDATE study_recordings SET exam_type_id = 3, text_report_path = 'legacy.txt', resident_checked = 1 WHERE id = ?").run(legacy.id);
	configureRecording(db, studyId, id, { exam_type_ids: [2, 1] });
	for (let attempt = 0; attempt < 2; attempt++) {
		initializeSchema(db, schema);
		assert.deepEqual(getRecording(db, studyId, id).exam_type_ids, [2, 1]);
		assert.deepEqual(selected(db, legacy.id), [{ exam_type_id: 3, position: 0 }]);
		assert.equal(getRecording(db, studyId, legacy.id).text_report_path, 'legacy.txt');
		assert.equal(getRecording(db, studyId, legacy.id).resident_checked, 1);
		assert.deepEqual(db.pragma('foreign_key_check'), []);
	}
	db.prepare('DELETE FROM studies WHERE id = ?').run(studyId);
	assert.deepEqual(selected(db, id), []);
	assert.deepEqual(selected(db, legacy.id), []);
});

test('a pre-upgrade database creates and backfills the ordered selection table', (t) => {
	const { db, studyId, id } = fixture(t);
	db.exec('DROP TABLE recording_examinations');
	initializeSchema(db, schema);
	assert.deepEqual(getRecording(db, studyId, id).exam_type_ids, [1]);
	assert.deepEqual(selected(db, id), [{ exam_type_id: 1, position: 0 }]);
});

test('template merging preserves source content and selection order; single templates remain unchanged', (t) => {
	const { db, studyId, id } = fixture(t);
	const multi = getRecording(db, studyId, id);
	assert.equal(recordingTemplate(db, multi), '## Brain without contrast\nBrain findings\nConclusion: normal\n\n## Cervical spine without contrast\nSpine findings\n\n## Conclusion');
	const reversed = configureRecording(db, studyId, id, { exam_type_ids: [2, 1] });
	assert.ok(recordingTemplate(db, reversed).startsWith('## Cervical spine without contrast\nSpine findings'));
	const single = configureRecording(db, studyId, id, { exam_type_ids: [1] });
	assert.equal(recordingTemplate(db, single), '  Brain findings\nConclusion: normal  ');
});

test('every selected template is required before any model call; missing templates preserve reports', async (t) => {
	const { db, studyId, id, directory } = fixture(t);
	configureRecording(db, studyId, id, { exam_type_ids: [1, 3, 2] });
	const path = saveRecordingReport(db, id, 'Saved report', directory);
	db.prepare("UPDATE report_templates SET text = '  ' WHERE exam_type_id = 2").run();
	let calls = 0;
	await assert.rejects(processRecording(db, studyId, id, async () => { calls++; return 'Unexpected'; }, directory), /Hand with contrast, Cervical spine without contrast/);
	assert.equal(calls, 0);
	assert.equal(getRecording(db, studyId, id).text_report_path, path);
	assert.equal(getRecording(db, studyId, id).processing, 0);
});

test('processing uses all ordered templates, selected titles, and one combined generation request', async (t) => {
	const { db, studyId, id, directory } = fixture(t);
	configureRecording(db, studyId, id, { exam_type_ids: [2, 1], exam_details: 'Left' });
	let calls = 0;
	await processRecording(db, studyId, id, async (recording, template) => {
		calls++;
		assert.deepEqual(recording.exam_type_ids, [2, 1]);
		assert.equal(recording.modality_id, 1);
		assert.ok(template.indexOf('Spine findings') < template.indexOf('Brain findings'));
		assert.equal(reportTitle(recording), 'Left Cervical spine MRI without contrast + Left Brain MRI without contrast');
		assert.match(buildStudyMessage({ id: studyId, recordings: [recording] }), /CSPINE_WO \+ BRAIN_WO/);
		return 'Synthetic combined report';
	}, directory);
	assert.equal(calls, 1);
	assert.equal(getRecording(db, studyId, id).processing, 0);
});

test('multi-body generation requests ordered headings, attributed findings and one shared Conclusion', async (t) => {
	const { db, studyId, id } = fixture(t);
	const recording = getRecording(db, studyId, id);
	let transcriptions = 0, generations = 0;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		if (url.endsWith('/audio/transcriptions')) {
			transcriptions++;
			assert.match(options.body.get('prompt'), /hypointense/);
			return { ok: true, json: async () => ({ text: 'Synthetic brain low T1. Cervical spine normal.' }) };
		}
		assert.equal(url, 'https://api.openai.com/v1/responses');
		generations++;
		const prompt = JSON.parse(options.body).input;
		assert.match(prompt, /Study label: Brain without contrast \+ Cervical spine without contrast, MRI/);
		assert.match(prompt, /body-part heading for each selected examination in the order listed/);
		assert.match(prompt, /do not duplicate it across body parts or apply it to other examinations/);
		assert.match(prompt, /exactly one shared Conclusion at the end/);
		assert.match(prompt, /Ignore prewritten conclusions in the source templates/);
		assert.match(prompt, /Synthetic brain low T1\. Cervical spine normal\./);
		return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Synthetic combined report' }] }] }) };
	});
	assert.equal(await generateRecordingReport(recording, recordingTemplate(db, recording)), 'Synthetic combined report');
	assert.equal(transcriptions, 1);
	assert.equal(generations, 1);
});
