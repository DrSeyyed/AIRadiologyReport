import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { insertStudy } from '../src/lib/server/studies.js';
import { appendRecording } from '../src/lib/server/recordings.js';
import { examinationDateRange, studyDatePresets } from '../src/lib/study-date-ranges.js';
import { saveStudyFavorite } from '../src/lib/server/study-favorites.js';
import { studyRowStatus, studyRowStatuses } from '../src/lib/study-row-status.js';

async function loadModule(relativePath, dbKey) {
	const url = new URL(relativePath, import.meta.url);
	const source = readFileSync(url, 'utf8').replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
		let resolved;
		if (specifier === '$lib/server/db')
			resolved = `data:text/javascript,${encodeURIComponent(`export function getDb(){return globalThis[${JSON.stringify(dbKey)}]}`)}`;
		else if (specifier.startsWith('$lib/')) resolved = new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href;
		else resolved = import.meta.resolve(specifier);
		return `from ${JSON.stringify(resolved)}`;
	});
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

async function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	initializeSchema(db, readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
	db.exec("INSERT INTO users(id,full_name,role) VALUES(1,'Admin','admin'),(2,'Alpha Resident','resident'),(3,'First Attending','attending'),(4,'Beta Resident','resident'),(5,'Second Attending','attending');");
	const key = `studyReviewerDb_${randomUUID()}`;
	globalThis[key] = db;
	t.after(() => { delete globalThis[key]; db.close(); });
	const study = (code, attending = 3) => insertStudy(db, {
		patient_code: code,
		patient_firstname: 'Synthetic',
		exam_date_jalali: '1405-07-21',
		exam_time: '10:00',
		corresponding_attending_id: attending
	});
	const multi = study('MULTI'), other = study('OTHER', 5), beta = study('BETA'), empty = study('EMPTY'), unassigned = study('UNASSIGNED');
	const recording = (studyId, resident, signed = false) => {
		const item = appendRecording(db, studyId, null);
		db.prepare('UPDATE study_recordings SET corresponding_resident_id = ?, resident_checked = ?, attending_checked = ?, typist_checked = ? WHERE id = ?')
			.run(resident, Number(signed), Number(signed), Number(signed), item.id);
	};
	recording(multi, 2);
	recording(multi, 4, true);
	recording(multi, 2);
	recording(other, 2, true);
	recording(beta, 4);
	recording(unassigned, null);
	db.prepare('UPDATE studies SET corresponding_resident_id = 2 WHERE id = ?').run(empty);
	const { GET } = await loadModule('../src/routes/api/studies/+server.js', key);
	const request = async (filters = {}, user = { id: 1, role: 'admin' }) => {
		const response = await GET({ url: new URL(`http://localhost/api/studies?${new URLSearchParams(filters)}`), locals: { user } });
		return { status: response.status, ...await response.json() };
	};
	return { db, key, GET, request, multi, other, beta, empty, unassigned };
}

test('study list returns all distinct recording residents, not a stale study-level assignment', async (t) => {
	const { request, multi, empty, unassigned } = await fixture(t);
	const result = await request();
	assert.equal(result.status, 200);
	assert.equal(result.total, 5);
	assert.deepEqual(result.rows.find((row) => row.id === multi).residents, [
		{ id: 2, full_name: 'Alpha Resident' }, { id: 4, full_name: 'Beta Resident' }
	]);
	assert.deepEqual(result.rows.find((row) => row.id === empty).residents, []);
	assert.deepEqual(result.rows.find((row) => row.id === unassigned).residents, []);
});

test('attending and resident selectors filter count and pagination without duplicated studies', async (t) => {
	const { request, multi, other } = await fixture(t);
	const first = await request({ corresponding_resident_id: '2', rowcount: '1', page: '1' });
	assert.equal(first.total, 2);
	assert.equal(first.rows.length, 1);
	assert.equal(first.rows[0].id, other);
	const second = await request({ corresponding_resident_id: '2', rowcount: '1', page: '2' });
	assert.equal(second.total, 2);
	assert.equal(second.rows[0].id, multi);
	assert.equal(second.rows[0].residents.length, 2);
	const combined = await request({ corresponding_resident_id: '2', corresponding_attending_id: '3' });
	assert.deepEqual(combined.rows.map((row) => row.id), [multi]);
	assert.equal((await request({ corresponding_attending_id: '5' })).total, 1);
	assert.equal((await request({ corresponding_resident_id: '999' })).total, 0);
	assert.equal((await request({ corresponding_attending_id: '999' })).total, 0);
});

