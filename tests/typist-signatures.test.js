import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { insertStudy, getStudyDetail, studySignatureFilter } from '../src/lib/server/studies.js';
import {
	appendRecording,
	configureRecording,
	signRecording,
	getRecording
} from '../src/lib/server/recordings.js';
import { saveRecordingReport } from '../src/lib/server/recording-processing.js';
import { buildStudyMessage } from '../src/lib/server/telegram.js';

const users = {
	admin: { id: 1, role: 'admin' },
	resident: { id: 2, role: 'resident' },
	attending: { id: 3, role: 'attending' },
	typist: { id: 4, role: 'typist' },
	otherResident: { id: 5, role: 'resident' },
	otherAttending: { id: 6, role: 'attending' },
	otherTypist: { id: 7, role: 'typist' }
};
function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	initializeSchema(db, readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
	db.exec(
		"INSERT INTO modalities VALUES(1,'CT','CT'); INSERT INTO exam_types VALUES(1,'BRAIN_WO','Brain without contrast');"
	);
	for (const [name, user] of Object.entries(users)) {
		db.prepare('INSERT INTO users(id,full_name,role) VALUES(?,?,?)').run(user.id, name, user.role);
	}
	const directory = mkdtempSync(join(tmpdir(), 'typist-signatures-'));
	t.after(() => {
		db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	const studyId = insertStudy(db, {
		patient_code: 'fixture',
		patient_firstname: 'Synthetic',
		exam_date_jalali: '1405-07-18',
		exam_time: '10:00',
		corresponding_attending_id: users.attending.id
	});
	const recording = appendRecording(db, studyId, null);
	configureRecording(db, studyId, recording.id, {
		modality_id: 1,
		exam_type_id: 1,
		corresponding_resident_id: users.resident.id
	});
	saveRecordingReport(db, recording.id, 'Synthetic report', directory);
	const sign = (user, role, checked = true) =>
		signRecording(db, studyId, recording.id, user, role, checked);
	const approve = () => {
		sign(users.resident, 'resident');
		sign(users.attending, 'attending');
	};
	return { db, directory, studyId, recordingId: recording.id, sign, approve };
}

test('typist confirmation requires both clinical signatures, including admin overrides', (t) => {
	const { sign } = fixture(t);
	for (const user of [users.typist, users.admin, users.resident, users.attending])
		assert.throws(() => sign(user, 'typist'), /Resident and attending must sign/);
	sign(users.resident, 'resident');
	assert.throws(() => sign(users.typist, 'typist'), /Resident and attending must sign/);
	sign(users.attending, 'attending');
	assert.equal(sign(users.typist, 'typist').typist_checked, 1);
});

test('only typists, admin and the corresponding clinicians can confirm or withdraw printing', (t) => {
	const { sign, approve } = fixture(t);
	approve();
	for (const user of [users.otherResident, users.otherAttending]) {
		assert.throws(
			() => sign(user, 'typist'),
			(error) => error.status === 403
		);
		assert.throws(
			() => sign(user, 'typist', false),
			(error) => error.status === 403
		);
	}
	for (const user of [
		users.typist,
		users.otherTypist,
		users.admin,
		users.resident,
		users.attending
	]) {
		const signed = sign(user, 'typist');
		assert.equal(signed.typist_signed_by_user_id, user.id);
		assert.ok(signed.typist_signed_at);
		assert.equal(
			signed.typist_signer_fullname,
			Object.keys(users).find((name) => users[name].id === user.id)
		);
		const cleared = sign(user, 'typist', false);
		assert.equal(cleared.typist_checked, 0);
		assert.equal(cleared.typist_signed_by_user_id, null);
		assert.equal(cleared.typist_signed_at, null);
		assert.equal(cleared.resident_checked, 1);
		assert.equal(cleared.attending_checked, 1);
	}
	for (const role of ['resident', 'attending']) {
		assert.throws(
			() => sign(users.typist, role),
			(error) => error.status === 403
		);
		assert.throws(
			() => sign(users.typist, role, false),
			(error) => error.status === 403
		);
	}
});

test('repeated confirmation preserves the actual signer and timestamp', (t) => {
	const { sign, approve } = fixture(t);
	approve();
	const first = sign(users.typist, 'typist');
	const repeat = sign(users.admin, 'typist');
	assert.equal(repeat.typist_signed_by_user_id, first.typist_signed_by_user_id);
	assert.equal(repeat.typist_signed_at, first.typist_signed_at);
});

test('upstream withdrawals invalidate printing confirmation without changing other recordings', (t) => {
	const { db, studyId, recordingId, sign, approve } = fixture(t);
	const second = appendRecording(db, studyId, null);
	approve();
	sign(users.typist, 'typist');
	const withdrawn = sign(users.attending, 'attending', false);
	assert.equal(withdrawn.resident_checked, 1);
	assert.equal(withdrawn.typist_checked, 0);
	assert.equal(withdrawn.typist_signed_by_user_id, null);
	assert.equal(withdrawn.typist_signed_at, null);
	sign(users.attending, 'attending');
	sign(users.typist, 'typist');
	assert.throws(() => sign(users.resident, 'resident', false), /Cannot unsign resident/);
	const reset = sign(users.admin, 'resident', false);
	assert.equal(reset.resident_checked, 0);
	assert.equal(reset.attending_checked, 0);
	assert.equal(reset.typist_checked, 0);
	assert.equal(reset.typist_signed_by_user_id, null);
	assert.equal(reset.typist_signed_at, null);
	assert.deepEqual(getRecording(db, studyId, second.id), second);
	assert.equal(getRecording(db, studyId, recordingId).text_report_path, withdrawn.text_report_path);
});

test('processing blocks confirmation and report replacement clears the typist audit fields', (t) => {
	const { db, directory, recordingId, sign, approve, studyId } = fixture(t);
	approve();
	db.prepare(
		'UPDATE study_recordings SET processing = 1, processing_started_at = ? WHERE id = ?'
	).run(Math.floor(Date.now() / 1000), recordingId);
	assert.throws(
		() => sign(users.typist, 'typist'),
		(error) => error.status === 409
	);
	db.prepare('UPDATE study_recordings SET processing = 0 WHERE id = ?').run(recordingId);
	sign(users.typist, 'typist');
	assert.throws(
		() => configureRecording(db, studyId, recordingId, { exam_details: 'Left' }),
		/Unsign/
	);
	saveRecordingReport(db, recordingId, 'Replaced synthetic report', directory);
	const recording = getRecording(db, studyId, recordingId);
	assert.equal(recording.typist_checked, 0);
	assert.equal(recording.typist_signed_by_user_id, null);
	assert.equal(recording.typist_signed_at, null);
});

test('Telegram and study counters show checked and withdrawn printing confirmation', (t) => {
	const { db, studyId, sign, approve } = fixture(t);
	approve();
	sign(users.typist, 'typist');
	let detail = getStudyDetail(db, studyId);
	assert.equal(detail.typist_checked_count, 1);
	assert.match(buildStudyMessage(detail), /Typist \(printed\) 1/);
	assert.match(buildStudyMessage(detail), /Typist \/ printed ✅ \(typist\)/);
	sign(users.typist, 'typist', false);
	detail = getStudyDetail(db, studyId);
	assert.equal(detail.typist_checked_count, 0);
	assert.match(buildStudyMessage(detail), /Typist \/ printed ⬜/);
});

test('signature filters match the same recording and include empty studies only for unchecked selections', (t) => {
	const { db, studyId, recordingId } = fixture(t);
	const emptyStudyId = insertStudy(db, {
		patient_code: 'empty',
		patient_firstname: 'Synthetic',
		exam_date_jalali: '1405-07-18',
		exam_time: '11:00',
		corresponding_attending_id: 3
	});
	db.prepare('UPDATE study_recordings SET resident_checked = 1 WHERE id = ?').run(recordingId);
	const other = appendRecording(db, studyId, null);
	db.prepare('UPDATE study_recordings SET attending_checked = 1 WHERE id = ?').run(other.id);
	const filter = (values) => {
		const { sql, params } = studySignatureFilter(values);
		return db
			.prepare(`SELECT s.id FROM studies s WHERE 1=1${sql} ORDER BY s.id`)
			.all(...params)
			.map((row) => row.id);
	};
	assert.deepEqual(filter({}), [studyId, emptyStudyId]);
	assert.deepEqual(filter({ resident_checked: '1', attending_checked: '1' }), []);
	assert.deepEqual(filter({ resident_checked: '1', attending_checked: '0' }), [studyId]);
	assert.deepEqual(filter({ typist_checked: '0' }), [studyId, emptyStudyId]);
	assert.deepEqual(filter({ typist_checked: '1' }), []);
	db.prepare(
		'UPDATE study_recordings SET resident_checked = 1, attending_checked = 1, typist_checked = 1 WHERE id = ?'
	).run(recordingId);
	assert.deepEqual(
		filter({ resident_checked: '1', attending_checked: '1', typist_checked: '0' }),
		[]
	);
	assert.deepEqual(filter({ resident_checked: '1', attending_checked: '1', typist_checked: '1' }), [
		studyId
	]);
	assert.deepEqual(filter({ resident_checked: '0', attending_checked: '0', typist_checked: '0' }), [
		emptyStudyId
	]);
	for (const value of ['yes', '-1', '2', '1 OR 1=1', 1])
		assert.throws(
			() => studySignatureFilter({ typist_checked: value }),
			/Invalid signature filter/
		);
});
