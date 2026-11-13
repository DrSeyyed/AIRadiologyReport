import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { insertStudy } from '../src/lib/server/studies.js';
import { appendRecording } from '../src/lib/server/recordings.js';
import { examinationDateRange } from '../src/lib/study-date-ranges.js';
import { statisticsMetrics, statisticsPresets } from '../src/lib/study-statistics-options.js';
import { getStudyStatistics, statisticsDateRange } from '../src/lib/server/study-statistics.js';

const now = new Date('2026-11-13T10:00:00Z');
const today = examinationDateRange('today', now).date_from;
const params = (values = {}) => new URLSearchParams(values);
const admin = { id: 1, role: 'admin' };

function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	initializeSchema(db, readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
	db.exec(`INSERT INTO users(id,full_name,role) VALUES
		(1,'Administrator','admin'),(2,'First resident','resident'),(3,'First attending','attending'),
		(4,'Other resident','resident'),(5,'Other attending','attending'),(6,'First typist','typist'),
		(7,'Other typist','typist'),(8,'Unassigned resident','resident'),(9,'Unassigned attending','attending'),(10,'Unassigned typist','typist')`);
	t.after(() => db.close());
	let sequence = 0;
	const study = (input = {}) => insertStudy(db, {
		patient_code: `STAT-${++sequence}`, patient_firstname: 'Synthetic', exam_date_jalali: today,
		exam_time: '10:00', corresponding_resident_id: 2, corresponding_attending_id: 3, ...input
	});
	const recording = (studyId, { resident = 2, report = false, signatures = [0, 0, 0], typist = null } = {}) => {
		const item = appendRecording(db, studyId, null);
		db.prepare(`UPDATE study_recordings SET corresponding_resident_id=?, text_report_path=?,
			resident_checked=?,attending_checked=?,typist_checked=?,typist_signed_by_user_id=? WHERE id=?`)
			.run(resident, report ? 'reports/synthetic.docx' : null, ...signatures, typist, item.id);
		return item.id;
	};
	const query = (user = admin, values = { date_range: 'today' }) => getStudyStatistics(db, user, params(values), { now });
	return { db, study, recording, query };
}

test('statistics presets share Tehran examination dates and exclude yesterday-only option', () => {
	assert.deepEqual(statisticsPresets.map(({ value }) => value), ['today', '3-days', '7-days', '30-days', '365-days', 'custom']);
	for (const { value, label } of statisticsPresets.filter(({ value }) => value !== 'custom')) {
		const range = statisticsDateRange(params({ date_range: value }), now);
		assert.deepEqual({ date_from: range.date_from, date_to: range.date_to }, examinationDateRange(value, now));
		assert.equal(range.label, label);
		assert.equal(range.timeZone, 'Asia/Tehran');
	}
	assert.equal(statisticsDateRange(params(), now).preset, '7-days');
	const beforeMidnight = statisticsDateRange(params({ date_range: 'today' }), new Date('2026-11-12T20:29:59Z'));
	const afterMidnight = statisticsDateRange(params({ date_range: 'today' }), new Date('2026-11-12T20:30:00Z'));
	assert.notEqual(beforeMidnight.date_from, afterMidnight.date_from);
	assert.equal(afterMidnight.date_from, today);
});

test('custom ranges require valid padded Jalali dates in ascending order and reject duplicate controls', () => {
	const custom = { date_range: 'custom', date_from: '1403-12-30', date_to: '1404-01-01' };
	assert.equal(statisticsDateRange(params(custom)).date_from, '1403-12-30');
	for (const values of [
		{ date_range: 'unknown' }, { date_range: 'yesterday' },
		{ ...custom, date_from: '' }, { ...custom, date_to: '' },
		{ ...custom, date_from: '1403-1-01' }, { ...custom, date_from: '1404-12-30' },
		{ ...custom, date_from: '1403-13-01' }, { ...custom, date_from: '1403-07-31' },
		{ ...custom, date_from: '9999-01-01' }, { ...custom, date_to: '1403-12-29' },
		{ ...custom, date_to: "1404-01-01' OR 1=1--" }
	]) assert.throws(() => statisticsDateRange(params(values)), { status: 400 });
	for (const key of ['date_range', 'date_from', 'date_to']) {
		const duplicate = params(custom);
		duplicate.append(key, custom[key]);
		assert.throws(() => statisticsDateRange(duplicate), { status: 400 });
	}
	assert.equal(statisticsDateRange(params({ ...custom, date_range: 'today', date_from: 'stale', date_to: '' }), now).date_from, today);
});

test('study totals count unique studies and require reports/signatures across every recording', (t) => {
	const { db, study, recording, query } = fixture(t);
	study();
	const full = study();
	recording(full, { report: true, signatures: [1, 1, 1], typist: 6 });
	recording(full, { report: true, signatures: [1, 1, 1], typist: 6 });
	const partial = study();
	recording(partial, { report: true, signatures: [1, 1, 1], typist: 6 });
	recording(partial, { signatures: [1, 0, 0] });
	recording(study());
	const disabled = study();
	recording(disabled, { report: true, signatures: [1, 1, 1], typist: 6 });
	db.prepare('UPDATE studies SET disabled=1 WHERE id=?').run(disabled);
	const attention = study();
	db.prepare('UPDATE studies SET needs_attention=1 WHERE id=?').run(attention);
	recording(attention, { report: true, signatures: [1, 1, 1], typist: 6 });
	const emptyAttention = study();
	db.prepare('UPDATE studies SET needs_attention=1 WHERE id=?').run(emptyAttention);
	const before = db.prepare('SELECT total_changes() AS changes').get().changes;
	const result = query();
	assert.deepEqual(result.totals, {
		total: 7, active: 6, disabled: 1, needsAttention: 2, noRecording: 2,
		reported: 2, unreported: 4, fullySigned: 2, awaitingSignatures: 2,
		residentSigned: 3, attendingSigned: 2, typistSigned: 2
	});
	assert.equal(result.scope, 'all');
	assert.equal(result.totals.total, result.totals.active + result.totals.disabled);
	assert.equal(result.totals.active, result.totals.reported + result.totals.unreported);
	assert.equal(result.totals.active, result.totals.fullySigned + result.totals.awaitingSignatures + result.totals.noRecording);
	assert.equal(db.prepare('SELECT total_changes() AS changes').get().changes, before);
	assert.doesNotMatch(JSON.stringify(result), /Synthetic|STAT-|synthetic\.docx|Administrator/);
	assert.deepEqual(statisticsMetrics.map(({ key }) => key).sort(), Object.keys(result.totals).sort());
});