test('signature filters must match the selected resident on the same recording', async (t) => {
	const { request, multi, other, empty } = await fixture(t);
	const checked = await request({ corresponding_resident_id: '2', resident_checked: '1', attending_checked: '1', typist_checked: '1' });
	assert.deepEqual(checked.rows.map((row) => row.id), [other]);
	const pending = await request({ corresponding_resident_id: '2', resident_checked: '0' });
	assert.deepEqual(pending.rows.map((row) => row.id), [multi]);
	assert.equal((await request({ corresponding_resident_id: '2', corresponding_attending_id: '3', resident_checked: '1' })).total, 0);
	const withoutResident = await request({ resident_checked: '0' });
	assert.ok(withoutResident.rows.some((row) => row.id === empty));
});

test('reviewer filters reject invalid IDs and keep authentication enforcement', async (t) => {
	const { request } = await fixture(t);
	for (const key of ['corresponding_resident_id', 'corresponding_attending_id']) {
		for (const value of ['0', '-1', '2.5', 'abc', '2 OR 1=1', '9007199254740992'])
			assert.equal((await request({ [key]: value })).status, 400, `${key}: ${value}`);
	}
	assert.equal((await request({}, null)).status, 401);
	assert.equal((await request({}, { id: 4, role: 'typist' })).status, 200);
});

test('page load forwards and preserves both reviewer selections along with signature and paging filters', async (t) => {
	const { key, GET } = await fixture(t);
	const { load } = await loadModule('../src/routes/studies/+page.server.js', key);
	const locals = { user: { id: 1, role: 'admin' } };
	const url = new URL('http://localhost/studies?corresponding_resident_id=2&corresponding_attending_id=3&resident_checked=0&rowcount=10');
	let query;
	const data = await load({ locals, url, fetch: async (path) => {
		if (path.startsWith('/api/studies?')) {
			query = new URL(path, url);
			return GET({ locals, url: query });
		}
		const rows = path === '/api/users?role=resident' ? [{ id: 2, full_name: 'Alpha Resident' }]
			: path === '/api/users?role=attending' ? [{ id: 3, full_name: 'First Attending' }] : [];
		return Response.json(rows);
	} });
	for (const key of ['corresponding_resident_id', 'corresponding_attending_id', 'resident_checked']) {
		assert.equal(query.searchParams.get(key), url.searchParams.get(key));
		assert.equal(data.filters[key], url.searchParams.get(key));
	}
	assert.equal(data.residents[0].id, 2);
	assert.equal(data.attendings[0].id, 3);
	assert.equal(data.studies.length, 1);
	assert.equal(data.paging.total, 1);
	assert.equal(data.paging.rowcount, 10);
});

test('date presets filter examination dates inclusively before pagination and combine with reviewers', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-18T12:00:00Z') });
	const { db, request, multi, other, beta, empty, unassigned } = await fixture(t);
	const dates = ['1405-07-26', '1405-07-25', '1405-07-24', '1405-07-19', '1405-07-27'];
	for (const [index, id] of [multi, other, beta, empty, unassigned].entries())
		db.prepare('UPDATE studies SET exam_date_jalali = ? WHERE id = ?').run(dates[index], id);
	for (const preset of studyDatePresets) {
		const bounds = examinationDateRange(preset.value);
		const expected = dates.filter((date) => date >= bounds.date_from && date <= bounds.date_to).length;
		const result = await request({ date_range: preset.value, rowcount: '1', date_from: '9999-01-01' });
		assert.equal(result.status, 200, preset.value);
		assert.equal(result.total, expected, preset.value);
		assert.equal(result.rows.length, Math.min(1, expected));
		assert.deepEqual(result.date_bounds, bounds);
	}
	const combined = await request({ date_range: '3-days', corresponding_attending_id: '3', corresponding_resident_id: '2', resident_checked: '0' });
	assert.deepEqual(combined.rows.map((row) => row.id), [multi]);
	const custom = await request({ date_from: dates[2], date_to: dates[1] });
	assert.deepEqual(custom.rows.map((row) => row.id), [other, beta]);
	assert.equal((await request({ date_range: 'last-century' })).status, 400);
});

