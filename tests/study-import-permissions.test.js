import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import * as XLSX from 'xlsx';
import { canImportStudies } from '../src/lib/study-permissions.js';

async function loadModule(relativePath, databaseKey) {
	const url = new URL(relativePath, import.meta.url);
	const source = readFileSync(url, 'utf8').replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
		const resolved = specifier === '$lib/server/db'
			? `data:text/javascript,${encodeURIComponent(`export function getDb(){return globalThis[${JSON.stringify(databaseKey)}]}`)}`
			: specifier.startsWith('$lib/') ? new URL(`../src/lib/${specifier.slice(5)}.js`.replace(/\.js\.js$/, '.js'), import.meta.url).href
				: specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier);
		return `from ${JSON.stringify(resolved)}`;
	});
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('import button eligibility and page access allow all clinicians but not typists or guests', async () => {
	const { load } = await loadModule('../src/routes/studies/import/+page.server.js');
	for (const role of ['admin', 'attending', 'resident']) {
		const user = { id: 1, role };
		assert.equal(canImportStudies(user), true);
		const result = await load({ locals: { user }, fetch: async (url) => {
			assert.equal(url, '/api/users?role=attending');
			return Response.json([{ id: 3, role: 'attending' }]);
		} });
		assert.equal(result.users[0].id, 3);
	}
	const unexpectedFetch = () => { throw new Error('Fetched before authorization'); };
	for (const role of ['typist', 'unknown']) {
		assert.equal(canImportStudies({ role }), false);
		await assert.rejects(load({ locals: { user: { role } }, fetch: unexpectedFetch }), { status: 403 });
	}
	assert.equal(canImportStudies(null), false);
	await assert.rejects(load({ locals: { user: null }, fetch: unexpectedFetch }), { status: 302, location: '/login' });
});

test('import API rejects guests and typists before reading uploads or accessing the database', async () => {
	const { POST } = await loadModule('../src/routes/api/studies/import/+server.js');
	for (const [user, status] of [[null, 401], [{ role: 'typist' }, 403], [{ role: 'unknown' }, 403]]) {
		const result = await POST({ locals: { user }, request: { formData() { throw new Error('Upload consumed'); } } });
		assert.equal(result.status, status);
	}
});

test('administrators, attendings and residents can preview and confirm imports with unchanged validation', async (t) => {
	const db = new Database(':memory:');
	db.exec(readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
	db.exec("INSERT INTO users(id,full_name,role) VALUES(1,'Admin','admin'),(2,'Resident','resident'),(3,'Attending','attending');");
	const key = `studyImportDb_${randomUUID()}`;
	globalThis[key] = db;
	t.after(() => { delete globalThis[key]; db.close(); });
	t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected external request'); });
	const { POST } = await loadModule('../src/routes/api/studies/import/+server.js', key);
	for (const [index, role] of ['admin', 'attending', 'resident'].entries()) {
		const workbook = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
			['ID', 'NAME', 'MODALITY', 'DESCRIPTION', 'STUDY DATE', 'STUDY INST UID'],
			[`000${index}`, 'Patient^Synthetic', 'CT', 'Brain', '2026-10-08 10:30:00', `synthetic.${index}`]
		]), 'Studies');
		const file = new File([XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })], 'synthetic.xlsx');
		async function request(action, attending, preview) {
			const form = new FormData();
			form.set('file', file); form.set('action', action);
			if (attending) form.set('corresponding_attending_id', String(attending));
			if (preview) { form.set('token', preview.token); form.set('selected_rows', JSON.stringify(preview.rows.map(row => row.row))); }
			return POST({ locals: { user: { id: { admin: 1, attending: 3, resident: 2 }[role], role } }, request: new Request('http://localhost/import', { method: 'POST', body: form }) });
		}
		const response = await request('preview');
		assert.equal(response.status, 200);
		const preview = await response.json();
		assert.equal(preview.rows[0].status, 'ready');
		assert.equal((await request('import', null, preview)).status, 400);
		assert.equal((await request('import', 2, preview)).status, 400);
		const imported = await request('import', 3, preview);
		assert.equal(imported.status, 201);
		assert.equal((await imported.json()).inserted, 1);
	}
	assert.equal(db.prepare('SELECT count(*) AS n FROM studies').get().n, 3);
	assert.ok(db.prepare('SELECT corresponding_attending_id,corresponding_resident_id FROM studies').all()
		.every(row => row.corresponding_attending_id === 3 && row.corresponding_resident_id === null));
});