test('resident scope includes study and recording assignments without duplication or signer impersonation', (t) => {
	const { study, recording, query } = fixture(t);
	study();
	const recordingAssigned = study({ corresponding_resident_id: 4 });
	recording(recordingAssigned, { resident: 2 });
	recording(recordingAssigned, { resident: 2 });
	const other = study({ corresponding_resident_id: 4 });
	recording(other, { resident: 4, signatures: [1, 1, 1], typist: 7 });
	assert.equal(query({ id: 2, role: 'resident' }).totals.total, 2);
	assert.equal(query({ id: 4, role: 'resident' }).totals.total, 2);
	assert.equal(query({ id: 8, role: 'resident' }).totals.total, 0);
	assert.equal(query({ id: 2, role: 'resident' }, { date_range: 'today', user_id: '4', role: 'admin', scope: 'all' }).totals.total, 2);
	assert.equal(query({ id: 2, role: 'resident' }).scope, 'assigned');
});

test('attendings see only study assignments and typists only their current signed recordings', (t) => {
	const { db, study, recording, query } = fixture(t);
	const first = study();
	recording(first, { signatures: [1, 1, 1], typist: 6 });
	recording(first, { signatures: [1, 1, 1], typist: 6 });
	const second = study({ corresponding_attending_id: 5 });
	recording(second, { signatures: [1, 1, 1], typist: 7 });
	const stale = recording(study({ corresponding_attending_id: 5 }), { signatures: [1, 1, 0], typist: 6 });
	assert.equal(query({ id: 3, role: 'attending' }).totals.total, 1);
	assert.equal(query({ id: 5, role: 'attending' }).totals.total, 2);
	assert.equal(query({ id: 9, role: 'attending' }).totals.total, 0);
	assert.equal(query({ id: 6, role: 'typist' }).totals.total, 1);
	assert.equal(query({ id: 7, role: 'typist' }).totals.total, 1);
	assert.equal(query({ id: 10, role: 'typist' }).totals.total, 0);
	assert.equal(query({ id: 6, role: 'typist' }).scope, 'signed');
	db.prepare('UPDATE study_recordings SET typist_checked=1 WHERE id=?').run(stale);
	assert.equal(query({ id: 6, role: 'typist' }).totals.total, 2);
	db.prepare('UPDATE study_recordings SET typist_checked=0,typist_signed_by_user_id=NULL WHERE study_id=?').run(first);
	assert.equal(query({ id: 6, role: 'typist' }).totals.total, 1);
});

test('date bounds are inclusive across Jalali year changes and ignore creation/signature dates', (t) => {
	const { db, study, recording, query } = fixture(t);
	for (const date of ['1403-12-29', '1403-12-30', '1404-01-01', '1404-01-02']) {
		const id = study({ exam_date_jalali: date });
		recording(id, { report: true, signatures: [1, 1, 1], typist: 6 });
	}
	const result = query(admin, { date_range: 'custom', date_from: '1403-12-30', date_to: '1404-01-01' });
	assert.equal(result.totals.total, 2);
	assert.equal(result.totals.fullySigned, 2);
	assert.equal(query(admin, { date_range: 'custom', date_from: '1404-01-01', date_to: '1404-01-01' }).totals.total, 1);
	assert.equal(query().totals.total, 0);
	db.exec("UPDATE study_recordings SET created_at='2026-11-13T10:00:00Z', resident_signed_at='2026-11-13T10:00:00Z'");
	assert.equal(query().totals.total, 0);
});

test('report and signing updates change current statistics without changing the examination range', (t) => {
	const { db, study, recording, query } = fixture(t);
	const id = recording(study());
	db.prepare('UPDATE study_recordings SET text_report_path=? WHERE id=?').run(' \t\r\n ', id);
	assert.equal(query().totals.reported, 0);
	assert.equal(query().totals.unreported, 1);
	db.prepare(`UPDATE study_recordings SET text_report_path='report.docx', resident_checked=1,
		attending_checked=1, typist_checked=1, resident_signed_at='2000-01-01' WHERE id=?`).run(id);
	assert.equal(query().totals.reported, 1);
	assert.equal(query().totals.fullySigned, 1);
	db.prepare('UPDATE study_recordings SET attending_checked=0 WHERE id=?').run(id);
	assert.equal(query().totals.fullySigned, 0);
	assert.equal(query().totals.awaitingSignatures, 1);
});

test('empty datasets return numeric zeros and invalid identities are rejected before database access', (t) => {
	const { query } = fixture(t);
	assert.ok(Object.values(query().totals).every((value) => value === 0));
	assert.throws(() => getStudyStatistics(null, null), { status: 401 });
	for (const user of [{ id: 1, role: 'unknown' }, { id: 0, role: 'admin' }, { id: '1', role: 'admin' }, { id: 1.5, role: 'resident' }, { id: 1 }]) {
		assert.throws(() => getStudyStatistics(null, user), { status: 403 });
	}
});
