import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { listBodyParts, saveBodyPart } from '../src/lib/server/body-parts.js';
import { insertStudy } from '../src/lib/server/studies.js';
import { appendRecording, configureRecording, getRecording } from '../src/lib/server/recordings.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const admin = { id: 1, role: 'admin' };

async function loadModule(relativePath, key) {
	const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
		.replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
			let target;
			if (specifier === '$lib/server/db') target = `data:text/javascript,${encodeURIComponent(`export function getDb(){return globalThis[${JSON.stringify(key)}]}`)}`;
			else if (specifier.startsWith('$lib/')) target = new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href;
			else target = import.meta.resolve(specifier);
			return `from ${JSON.stringify(target)}`;
		});
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

async function fixture(t) {
	const db = new Database(':memory:');
	initializeSchema(db, schema);
	const key = `bodyParts_${randomUUID()}`;
	globalThis[key] = db;
	t.after(() => { delete globalThis[key]; db.close(); });
	const page = await loadModule('../src/routes/admin/body-parts/+page.server.js', key);
	const load = (search = '') => page.load({ locals: { user: admin }, url: new URL(`http://localhost/admin/body-parts${search}`) });
	async function submit(action, values, user = admin) {
		const form = new FormData();
		for (const [key, value] of Object.entries(values)) form.set(key, value);
		return page.actions[action]({ locals: { user }, request: new Request(`http://localhost/admin/body-parts?/${action}`, { method: 'POST', body: form }) });
	}
	return { db, key, page, load, submit };
}

test('admin creates and edits body parts with trimmed, Unicode-capable text and stable IDs', async (t) => {
	const { db, load, submit } = await fixture(t);
	assert.deepEqual(load().bodyParts, []);
	assert.equal((await submit('create', { code: ' WRIST_WO ', name: ' Wrist without contrast ' })).success, true);
	const [part] = listBodyParts(db);
	assert.deepEqual(part, { id: 1, code: 'WRIST_WO', name: 'Wrist without contrast' });
	assert.deepEqual(load('?edit=1').selected, part);
	assert.equal((await submit('update', { id: '1', code: ' WRIST_WC ', name: ' مچ دست با تزریق ' })).success, true);
	assert.deepEqual(listBodyParts(db), [{ id: 1, code: 'WRIST_WC', name: 'مچ دست با تزریق' }]);
	assert.equal((await submit('update', { id: '1', code: 'WRIST_WC', name: 'مچ دست با تزریق' })).success, true);
	initializeSchema(db, schema);
	assert.deepEqual(load('?edit=1').selected, listBodyParts(db)[0]);
});

test('all non-admin roles and signed-out requests are blocked before reading form data', async (t) => {
	const { page, db } = await fixture(t);
	for (const user of [undefined, { role: 'typist' }, { role: 'resident' }, { role: 'attending' }]) {
		const check = (caught) => caught.status === (user ? 403 : 302) && Boolean(user || caught.location === '/login');
		assert.throws(() => page.load({ locals: { user } }), check);
		for (const action of ['create', 'update'])
			await assert.rejects(page.actions[action]({ locals: { user }, request: { formData() { throw new Error('Unauthorized form read'); } } }), check);
	}
	assert.deepEqual(listBodyParts(db), []);
});

test('invalid fields fail without writes and retain submitted text for correction', async (t) => {
	const { db, submit } = await fixture(t);
	const original = saveBodyPart(db, { code: 'HAND_WO', name: 'Hand without contrast' });
	for (const action of ['create', 'update']) {
		for (const invalid of [{ code: '' }, { name: '   ' }, { code: 'X'.repeat(65) }, { name: 'X'.repeat(201) }, { code: 'BAD\nCODE' }, { name: 'Bad\0Name' }, { code: new File(['synthetic'], 'code.txt') }]) {
			const values = { code: 'NEW', name: 'New name', ...invalid, ...(action === 'update' ? { id: '1' } : {}) };
			const result = await submit(action, values);
			assert.equal(result.status, 400);
			assert.ok(result.data.error);
			assert.equal(result.data.values.name, values.name);
			assert.deepEqual(listBodyParts(db), [original]);
		}
		assert.equal((await submit(action, action === 'update' ? { id: '1' } : {})).status, 400);
	}
	assert.throws(() => saveBodyPart(db, { code: null, name: 'Name' }), /Code/);
	assert.throws(() => saveBodyPart(db, { code: 'NEW', name: 123 }), /Name/);
});

