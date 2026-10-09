import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import * as XLSX from 'xlsx';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { normalizeStudyInput, insertStudy, getStudyDetail } from '../src/lib/server/studies.js';
import { parseStudyWorkbook } from '../src/lib/server/excel-studies.js';
import { saveImportMapping } from '../src/lib/server/import-mappings.js';
import { previewStudyImport, commitStudyImport } from '../src/lib/server/study-import.js';
import { processStudyNotification } from '../src/lib/server/study-notifications.js';
import { buildStudyMessage, syncStudyMessage } from '../src/lib/server/telegram.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	initializeSchema(db, schema);
	db.exec(
		"INSERT INTO modalities(id,code,name) VALUES(1,'MR','MRI'),(2,'CT','CT'); INSERT INTO exam_types(id,code,name) VALUES(1,'Brain_WC','Brain with contrast'),(2,'Knee_WO','Knee without contrast'); INSERT INTO users(id,full_name,role) VALUES(1,'Admin','admin'),(2,'Resident','resident'),(3,'Attending','attending');"
	);
	t.after(() => db.close());
	return db;
}
function row(overrides = {}) {
	return {
		row: 2,
		source_study_uid: '1.2.3',
		patient_code: '00012',
		patient_firstname: 'Sample',
		patient_lastname: 'Patient',
		patient_gender: 'unknown',
		patient_age: 45,
		patient_age_unit: 'Y',
		modality_code: 'MR',
		source_description: 'BR + / RT KNEE',
		exam_date_jalali: '1405-07-16',
		exam_time: '10:30:00',
		errors: [],
		...overrides
	};
}
function mapping(db) {
	return saveImportMapping(db, {
		modality_id: 1,
		source_description: 'BR + / RT KNEE',
		components: [
			{ exam_type_id: 1, exam_details: '' },
			{ exam_type_id: 2, exam_details: 'Right' }
		]
	});
}
function input(overrides = {}) {
	return { ...row(), modality_id: 1, exam_type_id: 2, ...overrides };
}

test('schema reset requires opt-in, retains reference data, and is idempotent', (t) => {
	const db = fixture(t);
	db.exec(
		"INSERT INTO report_templates(modality_id,exam_type_id,text) VALUES(1,1,'Template'); INSERT INTO sessions(id,user_id,expires_at) VALUES('test',1,'2099-01-01'); DROP TABLE studies; CREATE TABLE patients(id INTEGER PRIMARY KEY); CREATE TABLE studies(id INTEGER PRIMARY KEY,patient_id INTEGER REFERENCES patients(id)); INSERT INTO patients VALUES(1); INSERT INTO studies VALUES(1,1); INSERT INTO pending_voice(study_id,chat_id,reply_message_id,file_id,process_at) VALUES(1,'test',1,'test',0);"
	);
	assert.throws(() => initializeSchema(db, schema), /RESET_TEST_STUDIES=1/);
	assert.equal(db.prepare('SELECT count(*) AS n FROM studies').get().n, 1);
	assert.deepEqual(initializeSchema(db, schema, { resetTestStudies: true }), { reset: true });
	assert.equal(db.prepare('SELECT count(*) AS n FROM studies').get().n, 0);
	assert.equal(db.prepare('SELECT count(*) AS n FROM pending_voice').get().n, 0);
	assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 3);
	assert.equal(db.prepare('SELECT text FROM report_templates').get().text, 'Template');
	assert.equal(db.prepare('SELECT id FROM sessions').get().id, 'test');
	assert.equal(
		db.prepare("SELECT name FROM sqlite_master WHERE name = 'patients'").get(),
		undefined
	);
	assert.deepEqual(initializeSchema(db, schema), { reset: false });
	assert.ok(
		db
			.prepare('PRAGMA foreign_key_list(pending_voice)')
			.all()
			.some((fk) => fk.table === 'studies' && fk.on_delete === 'CASCADE')
	);
});