test('column sorting uses displayed text, chronological date/time and age units across all pages', async (t) => {
	const { db, request, multi, other, beta, empty, unassigned } = await fixture(t);
	const ids = [multi, other, beta, empty, unassigned];
	const names = ['Zulu', 'Alpha', 'Echo', 'Bravo', 'Delta'];
	const modalities = ['US', 'CT', 'XR', 'MR', 'XA'];
	const descriptions = ['Fifth', 'First', 'Third', 'Fourth', 'Second'];
	const ages = [[1, 'Y'], [11, 'M'], [30, 'W'], [150, 'D'], [2, 'Y']];
	for (const [index, id] of ids.entries()) {
		db.prepare('UPDATE studies SET patient_fullname = ?, source_modality = ?, source_description = ?, patient_age = ?, patient_age_unit = ?, exam_time = ? WHERE id = ?')
			.run(names[index], modalities[index], descriptions[index], ...ages[index], `0${9 - index}:00`, id);
	}
	const check = async (column, expected) => {
		for (const direction of ['ASC', 'DESC']) {
			const order = direction === 'ASC' ? expected : [...expected].reverse();
			const all = await request({ orderedby: column, orderdir: direction });
			assert.deepEqual(all.rows.map((row) => row.id), order, `${column} ${direction}`);
			const second = await request({ orderedby: column, orderdir: direction, rowcount: '2', page: '2' });
			assert.equal(second.total, ids.length);
			assert.deepEqual(second.rows.map((row) => row.id), order.slice(2, 4));
		}
	};
	await check('s.patient_fullname', [other, empty, unassigned, beta, multi]);
	await check('p.firstname', [other, empty, unassigned, beta, multi]);
	await check('s.patient_code', [beta, empty, multi, other, unassigned]);
	await check('source_modality', [other, empty, multi, unassigned, beta]);
	await check('source_description', [multi, other, empty, unassigned, beta]);
	await check('s.patient_age', [empty, beta, other, multi, unassigned]);
	await check('s.exam_date_jalali', [unassigned, empty, beta, other, multi]);
	const invalid = await request({ orderedby: 's.id; DROP TABLE studies', orderdir: 'ASC' });
	assert.deepEqual(invalid.rows.map((row) => row.id), [unassigned, empty, beta, other, multi]);
	assert.equal(db.prepare('SELECT count(*) AS n FROM studies').get().n, 5);
});

test('aggregate columns, recording residents, attending names and private favorites sort server-side', async (t) => {
	const { db, request, multi, other, beta, empty } = await fixture(t);
	db.prepare("UPDATE study_recordings SET text_report_path = 'synthetic-report.md' WHERE study_id = ?").run(multi);
	saveStudyFavorite(db, 1, other, []);
	saveStudyFavorite(db, 4, multi, []);
	for (const column of ['recording_count', 'report_count', 'resident_checked_count', 'attending_checked_count', 'typist_checked_count']) {
		for (const direction of ['ASC', 'DESC']) {
			const result = await request({ orderedby: column, orderdir: direction });
			const values = result.rows.map((row) => row[column]);
			assert.deepEqual(values, [...values].sort((a, b) => direction === 'ASC' ? a - b : b - a), `${column} ${direction}`);
			assert.ok(new Set(values).size > 1);
		}
	}
	const resident = await request({ orderedby: 'residents', orderdir: 'ASC' });
	assert.ok(resident.rows.findIndex((row) => row.id === empty) < resident.rows.findIndex((row) => row.id === other));
	assert.ok(resident.rows.findIndex((row) => row.id === other) < resident.rows.findIndex((row) => row.id === multi));
	assert.ok(resident.rows.findIndex((row) => row.id === multi) < resident.rows.findIndex((row) => row.id === beta));
	const attending = await request({ orderedby: 'attending_fullname', orderdir: 'DESC' });
	assert.equal(attending.rows[0].id, other);
	for (const [userId, favorite] of [[1, other], [4, multi]]) {
		const user = { id: userId, role: userId === 1 ? 'admin' : 'resident' };
		assert.equal((await request({ orderedby: 'is_favorite', orderdir: 'DESC', rowcount: '1' }, user)).rows[0].id, favorite);
		const asc = await request({ orderedby: 'is_favorite', orderdir: 'ASC' }, user);
		assert.equal(asc.rows.at(-1).id, favorite);
		assert.equal(asc.rows.filter((row) => row.is_favorite).length, 1);
	}
	assert.equal((await request({ orderedby: 'is_favorite', favorites: 'all', corresponding_resident_id: '2' })).rows[0].id, other);
});