test('duplicate codes are rejected on create and edit without modifying either entry', async (t) => {
	const { db, submit } = await fixture(t);
	saveBodyPart(db, { code: 'HAND_WO', name: 'Hand without contrast' });
	saveBodyPart(db, { code: 'BRAIN_WO', name: 'Brain without contrast' });
	const before = listBodyParts(db);
	for (const [action, values] of [['create', { code: ' HAND_WO ', name: 'Duplicate' }], ['update', { id: '2', code: 'HAND_WO', name: 'Duplicate' }]]) {
		const result = await submit(action, values);
		assert.equal(result.status, 409);
		assert.match(result.data.error, /code already exists/);
		assert.equal(result.data.values.code, values.code);
		assert.deepEqual(listBodyParts(db), before);
	}
	assert.equal((await submit('create', { code: 'hand_wo', name: 'Case-sensitive code' })).success, true);
});

test('editing requires an existing valid ID; create cannot overwrite an ID supplied by the client', async (t) => {
	const { db, load, submit } = await fixture(t);
	const original = saveBodyPart(db, { code: 'OLD', name: 'Original' });
	for (const id of ['', '0', '-1', '1.5', '1 OR 1=1', '9007199254740992']) {
		assert.equal((await submit('update', { id, code: 'NEW', name: 'New' })).status, 400);
		assert.throws(() => load(`?edit=${encodeURIComponent(id)}`), (caught) => caught.status === 400);
		assert.deepEqual(listBodyParts(db), [original]);
	}
	assert.equal((await submit('update', { id: '999', code: 'NEW', name: 'New' })).status, 404);
	assert.throws(() => load('?edit=999'), (caught) => caught.status === 404);
	assert.equal((await submit('create', { id: '1', code: 'NEW', name: 'New' })).success, true);
	assert.equal(listBodyParts(db).length, 2);
	assert.deepEqual(db.prepare('SELECT * FROM exam_types WHERE id = 1').get(), original);
});

test('new and renamed entries immediately appear in the examination API and existing templates', async (t) => {
	const { db, key, submit } = await fixture(t);
	const { GET } = await loadModule('../src/routes/api/exam-types/+server.js', key);
	await submit('create', { code: 'WRIST_WO', name: 'Wrist without contrast' });
	assert.deepEqual(await (await GET()).json(), [{ id: 1, code: 'WRIST_WO', name: 'Wrist without contrast' }]);
	db.exec("INSERT INTO modalities(id,code,name) VALUES(1,'MR','Magnetic resonance imaging'); INSERT INTO report_templates(modality_id,exam_type_id,text) VALUES(1,1,'Synthetic template');");
	await submit('update', { id: '1', code: 'WRIST_WC', name: 'Wrist with contrast' });
	assert.equal((await (await GET()).json())[0].name, 'Wrist with contrast');
	assert.deepEqual(db.prepare('SELECT t.exam_type_id, t.text, e.code, e.name FROM report_templates t JOIN exam_types e ON e.id = t.exam_type_id').get(), {
		exam_type_id: 1, text: 'Synthetic template', code: 'WRIST_WC', name: 'Wrist with contrast'
	});
});

test('editing a referenced body part preserves repeated examinations, saved reports, signatures and source data', async (t) => {
	const { db, submit } = await fixture(t);
	db.exec("INSERT INTO users(id,full_name,role) VALUES(1,'Admin','admin'),(2,'Resident','resident'),(3,'Attending','attending'); INSERT INTO modalities(id,code,name) VALUES(1,'MR','Magnetic resonance imaging');");
	const part = saveBodyPart(db, { code: 'HAND_WO', name: 'Hand without contrast' });
	const studyId = insertStudy(db, { patient_code: 'SYNTHETIC', patient_fullname: 'Synthetic Patient', source_description: 'Original imported description', exam_date_jalali: '1405-07-27', exam_time: '10:00', corresponding_attending_id: 3 });
	const recording = appendRecording(db, studyId, 'synthetic.ogg');
	configureRecording(db, studyId, recording.id, { modality_id: 1, corresponding_resident_id: 2, examinations: [{ exam_type_id: part.id, exam_details: 'left' }, { exam_type_id: part.id, exam_details: 'right' }] });
	db.prepare("UPDATE study_recordings SET text_report_path = 'synthetic-report.md', resident_checked = 1, attending_checked = 1, resident_signed_by_user_id = 2, attending_signed_by_user_id = 3, resident_signed_at = '2026-10-19 03:00:00', attending_signed_at = '2026-10-19 03:01:00' WHERE id = ?").run(recording.id);
	const tables = ['studies', 'study_recordings', 'recording_examinations'];
	const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
	assert.equal((await submit('update', { id: String(part.id), code: 'HAND_RENAMED', name: 'Renamed hand examination' })).success, true);
	assert.deepEqual(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()), before);
	const updated = getRecording(db, studyId, recording.id);
	assert.deepEqual(updated.exam_types.map((exam) => [exam.id, exam.name, exam.exam_details]), [[part.id, 'Renamed hand examination', 'left'], [part.id, 'Renamed hand examination', 'right']]);
	initializeSchema(db, schema);
	assert.deepEqual(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()), before);
	assert.deepEqual(db.pragma('foreign_key_check'), []);
});