test('demographics remain independent; age zero/unknown and optional staff are valid', (t) => {
	const db = fixture(t);
	const first = insertStudy(db, input({ patient_age: 0, patient_age_unit: 'D' }));
	const second = insertStudy(
		db,
		input({
			patient_age: '',
			patient_firstname: 'Different',
			corresponding_resident_id: '',
			corresponding_attending_id: null
		})
	);
	assert.equal(getStudyDetail(db, first).patient_age, 0);
	assert.equal(getStudyDetail(db, first).patient_age_unit, 'D');
	assert.equal(getStudyDetail(db, second).patient_age, null);
	assert.equal(getStudyDetail(db, second).resident_fullname, null);
	assert.equal(getStudyDetail(db, first).patient_firstname, 'Sample');
	for (const invalid of [
		{ patient_age: -1 },
		{ patient_age: 1.5 },
		{ patient_age_unit: 'Z' },
		{ patient_gender: 'invalid' },
		{ patient_code: '' },
		{ exam_date_jalali: '1405-13-01' },
		{ exam_time: '25:00' },
		{ corresponding_resident_id: 3 },
		{ corresponding_attending_id: 2 },
		{ modality_id: 100 }
	])
		assert.throws(() => normalizeStudyInput(db, input(invalid)));
});

test('preview registers only descriptions, never patient records or guesses components', (t) => {
	const db = fixture(t);
	const preview = previewStudyImport(db, [row()], { registerDescriptions: true });
	assert.equal(preview.rows[0].status, 'unmapped');
	assert.equal(db.prepare('SELECT count(*) AS n FROM studies').get().n, 0);
	assert.equal(
		db.prepare('SELECT description_key FROM study_import_mappings').get().description_key,
		'BR + / RT KNEE'
	);
	assert.throws(() => commitStudyImport(db, preview, [2]), /unresolved/);
	mapping(db);
	assert.equal(previewStudyImport(db, [row()]).rows[0].status, 'ready');
});

test('explicit mapping splits studies, preserves contrast/side, and skips repeats', (t) => {
	const db = fixture(t);
	mapping(db);
	const preview = previewStudyImport(db, [row(), row({ row: 3 })]);
	assert.deepEqual(
		preview.rows.map((item) => item.status),
		['ready', 'duplicate']
	);
	assert.deepEqual(commitStudyImport(db, preview, [2, 3], {}, { queueTelegram: true }), {
		inserted: 2,
		skipped: 2
	});
	const studies = db.prepare('SELECT * FROM studies ORDER BY id').all();
	assert.deepEqual(
		studies.map((item) => [item.exam_type_id, item.exam_details]),
		[
			[1, ''],
			[2, 'Right']
		]
	);
	assert.equal(studies[0].patient_code, '00012');
	assert.equal(studies[0].source_description, 'BR + / RT KNEE');
	assert.equal(db.prepare('SELECT count(*) AS n FROM pending_telegram').get().n, 2);
	const repeated = previewStudyImport(db, [row()]);
	assert.equal(repeated.rows[0].status, 'duplicate');
	assert.deepEqual(commitStudyImport(db, repeated, [2]), { inserted: 0, skipped: 2 });
	assert.notEqual(repeated.token, preview.token);
});

test('UID conflicts block every source row and never overwrite an existing study', (t) => {
	const db = fixture(t);
	mapping(db);
	const conflicting = previewStudyImport(db, [row(), row({ row: 3, patient_age: 46 })]);
	assert.deepEqual(
		conflicting.rows.map((item) => item.status),
		['conflict', 'conflict']
	);
	const initial = previewStudyImport(db, [row()]);
	commitStudyImport(db, initial, [2]);
	for (const changed of [
		{ patient_age: 46 },
		{ patient_firstname: 'Changed' },
		{ modality_code: 'CT' },
		{ source_description: 'Different exam' }
	])
		assert.equal(previewStudyImport(db, [row(changed)]).rows[0].status, 'conflict');
	assert.equal(db.prepare('SELECT patient_age FROM studies LIMIT 1').get().patient_age, 45);
	const another = previewStudyImport(db, [
		row({ row: 4, source_study_uid: '1.2.4', patient_firstname: 'Different' })
	]);
	assert.equal(another.rows[0].status, 'ready');
	commitStudyImport(db, another, [4]);
	assert.equal(db.prepare('SELECT count(*) AS n FROM studies').get().n, 4);
});

