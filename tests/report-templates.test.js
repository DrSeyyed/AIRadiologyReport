import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { canManageTemplates } from '../src/lib/template-permissions.js';
import { generateTemplateDraft, listTemplates, NORMAL_TEMPLATE_PROMPT, saveTemplate, templatePair } from '../src/lib/server/report-templates.js';

async function loadModule(relativePath, key) {
	const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8').replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
		let resolved;
		if (specifier === '$lib/server/db') resolved = `data:text/javascript,${encodeURIComponent(`export function getDb(){globalThis[${JSON.stringify(key + 'Calls')}]++;return globalThis[${JSON.stringify(key)}]}`)}`;
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
	db.exec("INSERT INTO modalities(id,code,name) VALUES(1,'CT','Computed tomography'),(2,'MRI','Magnetic resonance imaging'); INSERT INTO exam_types(id,code,name) VALUES(1,'CHEST','Chest'),(2,'KNEE','Knee with contrast');");
	const key = `templateDb_${randomUUID()}`;
	globalThis[key] = db;
	globalThis[key + 'Calls'] = 0;
	const previous = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = 'synthetic-template-key';
	t.after(() => {
		delete globalThis[key]; delete globalThis[key + 'Calls']; db.close();
		if (previous === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previous;
	});
	const routes = await loadModule('../src/routes/api/report-templates/+server.js', key);
	const generation = await loadModule('../src/routes/api/report-templates/generate/+server.js', key);
	const page = await loadModule('../src/routes/admin/templates/+page.server.js', key);
	const deletion = await loadModule('../src/routes/api/report-templates/[id]/+server.js', key);
	const post = (handler, body, role = 'admin') => handler({ locals: { user: role ? { id: 1, role } : null }, request: { json: async () => body } });
	const get = (query = '', role = 'admin') => routes.GET({ locals: { user: role ? { id: 1, role } : null }, url: new URL(`http://localhost/api/report-templates${query}`) });
	return { db, key, routes, generation, page, deletion, post, get };
}

const body = { modality_id: 1, exam_type_id: 1, text: 'Synthetic template.' };

test('template permissions allow all clinicians and administrators, but not typists or guests', () => {
	for (const role of ['admin', 'resident', 'attending']) assert.equal(canManageTemplates({ role }), true);
	for (const role of ['typist', 'unknown', undefined]) assert.equal(canManageTemplates({ role }), false);
	assert.equal(canManageTemplates(null), false);
});

test('template selections reject invalid or unknown IDs before generation', async (t) => {
	const { db } = await fixture(t);
	for (const invalid of [null, 0, -1, 1.5, '1 OR 1', {}, true, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => templatePair(db, invalid, 1), (error) => error.status === 400);
		assert.throws(() => templatePair(db, 1, invalid), (error) => error.status === 400);
	}
	assert.throws(() => templatePair(db, 99, 1), (error) => error.status === 404);
	assert.throws(() => templatePair(db, 1, 99), (error) => error.status === 404);
	assert.equal(templatePair(db, '1', '2').examination.name, 'Knee with contrast');
});

test('manual saves preserve pair-based updates, reject empty drafts and protect conflicting pairs', async (t) => {
	const { db } = await fixture(t);
	const first = saveTemplate(db, body);
	assert.equal(first.modality_code, 'CT');
	assert.equal(first.exam_type_name, 'Chest');
	assert.equal(saveTemplate(db, { ...body, text: 'Updated.' }).id, first.id);
	assert.equal(listTemplates(db)[0].text, 'Updated.');
	assert.throws(() => saveTemplate(db, { ...body, create_only: true }), (error) => error.status === 409);
	const second = saveTemplate(db, { ...body, exam_type_id: 2 });
	assert.throws(() => saveTemplate(db, { ...body, id: second.id }), (error) => error.status === 409);
	assert.throws(() => saveTemplate(db, { ...body, id: 99 }), (error) => error.status === 404);
	for (const text of ['', '   ', null, 5, 'x'.repeat(50001)])
		assert.throws(() => saveTemplate(db, { ...body, text }), (error) => error.status === 400);
	assert.equal(listTemplates(db, templatePair(db, 1, 2)).length, 1);
	assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('AI uses the exact supplied prompt with database labels and never saves its draft', async (t) => {
	const { db } = await fixture(t);
	const saved = saveTemplate(db, body);
	let prompt;
	const draft = await generateTemplateDraft(db, { modality_id: 2, exam_type_id: 2, patient_name: 'DO_NOT_SEND', text: 'DO_NOT_SEND' }, async (input) => {
		prompt = input;
		return '  Synthetic structure: Normal.  \n\n  Related structure:  Normal.\t\n';
	});
	assert.equal(prompt, NORMAL_TEMPLATE_PROMPT.replace('[MODALITY]', 'MRI (Magnetic resonance imaging)').replace('[BODY PART]', 'Knee with contrast'));
	assert.ok(!prompt.includes('DO_NOT_SEND'));
	assert.equal(draft.text, 'Synthetic structure: Normal.\nRelated structure: Normal.');
	assert.deepEqual(listTemplates(db), [saved]);
});

test('AI errors, missing configuration, empty and oversized drafts cannot persist a template', async (t) => {
	const { db } = await fixture(t);
	for (const result of ['', '\n  \n', null, 'x'.repeat(50001)])
		await assert.rejects(generateTemplateDraft(db, body, async () => result), (error) => error.status === 502);
	await assert.rejects(generateTemplateDraft(db, body, async () => { throw new Error('Provider detail not for browser'); }), (error) => error.status === 502 && !error.message.includes('Provider detail'));
	delete process.env.OPENAI_API_KEY;
	await assert.rejects(generateTemplateDraft(db, body, async () => assert.fail('No unconfigured model call')), (error) => error.status === 503);
	assert.equal(listTemplates(db).length, 0);
});

test('template mutation endpoints reject unauthorized users before reading bodies, database or AI', async (t) => {
	const { key, routes, generation } = await fixture(t);
	for (const handler of [routes.POST, generation.POST]) {
		for (const [user, status] of [[null, 401], [{ role: 'typist' }, 403], [{ role: 'unknown' }, 403]]) {
			const response = await handler({ locals: { user }, request: { json: () => assert.fail('Unauthorized body read') } });
			assert.equal(response.status, status);
		}
	}
	assert.equal(globalThis[key + 'Calls'], 0);
});

test('all three permitted roles can explicitly save and edit existing shared templates', async (t) => {
	const { db, routes, post } = await fixture(t);
	let saved;
	for (const role of ['resident', 'attending', 'admin']) {
		const response = await post(routes.POST, { ...body, id: saved?.id ?? null, text: role }, role);
		assert.equal(response.status, 200);
		saved = await response.json();
		assert.equal(saved.text, role);
	}
	assert.equal(listTemplates(db).length, 1);
	assert.equal((await post(routes.POST, null)).status, 400);
});

test('AI endpoint generates editable drafts for each permitted role using the existing Responses API', async (t) => {
	const { db, generation, post } = await fixture(t);
	const inputs = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		assert.equal(url, 'https://api.openai.com/v1/responses');
		inputs.push(JSON.parse(options.body));
		return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'reasoning', content: [] }, { type: 'message', content: [{ type: 'output_text', text: 'Synthetic structure: Normal.' }] }] }) };
	});
	for (const role of ['resident', 'attending', 'admin']) {
		const response = await post(generation.POST, body, role);
		assert.equal(response.status, 200);
		assert.equal((await response.json()).text, 'Synthetic structure: Normal.');
	}
	assert.equal(inputs.length, 3);
	assert.ok(inputs.every((input) => input.model === 'gpt-6.1-sol' && input.input.includes('Body part: Chest')));
	assert.equal(listTemplates(db).length, 0);
});

