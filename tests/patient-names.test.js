import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { patientName } from '../src/lib/patient-name.js';
import { getStudyDetail, insertStudy, normalizeStudyInput } from '../src/lib/server/studies.js';
import { buildStudyMessage } from '../src/lib/server/telegram.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const input = {
	patient_code: 'SYNTHETIC',
	exam_date_jalali: '1405-07-21',
	exam_time: '10:00',
	corresponding_attending_id: 1
};

function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	initializeSchema(db, schema);
	db.exec("INSERT INTO users(id,full_name,role) VALUES(1,'Attending','attending')");
	t.after(() => db.close());
	return db;
}

async function loadModule(relativePath, dbKey) {
	const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8').replace(
		/from (['"])([^'"]+)\1/g,
		(statement, quote, specifier) => {
			let resolved;
			if (specifier === '$lib/server/db')
				resolved = `data:text/javascript,${encodeURIComponent(`export function getDb(){return globalThis[${JSON.stringify(dbKey)}]}`)}`;
			else if (specifier === '$lib/server/telegram.js')
				resolved = `data:text/javascript,${encodeURIComponent('export async function sendStudyMessage(){return {message_id:42}}; export async function editStudyMessage(){}')}`;
			else if (specifier.startsWith('$lib/'))
				resolved = new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href;
			else resolved = import.meta.resolve(specifier);
			return `from ${JSON.stringify(resolved)}`;
		}
	);
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('patient display prefers full names and safely preserves legacy lastname-only names', () => {
	assert.equal(patientName(undefined), '');
	assert.equal(
		patientName({
			patient_fullname: '  نام   کامل ',
			patient_firstname: 'Old',
			patient_lastname: 'Name'
		}),
		'نام کامل'
	);
	assert.equal(
		patientName({
			patient_fullname: ' ',
			patient_firstname: ' First ',
			patient_lastname: ' Last '
		}),
		'First Last'
	);
	assert.equal(patientName({ patient_lastname: 'Complete Patient Name' }), 'Complete Patient Name');
});

test('canonical name validation accepts unsplit names and rejects explicitly blank values', (t) => {
	const db = fixture(t);
	const name = 'نام کامل بیمار';
	const id = insertStudy(db, { ...input, patient_fullname: name });
	assert.equal(getStudyDetail(db, id).patient_fullname, name);
	assert.equal(getStudyDetail(db, id).patient_firstname, '');
	assert.equal(getStudyDetail(db, id).patient_lastname, '');
	assert.equal(
		normalizeStudyInput(db, { ...input, patient_firstname: 'First', patient_lastname: 'Last' })
			.patient_fullname,
		'First Last'
	);
	assert.equal(
		normalizeStudyInput(db, { ...input, patient_lastname: name }).patient_fullname,
		name
	);
	for (const patient_fullname of ['', '   ', null, 123, 'A'.repeat(402)])
		assert.throws(() =>
			normalizeStudyInput(db, { ...input, patient_firstname: 'Old', patient_fullname })
		);
	assert.equal(
		normalizeStudyInput(db, { ...input, patient_fullname: 'A'.repeat(401) }).patient_fullname
			.length,
		401
	);
});

test('upgrade merges existing names without changing IDs, recordings, signatures or canonical edits', (t) => {
	const db = new Database(':memory:');
	t.after(() => db.close());
	db.pragma('foreign_keys = ON');
	db.exec(schema.replace("    patient_fullname TEXT NOT NULL DEFAULT '',", ''));
	db.exec(
		"INSERT INTO studies(id,patient_code,patient_firstname,patient_lastname,exam_date_jalali,exam_time) VALUES(42,'OLD','First','Last','1405-07-21','10:00'),(43,'FULL','','نام کامل','1405-07-21','10:00'); INSERT INTO study_recordings(id,study_id,text_report_path,resident_checked,attending_checked) VALUES(7,42,'synthetic-report.md',1,1)"
	);
	db.prepare(
		"INSERT INTO studies(id,patient_code,patient_firstname,patient_lastname,exam_date_jalali,exam_time) VALUES(44,'LONG',?,?,'1405-07-21','10:00')"
	).run('A'.repeat(200), 'B'.repeat(200));
	initializeSchema(db, schema);
	assert.equal(getStudyDetail(db, 44).patient_fullname, `${'A'.repeat(200)} ${'B'.repeat(200)}`);
	assert.equal(getStudyDetail(db, 42).patient_fullname, 'First Last');
	assert.equal(getStudyDetail(db, 43).patient_fullname, 'نام کامل');
	assert.deepEqual(
		db
			.prepare(
				'SELECT study_id,text_report_path,resident_checked,attending_checked FROM study_recordings WHERE id=7'
			)
			.get(),
		{
			study_id: 42,
			text_report_path: 'synthetic-report.md',
			resident_checked: 1,
			attending_checked: 1
		}
	);
	db.prepare('UPDATE studies SET patient_fullname=? WHERE id=42').run('Edited Full Name');
	initializeSchema(db, schema);
	assert.equal(getStudyDetail(db, 42).patient_fullname, 'Edited Full Name');
	assert.deepEqual(db.pragma('foreign_key_check'), []);
	assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});

test('Telegram renders escaped canonical names, with legacy fallback', () => {
	assert.match(
		buildStudyMessage({
			...input,
			patient_fullname: 'Full <Name> & Family',
			patient_firstname: 'Stale'
		}),
		/Patient: <b>Full &lt;Name&gt; &amp; Family<\/b>/
	);
	assert.match(
		buildStudyMessage({ ...input, patient_lastname: 'Complete Name' }),
		/Patient: <b>Complete Name<\/b>/
	);
});

test('API creates and edits a full name, filters and sorts canonical and legacy rows, and forwards the filter', async (t) => {
	const db = fixture(t);
	const key = `patientNames_${randomUUID()}`;
	globalThis[key] = db;
	t.after(() => delete globalThis[key]);
	const list = await loadModule('../src/routes/api/studies/+server.js', key);
	const detail = await loadModule('../src/routes/api/studies/[id]/+server.js', key);
	const locals = { user: { id: 1, role: 'attending' } };
	const created = await list.POST({
		locals,
		request: { json: async () => ({ ...input, patient_fullname: 'Zulu Complete Name', study_key: '000042' }) }
	});
	assert.equal(created.status, 201);
	const saved = await created.json();
	assert.equal(saved.study_key, '000042');
	const patch = async (changes) =>
		detail.PATCH({
			locals,
			params: { id: String(saved.id) },
			request: { json: async () => changes }
		});
	assert.equal((await patch({ patient_fullname: 'Edited Patient Name' })).status, 200);
	assert.equal(getStudyDetail(db, saved.id).study_key, '000042');
	assert.equal((await patch({ study_key: '  000099  ' })).status, 200);
	assert.equal(getStudyDetail(db, saved.id).study_key, '000099');
	assert.equal((await patch({ study_key: 42 })).status, 400);
	assert.equal((await patch({ study_key: 'K'.repeat(129) })).status, 400);
	assert.equal(getStudyDetail(db, saved.id).study_key, '000099');
	assert.equal((await patch({ study_key: '' })).status, 200);
	assert.equal(getStudyDetail(db, saved.id).study_key, '');
	assert.equal(getStudyDetail(db, saved.id).patient_fullname, 'Edited Patient Name');
	assert.equal(
		(await patch({ patient_fullname: '', patient_lastname: 'Must not replace blank' })).status,
		400
	);
	assert.equal(getStudyDetail(db, saved.id).patient_fullname, 'Edited Patient Name');
	assert.equal((await patch({ patient_lastname: 'Legacy API Name' })).status, 200);
	assert.equal(getStudyDetail(db, saved.id).patient_fullname, 'Legacy API Name');
	db.exec(
		"INSERT INTO studies(patient_code,patient_lastname,exam_date_jalali,exam_time) VALUES('OLD','Alpha Legacy Name','1405-07-21','10:00')"
	);
	const get = async (filters) =>
		(
			await list.GET({
				locals,
				url: new URL(`http://localhost/api/studies?${new URLSearchParams(filters)}`)
			})
		).json();
	const sorted = await get({ orderedby: 's.patient_fullname', orderdir: 'ASC' });
	assert.deepEqual(
		sorted.rows.map((row) => row.patient_fullname),
		['Alpha Legacy Name', 'Legacy API Name']
	);
	assert.equal((await get({ patient_fullname: 'Alpha Legacy' })).total, 1);
	assert.equal((await get({ patient_fullname: 'Legacy API' })).rows[0].id, saved.id);
	assert.equal((await get({ patient_lastname: 'Legacy API' })).total, 1);
	const { load } = await loadModule('../src/routes/studies/+page.server.js', key);
	const url = new URL('http://localhost/studies?patient_fullname=Alpha%20Legacy');
	let query;
	const data = await load({
		locals,
		url,
		fetch: async (path) => {
			if (path.startsWith('/api/studies?')) {
				query = new URL(path, url);
				return list.GET({ locals, url: query });
			}
			return Response.json([]);
		}
	});
	assert.equal(query.searchParams.get('patient_fullname'), 'Alpha Legacy');
	assert.equal(data.filters.patient_fullname, 'Alpha Legacy');
	assert.equal(data.studies[0].patient_fullname, 'Alpha Legacy Name');
});