test('mapping changes invalidate preview; invalid assignments roll back all inserts', (t) => {
	const db = fixture(t);
	mapping(db);
	const before = previewStudyImport(db, [row()]);
	saveImportMapping(db, {
		modality_id: 1,
		source_description: row().source_description,
		components: [{ exam_type_id: 2, exam_details: 'Left' }]
	});
	const after = previewStudyImport(db, [row()]);
	assert.notEqual(before.token, after.token);
	assert.throws(() => commitStudyImport(db, after, [2], { corresponding_resident_id: 3 }));
	assert.equal(db.prepare('SELECT count(*) AS n FROM studies').get().n, 0);
	assert.throws(() => commitStudyImport(db, after, [999]), /unresolved/);
});

test('real workbook parses into split studies with age from AGE, not birth date', (t) => {
	const db = fixture(t);
	mapping(db);
	const workbook = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(
		workbook,
		XLSX.utils.aoa_to_sheet([
			[
				'ID',
				'NAME',
				'SEX',
				'AGE',
				'BIRTH DATE',
				'MODALITY',
				'DESCRIPTION',
				'STUDY DATE',
				'STUDY INST UID'
			],
			[
				'00012',
				'Patient^Sample',
				'F',
				'045Y',
				'19000101',
				'MR',
				row().source_description,
				'2026-10-08 10:30:00',
				'1.2.3'
			]
		]),
		'Studies'
	);
	const parsed = parseStudyWorkbook(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
	assert.deepEqual(parsed[0].errors, []);
	const preview = previewStudyImport(db, parsed);
	assert.equal(preview.rows[0].status, 'ready');
	assert.deepEqual(commitStudyImport(db, preview, [parsed[0].row]), { inserted: 2, skipped: 0 });
	const study = db.prepare('SELECT * FROM studies LIMIT 1').get();
	assert.equal(study.patient_age, 45);
	assert.equal(study.patient_gender, 'female');
	assert.equal(study.patient_firstname, 'Sample');
	assert.equal(previewStudyImport(db, parsed).rows[0].status, 'duplicate');
});

test('notification queue persists success, retries failures, and cascades on deletion', async (t) => {
	const db = fixture(t);
	const id = insertStudy(db, input());
	db.prepare('INSERT INTO pending_telegram(study_id) VALUES(?)').run(id);
	await processStudyNotification(
		db,
		async () => {
			throw new Error('Unavailable');
		},
		100
	);
	assert.deepEqual(db.prepare('SELECT attempts,retry_at FROM pending_telegram').get(), {
		attempts: 1,
		retry_at: 130
	});
	assert.equal(
		await processStudyNotification(db, async () => assert.fail('too early'), 129),
		false
	);
	await processStudyNotification(db, async () => ({ message_id: 42 }), 130);
	assert.equal(getStudyDetail(db, id).telegram_message_id, '42');
	assert.equal(db.prepare('SELECT count(*) AS n FROM pending_telegram').get().n, 0);
	const second = insertStudy(db, input());
	db.prepare('INSERT INTO pending_telegram(study_id) VALUES(?)').run(second);
	db.prepare(
		'INSERT INTO pending_voice(study_id,chat_id,reply_message_id,file_id,process_at) VALUES(?,?,?,?,?)'
	).run(second, 'test', 1, 'test', 0);
	db.prepare('DELETE FROM studies WHERE id=?').run(second);
	assert.equal(db.prepare('SELECT count(*) AS n FROM pending_telegram').get().n, 0);
	assert.equal(db.prepare('SELECT count(*) AS n FROM pending_voice').get().n, 0);
	assert.match(
		buildStudyMessage(input({ id, patient_age: 0, patient_age_unit: 'D' })),
		/Age: 0 days/
	);
	assert.equal(await syncStudyMessage({}), false);
});
