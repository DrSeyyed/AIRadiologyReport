import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { DEFAULT_PACS_VIEWER_URL, normalizePacsViewerUrl, pacsViewerLink } from '../src/lib/pacs-viewer.js';
import { getPacsViewerUrl, setPacsViewerUrl } from '../src/lib/server/pacs-settings.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');

function fixture(t) {
	const db = new Database(':memory:');
	initializeSchema(db, schema);
	t.after(() => db.close());
	return db;
}

async function adminModule(db, t) {
	const key = randomUUID();
	globalThis[key] = db;
	t.after(() => delete globalThis[key]);
	const source = readFileSync(new URL('../src/routes/admin/pacs/+page.server.js', import.meta.url), 'utf8')
		.replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
			let target;
			if (specifier === '$lib/server/db') target = `data:text/javascript,${encodeURIComponent(`export function getDb(){return globalThis[${JSON.stringify(key)}]}`)}`;
			else if (specifier.startsWith('$lib/')) target = new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href;
			else target = import.meta.resolve(specifier);
			return `from ${JSON.stringify(target)}`;
		});
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('viewer links preserve leading zeros and encode keys without changing the destination', () => {
	assert.equal(pacsViewerLink(DEFAULT_PACS_VIEWER_URL, ' 000042 '), 'https://taleghanisms.pacs.sbmu.ac.ir:5010/adminpanel/LoadViewer?studyKey=000042');
	const key = 'a&next=https://example.com/#? +نام';
	const link = new URL(pacsViewerLink(DEFAULT_PACS_VIEWER_URL, key));
	assert.equal(link.searchParams.get('studyKey'), key);
	assert.equal(link.searchParams.has('next'), false);
	assert.equal(link.hash, '');
	for (const key of ['', ' ', null, undefined, 'a'.repeat(129)]) assert.equal(pacsViewerLink(DEFAULT_PACS_VIEWER_URL, key), '');
	assert.equal(pacsViewerLink('', '42'), '');
	assert.equal(pacsViewerLink('https://pacs.example/study/{studyKey}', '00042'), 'https://pacs.example/study/00042');
});

test('viewer settings allow only HTTP(S) templates without embedded credentials or variable hosts', () => {
	assert.equal(normalizePacsViewerUrl(` ${DEFAULT_PACS_VIEWER_URL} `), DEFAULT_PACS_VIEWER_URL);
	assert.equal(normalizePacsViewerUrl('   '), '');
	assert.equal(normalizePacsViewerUrl('http://pacs.local/view?key={studyKey}'), 'http://pacs.local/view?key={studyKey}');
	for (const value of [null, 12, 'https://example.com/', 'javascript:alert("{studyKey}")', '/view?key={studyKey}', 'https://user:pass@example.com/?key={studyKey}', 'https://{studyKey}.example.com/', `https://example.com/{studyKey}${'x'.repeat(2048)}`]) assert.throws(() => normalizePacsViewerUrl(value));
});

test('settings migrate safely and survive reinitialization including disabled viewer links', (t) => {
	const db = new Database(':memory:');
	t.after(() => db.close());
	db.exec(schema.replace(/CREATE TABLE IF NOT EXISTS application_settings \([\s\S]*?\);/, ''));
	initializeSchema(db, schema);
	assert.equal(getPacsViewerUrl(db), DEFAULT_PACS_VIEWER_URL);
	const custom = 'https://pacs.example/view?key={studyKey}';
	setPacsViewerUrl(db, custom);
	initializeSchema(db, schema);
	assert.equal(getPacsViewerUrl(db), custom);
	assert.throws(() => setPacsViewerUrl(db, 'javascript:{studyKey}'));
	assert.equal(getPacsViewerUrl(db), custom);
	setPacsViewerUrl(db, '');
	initializeSchema(db, schema);
	assert.equal(getPacsViewerUrl(db), '');
});

test('admin page protects both loading and updating settings', async (t) => {
	const db = fixture(t);
	const page = await adminModule(db, t);
	for (const user of [undefined, { role: 'typist' }, { role: 'resident' }, { role: 'attending' }]) {
		assert.throws(() => page.load({ locals: { user } }), (error) => error.status === (user ? 403 : 302));
		await assert.rejects(page.actions.default({ locals: { user } }), (error) => error.status === (user ? 403 : 302));
	}
	assert.equal(getPacsViewerUrl(db), DEFAULT_PACS_VIEWER_URL);
});

test('admin saves, clears and validates the viewer URL persistently', async (t) => {
	const db = fixture(t);
	const page = await adminModule(db, t);
	const locals = { user: { id: 1, role: 'admin' } };
	assert.equal(page.load({ locals }).viewerUrl, DEFAULT_PACS_VIEWER_URL);
	async function submit(value) {
		const form = new FormData();
		if (value !== undefined) form.set('viewerUrl', value);
		return page.actions.default({ locals, request: new Request('http://localhost/admin/pacs', { method: 'POST', body: form }) });
	}
	const custom = 'https://pacs.example/view?key={studyKey}';
	assert.equal((await submit(custom)).success, true);
	assert.equal(page.load({ locals }).viewerUrl, custom);
	for (const value of ['javascript:{studyKey}', undefined, 'https://example.com']) {
		const result = await submit(value);
		assert.equal(result.status, 400);
		assert.ok(result.data.error);
		assert.equal(getPacsViewerUrl(db), custom);
	}
	assert.equal((await submit('')).success, true);
	assert.equal(page.load({ locals }).viewerUrl, '');
});
