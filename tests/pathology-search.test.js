import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { insertStudy } from '../src/lib/server/studies.js';
import { appendRecording } from '../src/lib/server/recordings.js';
import { pathologyQuery, matchPathologyReport } from '../src/lib/pathology-search.js';
import { pathologyFilters, readPathologyReport, searchPathologyReports } from '../src/lib/server/pathology-search.js';
import { examinationDateRange } from '../src/lib/study-date-ranges.js';

const now = new Date('2026-11-13T10:00:00Z');
const params = (values = {}) => new URLSearchParams(values);
const admin = { id: 1, role: 'admin' };
const matches = (text, query = 'hemangioma') => matchPathologyReport(text, pathologyQuery(query));

function fixture(t) {
	const db = new Database(':memory:');
	initializeSchema(db, readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
	db.exec("INSERT INTO users(id,full_name,role) VALUES (1,'Synthetic administrator','admin')");
	const directory = mkdtempSync(join(tmpdir(), 'pathology-test-'));
	t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
	let count = 0;
	const add = (text, { date = '1405-08-22', signed = 0, disabled = 0, studyId } = {}) => {
		const id = studyId || insertStudy(db, { patient_code: `SYNTHETIC-${++count}`, patient_fullname: 'Synthetic patient', exam_date_jalali: date, exam_time: '10:00' });
		const recording = appendRecording(db, id, null);
		const path = join(directory, `${recording.id}.txt`);
		if (text !== null) writeFileSync(path, text, 'utf8');
		db.prepare('UPDATE study_recordings SET text_report_path=?,attending_checked=? WHERE id=?').run(path, signed, recording.id);
		if (disabled) db.prepare('UPDATE studies SET disabled=1 WHERE id=?').run(id);
		return { studyId: id, recordingId: recording.id, path };
	};
	const search = (values = {}, options = {}) => searchPathologyReports(db, admin, params({ q: 'hemangioma', ...values }), { now, readReport: (path) => readPathologyReport(path, directory), ...options });
	return { db, directory, add, search };
}

test('curated spelling, plural, abbreviation and full-name expansions are symmetric and whole-word', () => {
	for (const query of ['hemangioma', 'haemangioma', 'heamngioma', 'hemangiomas']) {
		for (const text of ['Hepatic hemangioma.', 'Hepatic haemangiomas.']) assert.equal(matches(text, query).length, 1);
	}
	for (const query of ['HCC', 'hepatocellular carcinoma']) {
		for (const text of ['There is HCC.', 'There is hepatocellular carcinoma.']) assert.equal(matches(text, query)[0].context, 'present');
		for (const text of ['THCC', 'HCC123', 'hepatocellular adenoma']) assert.equal(matches(text, query).length, 0);
	}
	assert.equal(matches('There is oedema.', 'edema').length, 1);
	assert.equal(matches('There is a hepatic tumour.', 'liver tumor').length, 1);
	assert.equal(matches('There is foobar.', 'Foobar').length, 1);
	assert.equal(matches('There is foobars.', 'foobar').length, 0);
	assert.equal(matches('هیپاتیک همانژیوم', 'همانژیوم').length, 1);
	for (const query of ['', '!!!', 'the and of', 'x'.repeat(161), Array(14).fill('word').join(' ')]) assert.throws(() => pathologyQuery(query));
});

test('organ + pathology requires co-occurrence in a clause and rejects a closer conflicting organ', () => {
	for (const query of ['liver hemangioma', 'hepatic haemangioma', 'hemangioma in the liver']) {
		assert.equal(matches('There is a hepatic haemangioma.', query).length, 1);
		for (const text of ['Vertebral hemangioma.', 'Liver is normal. Vertebral hemangioma.', 'Liver normal; vertebral hemangioma.', 'The liver is normal and there is a vertebral hemangioma.']) assert.equal(matches(text, query).length, 0);
	}
	assert.equal(matches('No ascites. There is a liver hemangioma.', 'liver hemangioma')[0].context, 'present');
	assert.equal(matches('There is a hepatic 2.3 cm hemangioma.', 'liver hemangioma')[0].context, 'present');
});

test('negation, uncertainty and history do not become positive findings', () => {
	const cases = [
		['There is no hepatic hemangioma.', 'absent'], ['Without evidence of hemangioma.', 'absent'],
		['Hepatic hemangioma is not seen.', 'absent'], ['Negative for hemangioma.', 'absent'],
		['Possible hepatic hemangioma.', 'suspected'], ['Cannot exclude a hemangioma.', 'suspected'],
		['Hemangioma cannot be excluded.', 'suspected'], ['Hemangioma?', 'suspected'],
		['History of hepatic hemangioma.', 'historical'], ['Previously treated hemangioma.', 'historical'],
		['No interval change in hepatic hemangioma.', 'unclassified'], ['No new hepatic hemangioma.', 'unclassified'],
		['No cyst and hepatic hemangioma.', 'unclassified'], ['Hepatic hemangioma.', 'unclassified'],
		['There is a hepatic hemangioma.', 'present'], ['Hepatic hemangioma is identified.', 'present']
	];
	for (const [text, expected] of cases) assert.equal(matches(text)[0].context, expected, text);
	const report = 'Clinical history: HCC\nFindings:\nNo evidence of HCC.\nImpression:\nThere is a hepatic hemangioma.';
	assert.deepEqual(matches(report, 'HCC').map((match) => match.context), ['historical', 'absent']);
	assert.equal(matches(report)[0].context, 'present');
});

test('large single-line excerpts stay bounded and retain the matched pathology', () => {
	const report = `${'x'.repeat(80000)} There is a hepatic haemangioma ${'y'.repeat(80000)}`;
	const result = matches(report, 'liver hemangioma');
	assert.equal(result.length, 1);
	assert.equal(result[0].context, 'present');
	assert.ok(result[0].excerpt.length <= 704);
	assert.match(result[0].excerpt, /hepatic haemangioma/);
});

test('date bounds validate Jalali dates and preserve Tehran preset semantics', () => {
	const custom = { date_range: 'custom', date_from: '1403-12-30', date_to: '1404-01-01' };
	assert.equal(pathologyFilters(params(custom)).filters.date_from, '1403-12-30');
	for (const input of [
		{ ...custom, date_from: '1404-12-30' }, { ...custom, date_to: '1403-12-29' },
		{ ...custom, date_from: '1405-1-01' }, { ...custom, date_to: '' },
		{ date_range: 'invalid' }, { context: 'invalid' }, { page: '1.2' }, { page: '0' }, { page: '1000001' }
	]) assert.throws(() => pathologyFilters(params(input)), { status: 400 });
	for (const key of ['q', 'date_range', 'date_from', 'date_to', 'context', 'page']) {
		const duplicate = params({ [key]: 'x' }); duplicate.append(key, 'y');
		assert.throws(() => pathologyFilters(duplicate), { status: 400 });
	}
	const today = pathologyFilters(params({ date_range: 'today', date_from: 'stale', date_to: 'stale' }), now).filters;
	assert.equal(today.date_from, examinationDateRange('today', now).date_from);
	assert.equal(pathologyFilters(params({ date_range: 'all', date_from: 'stale' })).filters.date_from, '');
});

test('search includes drafts, signed reports and disabled studies, with inclusive examination dates and safe output', async (t) => {
	const { db, add, search } = fixture(t);
	add('There is a hepatic haemangioma.', { date: '1405-08-21' });
	add('No hepatic hemangioma.', { date: '1405-08-22', signed: 1 });
	add('Possible hepatic hemangioma.', { date: '1405-08-23', disabled: 1 });
	add('There is a liver hemangioma.', { date: '1405-08-24' });
	add(null);
	add('');
	const changes = db.prepare('SELECT total_changes() AS count').get().count;
	const input = { q: 'liver hemangioma', date_range: 'custom', date_from: '1405-08-21', date_to: '1405-08-23' };
	const result = await search(input);
	assert.equal(result.total, 3);
	assert.equal(result.scanned, 5);
	assert.equal(result.unavailable, 2);
	assert.deepEqual(result.rows.map((row) => row.mentions[0].context), ['suspected', 'absent', 'present']);
	assert.equal(result.rows[0].disabled, 1);
	assert.equal(result.rows[1].attending_checked, 1);
	assert.equal(result.rows[2].attending_checked, 0);
	assert.doesNotMatch(JSON.stringify(result), /text_report_path|pathology-test-/);
	assert.equal((await search({ ...input, context: 'present' })).total, 1);
	assert.equal((await search({ ...input, context: 'absent' })).total, 1);
	assert.equal(db.prepare('SELECT total_changes() AS count').get().count, changes);
});

test('search pagination counts reports, retains independent recording matches, and does not truncate the corpus', async (t) => {
	const { add, search } = fixture(t);
	const first = add('There is HCC.');
	add('Hepatocellular carcinoma is identified.', { studyId: first.studyId });
	for (let i = 0; i < 21; i++) add('There is HCC.');
	const result = await search({ q: 'HCC' });
	assert.equal(result.total, 23);
	assert.equal(result.totalPages, 2);
	assert.equal(result.rows.length, 20);
	const second = await search({ q: 'HCC', page: '2' });
	assert.equal(second.rows.length, 3);
	assert.equal(new Set([...result.rows, ...second.rows].map((row) => row.recording_id)).size, 23);
	assert.equal(second.rows.filter((row) => row.study_id === first.studyId).length, 2);
});

test('search reflects report edits and deletions immediately without a stale text index', async (t) => {
	const { db, add, search } = fixture(t);
	const item = add('There is HCC.', { signed: 1 });
	assert.equal((await search({ q: 'HCC' })).total, 1);
	const replacement = join(item.path, '..', 'replacement.txt');
	writeFileSync(replacement, 'There is a hepatic hemangioma.');
	db.prepare('UPDATE study_recordings SET text_report_path=?,attending_checked=0 WHERE id=?').run(replacement, item.recordingId);
	assert.equal((await search({ q: 'HCC' })).total, 0);
	assert.equal((await search()).rows[0].attending_checked, 0);
	db.prepare('DELETE FROM study_recordings WHERE id=?').run(item.recordingId);
	assert.equal((await search()).total, 0);
});

test('authorization precedes database access and supported roles keep existing read access', async (t) => {
	for (const user of [null, {}, { id: 1, role: 'unknown' }, { id: '1', role: 'admin' }]) {
		await assert.rejects(searchPathologyReports({ prepare() { assert.fail('Unexpected database access'); } }, user, params()), { status: user ? 403 : 401 });
	}
	const { db, add, directory } = fixture(t);
	add('There is HCC.');
	for (const role of ['admin', 'resident', 'attending', 'typist']) {
		const result = await searchPathologyReports(db, { id: 1, role }, params({ q: 'HCC' }), { readReport: (path) => readPathologyReport(path, directory) });
		assert.equal(result.total, 1);
	}
	const empty = await searchPathologyReports({ prepare() { assert.fail('Initial page must not scan reports'); } }, admin, params());
	assert.equal(empty.searched, false);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(searchPathologyReports(db, admin, params({ q: 'HCC' }), { signal: controller.signal }), { name: 'AbortError' });
});

test('file reader confines reads to uploads and rejects oversized or missing reports', async (t) => {
	const { directory, add } = fixture(t);
	const item = add('Synthetic report');
	assert.equal(await readPathologyReport(item.path, directory), 'Synthetic report');
	await assert.rejects(readPathologyReport(join(process.cwd(), 'package.json'), directory));
	const large = join(directory, 'large.txt'); writeFileSync(large, Buffer.alloc(1024 * 1024 + 1));
	await assert.rejects(readPathologyReport(large, directory), /searchable size/);
	await assert.rejects(readPathologyReport(join(directory, 'missing.txt'), directory));
});
