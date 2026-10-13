import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { insertStudy } from '../src/lib/server/studies.js';
import { appendRecording } from '../src/lib/server/recordings.js';

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