test('incomplete and refused AI responses produce no usable or persisted draft', async (t) => {
	const { db, generation, post } = await fixture(t);
	let output = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
	t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => output }));
	assert.equal((await post(generation.POST, body)).status, 502);
	output = { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Synthetic refusal.' }] }] };
	assert.equal((await post(generation.POST, body)).status, 502);
	assert.equal(listTemplates(db).length, 0);
});

test('authenticated pair lookup distinguishes missing templates and invalid selections', async (t) => {
	const { db, get } = await fixture(t);
	saveTemplate(db, body);
	assert.equal((await get('', null)).status, 401);
	assert.equal((await get('?modality_id=1')).status, 400);
	assert.equal((await get('?modality_id=99&exam_type_id=1')).status, 404);
	assert.equal((await (await get('?modality_id=1&exam_type_id=1', 'resident')).json())[0].text, body.text);
	assert.deepEqual(await (await get('?modality_id=2&exam_type_id=2', 'attending')).json(), []);
	assert.equal((await get('', 'typist')).status, 200);
});

test('templates page is available to clinicians while deletion remains administrator-only', async (t) => {
	const { db, page, deletion } = await fixture(t);
	for (const role of ['resident', 'attending', 'admin']) {
		const data = await page.load({ locals: { user: { id: 1, role } } });
		assert.equal(data.user.role, role);
		assert.equal(data.modalities.length, 2);
	}
	await assert.rejects(page.load({ locals: { user: null } }), (error) => error.status === 302);
	await assert.rejects(page.load({ locals: { user: { role: 'typist' } } }), (error) => error.status === 403);
	const saved = saveTemplate(db, body);
	for (const role of ['resident', 'attending', 'typist']) {
		const response = await deletion.DELETE({ locals: { user: { role } }, params: { id: saved.id } });
		assert.equal(response.status, 401);
		assert.equal(listTemplates(db).length, 1);
	}
	assert.equal((await deletion.DELETE({ locals: { user: { role: 'admin' } }, params: { id: saved.id } })).status, 200);
});