test('page load retains date presets, effective Jalali bounds and header sort selections', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-18T12:00:00Z') });
	const { key, GET } = await fixture(t);
	const { load } = await loadModule('../src/routes/studies/+page.server.js', key);
	const locals = { user: { id: 1, role: 'admin' } };
	const url = new URL('http://localhost/studies?date_range=7-days&date_from=1400-01-01&orderedby=report_count&orderdir=ASC&rowcount=10');
	let query;
	const data = await load({ locals, url, fetch: async (path) => {
		if (!path.startsWith('/api/studies?')) return Response.json([]);
		query = new URL(path, url);
		return GET({ locals, url: query });
	} });
	assert.equal(query.searchParams.get('date_range'), '7-days');
	assert.equal(data.filters.date_range, '7-days');
	assert.equal(data.filters.date_from, '1405-07-20');
	assert.equal(data.filters.date_to, '1405-07-26');
	assert.equal(data.paging.orderedby, 'report_count');
	assert.equal(data.paging.orderdir, 'ASC');
	assert.equal(data.paging.total, 5);
});

test('status filters match row colors with disabled and attention taking precedence', async (t) => {
	const { db, request, multi, other, empty, unassigned } = await fixture(t);
	for (const disabled of [0, 1]) {
		for (const attention of [0, 1]) {
			db.prepare('UPDATE studies SET disabled = ?, needs_attention = ? WHERE id IN (?, ?, ?, ?)')
				.run(disabled, attention, multi, other, empty, unassigned);
			const all = await request();
			assert.equal(all.total, 5);
			for (const { key } of studyRowStatuses) {
				const filtered = await request({ status: key });
				const expected = all.rows.filter((row) => studyRowStatus(row) === key);
				assert.equal(filtered.status, 200);
				assert.equal(filtered.total, expected.length, `${key}: disabled=${disabled}, attention=${attention}`);
				assert.deepEqual(filtered.rows.map((row) => row.id), expected.map((row) => row.id));
			}
		}
	}
	for (const role of ['resident', 'attending', 'typist']) {
		db.prepare('UPDATE studies SET disabled = 0, needs_attention = 0').run();
		db.prepare('UPDATE study_recordings SET resident_checked = 1, attending_checked = 1, typist_checked = 1').run();
		db.prepare(`UPDATE study_recordings SET ${role}_checked = 0 WHERE study_id = ?`).run(multi);
		assert.deepEqual((await request({ status: 'unsigned' })).rows.map((row) => row.id), [multi]);
	}
});

test('status filtering combines with existing filters before totals and pagination', async (t) => {
	const { db, request, multi, beta, empty } = await fixture(t);
	const first = await request({ status: 'unsigned', rowcount: '1' });
	const second = await request({ status: 'unsigned', rowcount: '1', page: '2' });
	assert.equal(first.total, 3);
	assert.equal(first.rows.length, 1);
	assert.equal(second.total, 3);
	assert.notEqual(first.rows[0].id, second.rows[0].id);
	assert.deepEqual((await request({ status: 'unsigned', corresponding_resident_id: '4' })).rows.map((row) => row.id), [beta, multi]);
	assert.equal((await request({ status: 'signed', resident_checked: '0' })).total, 0);
	saveStudyFavorite(db, 1, multi, []);
	assert.deepEqual((await request({ status: 'unsigned', favorites: 'all' })).rows.map((row) => row.id), [multi]);
	assert.equal((await request({ status: 'unsigned', patient_code: 'EMPTY' })).total, 0);
	assert.deepEqual((await request({ status: 'no-recording', patient_code: 'EMPTY' })).rows.map((row) => row.id), [empty]);
	assert.equal((await request({ status: 'signed', date_from: '1499-01-01' })).total, 0);
	assert.equal((await request({ status: 'not-a-status' })).status, 400);
});

test('page load forwards selected status and returns the filtered count', async (t) => {
	const { key, GET, other } = await fixture(t);
	const { load } = await loadModule('../src/routes/studies/+page.server.js', key);
	const locals = { user: { id: 1, role: 'admin' } };
	const url = new URL('http://localhost/studies?status=signed&rowcount=1');
	let query;
	const data = await load({ locals, url, fetch: async (path) => {
		if (!path.startsWith('/api/studies?')) return Response.json([]);
		query = new URL(path, url);
		return GET({ locals, url: query });
	} });
	assert.equal(query.searchParams.get('status'), 'signed');
	assert.equal(data.filters.status, 'signed');
	assert.equal(data.paging.total, 1);
	assert.equal(data.paging.totalPages, 1);
	assert.deepEqual(data.studies.map((row) => row.id), [other]);
});
