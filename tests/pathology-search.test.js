import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { insertStudy } from '../src/lib/server/studies.js';
import { appendRecording } from '../src/lib/server/recordings.js';
import { pathologyQuery, matchPathologyReport } from '../src/lib/pathology-search.js';
import { pathologyFilters, pathologyModalities, readPathologyReport, searchPathologyReports } from '../src/lib/server/pathology-search.js';
import { examinationDateRange } from '../src/lib/study-date-ranges.js';

const now = new Date('2026-11-13T10:00:00Z');
const params = (values = {}) => new URLSearchParams(values);
const admin = { id: 1, role: 'admin' };
const matches = (text, query = 'hemangioma') => matchPathologyReport(text, pathologyQuery(query));

function fixture(t) {
	const db = new Database(':memory:');
	initializeSchema(db, readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
	db.exec("INSERT INTO users(id,full_name,role) VALUES (1,'Synthetic administrator','admin')");
	const directory = mkdtempSync(join(process.cwd(), '.pathology-test-'));
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
		for (const text of ['There is HCC.', 'There is hepatocellular carcinoma.']) assert.equal(matches(text, query).length, 1);
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
	assert.deepEqual(matches('No ascites. There is a liver hemangioma.', 'liver hemangioma'), [{ excerpt: 'There is a liver hemangioma.' }]);
	assert.deepEqual(matches('There is a hepatic 2.3 cm hemangioma.', 'liver hemangioma'), [{ excerpt: 'There is a hepatic 2.3 cm hemangioma.' }]);
});

test('all matching wording is returned without interpreting or classifying it', () => {
	for (const text of [
		'There is no hepatic hemangioma.', 'Without evidence of hemangioma.',
		'Hepatic hemangioma is not seen.', 'Negative for hemangioma.',
		'Possible hepatic hemangioma.', 'Cannot exclude a hemangioma.',
		'Hemangioma cannot be excluded.', 'Hemangioma?',
		'History of hepatic hemangioma.', 'Previously treated hemangioma.',
		'No interval change in hepatic hemangioma.', 'No new hepatic hemangioma.',
		'No cyst and hepatic hemangioma.', 'Hepatic hemangioma.',
		'There is a hepatic hemangioma.', 'Hepatic hemangioma is identified.'
	]) assert.deepEqual(matches(text), [{ excerpt: text }]);
	const report = 'Clinical history: HCC\nFindings:\nNo evidence of HCC.\nImpression:\nThere is a hepatic hemangioma.';
	assert.deepEqual(matches(report, 'HCC'), [{ excerpt: 'Clinical history: HCC' }, { excerpt: 'No evidence of HCC.' }]);
});

test('complete sentences preserve clauses, punctuation and decimal measurements without duplicate hits', () => {
	const sentence = 'No ascites; however there is a 2.3 cm hepatic hemangioma, without suspicious features.';
	assert.deepEqual(matches(`Kidneys are normal. ${sentence} Spleen is normal!`, 'liver hemangioma'), [{ excerpt: sentence }]);
	assert.deepEqual(matches('No hemangioma, but a hemangioma cannot be excluded.'), [{ excerpt: 'No hemangioma, but a hemangioma cannot be excluded.' }]);
	assert.deepEqual(matches('Hemangioma? No HCC.', 'hemangioma'), [{ excerpt: 'Hemangioma?' }]);
});

test('long matching sentences are returned completely rather than clipped', () => {
	const report = `${'x'.repeat(80000)} There is a hepatic haemangioma ${'y'.repeat(80000)}.`;
	assert.deepEqual(matches(report, 'liver hemangioma'), [{ excerpt: report }]);
});

test('date bounds validate Jalali dates and preserve Tehran preset semantics', () => {
	const custom = { date_range: 'custom', date_from: '1403-12-30', date_to: '1404-01-01' };
	assert.equal(pathologyFilters(params(custom)).filters.date_from, '1403-12-30');
	for (const input of [
		{ ...custom, date_from: '1404-12-30' }, { ...custom, date_to: '1403-12-29' },
		{ ...custom, date_from: '1405-1-01' }, { ...custom, date_to: '' },
		{ date_range: 'invalid' }, { page: '1.2' }, { page: '0' }, { page: '1000001' }
	]) assert.throws(() => pathologyFilters(params(input)), { status: 400 });
	for (const key of ['q', 'modality', 'date_range', 'date_from', 'date_to', 'page']) {
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
	assert.deepEqual(result.rows.map((row) => row.mentions), [
		[{ excerpt: 'Possible hepatic hemangioma.' }],
		[{ excerpt: 'No hepatic hemangioma.' }],
		[{ excerpt: 'There is a hepatic haemangioma.' }]
	]);
	assert.equal(result.rows[0].disabled, 1);
	assert.equal(result.rows[1].attending_checked, 1);
	assert.equal(result.rows[2].attending_checked, 0);
	assert.doesNotMatch(JSON.stringify(result), /text_report_path|pathology-test-/);
	const legacy = await search({ ...input, context: 'present' });
	assert.equal(legacy.total, 3);
	assert.equal(Object.hasOwn(legacy.filters, 'context'), false);
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

test('modality filters use examination source values before study fallback, never recording templates', async (t) => {
	const { db, add, search } = fixture(t);
	db.exec("INSERT INTO modalities(id,code,name) VALUES (1,'CT','CT'),(2,'MR','MR'),(3,'US','US'),(4,'Unused','Unused')");
	const setStudy = db.prepare('UPDATE studies SET source_modality=?,modality_id=? WHERE id=?');
	const setRecording = db.prepare('UPDATE study_recordings SET modality_id=? WHERE id=?');
	const first = add('Hepatic hemangioma.', { signed: 1 });
	setStudy.run(' ct ', 2, first.studyId);
	setRecording.run(3, first.recordingId);
	add('No hepatic hemangioma.', { studyId: first.studyId });
	for (let i = 0; i < 21; i++) {
		const item = add('Possible hepatic hemangioma.', { disabled: i === 0 ? 1 : 0 });
		setStudy.run(i % 2 ? null : '   ', 1, item.studyId);
	}
	const mr = add('Hepatic hemangioma.');
	setStudy.run('MR', 1, mr.studyId);
	setRecording.run(1, mr.recordingId);
	const imported = add('Hepatic hemangioma.');
	setStudy.run(' dx ', null, imported.studyId);
	const old = add('Hepatic hemangioma.', { date: '1405-08-21' });
	setStudy.run('CT', null, old.studyId);
	const unknown = add('Hepatic hemangioma.');
	setRecording.run(1, unknown.recordingId);
	const unreadable = add(null);
	setStudy.run('MR', 2, unreadable.studyId);
	const changes = db.prepare('SELECT total_changes() AS count').get().count;
	assert.deepEqual(pathologyModalities(db), ['CT', 'DX', 'MR']);
	const filter = { modality: ' ct ', date_range: 'custom', date_from: '1405-08-22', date_to: '1405-08-22' };
	const readPaths = [];
	const options = { readReport: async (path) => { readPaths.push(path); return 'Hepatic hemangioma.'; } };
	const firstPage = await search(filter, options);
	const secondPage = await search({ ...filter, page: '2' });
	assert.equal(firstPage.filters.modality, 'CT');
	assert.equal(firstPage.total, 23);
	assert.equal(firstPage.scanned, 23);
	assert.equal(firstPage.unavailable, 0);
	assert.equal(readPaths.length, 23);
	assert.ok(!readPaths.includes(mr.path) && !readPaths.includes(old.path) && !readPaths.includes(unreadable.path));
	assert.equal(secondPage.totalPages, 2);
	assert.equal(secondPage.rows.length, 3);
	assert.equal(new Set([...firstPage.rows, ...secondPage.rows].map((row) => row.recording_id)).size, 23);
	assert.equal(secondPage.rows.filter((row) => row.study_id === first.studyId).length, 2);
	assert.ok([...firstPage.rows, ...secondPage.rows].some((row) => row.disabled));
	assert.ok(secondPage.rows.some((row) => row.attending_checked));
	assert.ok([...firstPage.rows, ...secondPage.rows].every((row) => row.source_modality === 'CT'));
	assert.equal((await search({ modality: 'MR' })).total, 1);
	assert.equal((await search({ modality: 'DX' })).rows[0].study_id, imported.studyId);
	assert.equal((await search({ modality: 'US' })).scanned, 0);
	assert.equal((await search({ modality: "CT' OR 1=1 --" })).total, 0);
	assert.equal((await search()).total, 27);
	assert.equal(db.prepare('SELECT total_changes() AS count').get().count, changes);
});

test('modality validation normalizes input and rejects malformed values before database access', async () => {
	assert.equal(pathologyFilters(params()).filters.modality, '');
	assert.equal(pathologyFilters(params({ modality: ' mr ' })).filters.modality, 'MR');
	for (const modality of ['x'.repeat(65), 'CT\u0000MR', 'CT\u200b']) {
		await assert.rejects(searchPathologyReports({ prepare() { assert.fail('Unexpected database access'); } }, admin, params({ q: 'HCC', modality })), { status: 400 });
	}
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
