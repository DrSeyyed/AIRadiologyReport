import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';

const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const read = (name) => readFileSync(new URL(`../src/routes/pathology-search/${name}`, import.meta.url), 'utf8');

async function fixture(t) {
	const key = randomUUID();
	const state = { dbCalls: 0, calls: [], result: { filters: { q: 'HCC' }, rows: [] } };
	globalThis[key] = state;
	t.after(() => delete globalThis[key]);
	const db = moduleUrl(`export function getDb(){const s=globalThis[${JSON.stringify(key)}];s.dbCalls++;return 'db';}`);
	const search = moduleUrl(`export async function searchPathologyReports(...args){const s=globalThis[${JSON.stringify(key)}];s.calls.push(args);if(s.failure)throw s.failure;return s.result;}`);
	const code = read('+page.server.js').replace(/from (['"])([^'"]+)\1/g, (_statement, _quote, specifier) => {
		const target = specifier === '$lib/server/db' ? db : specifier === '$lib/server/pathology-search.js' ? search : import.meta.resolve(specifier);
		return `from ${JSON.stringify(target)}`;
	});
	const page = await import(moduleUrl(code));
	const event = (user = { id: 1, role: 'resident' }, query = '?q=HCC') => ({ locals: { user }, url: new URL(`http://localhost/pathology-search${query}`), request: new Request('http://localhost/pathology-search'), setHeaders: (headers) => { state.headers = headers; } });
	return { state, page, event };
}

test('pathology page authorizes before touching the database and forwards the read-only search contract', async (t) => {
	const { page, state, event } = await fixture(t);
	for (const user of [null, undefined, {}, { role: 'unknown' }]) {
		await assert.rejects(page.load({ locals: { user } }), { status: user ? 403 : 302 });
	}
	assert.equal(state.dbCalls, 0);
	for (const role of ['admin', 'resident', 'attending', 'typist']) {
		const request = event({ id: 1, role });
		assert.deepEqual(await page.load(request), { search: state.result, filters: state.result.filters, validationError: null });
		assert.deepEqual(state.calls.at(-1), ['db', request.locals.user, request.url.searchParams, { signal: request.request.signal }]);
		assert.deepEqual(state.headers, { 'cache-control': 'private, no-store' });
	}
	assert.equal(page.actions, undefined);
});

test('invalid search filters stay inline and authorization/server errors are not swallowed', async (t) => {
	const { page, state, event } = await fixture(t);
	state.failure = Object.assign(new Error('Enter valid Jalali dates.'), { status: 400 });
	const result = await page.load(event(undefined, '?q=liver+hemangioma&date_range=custom&date_from=invalid&context=absent'));
	assert.equal(result.search, null);
	assert.equal(result.filters.q, 'liver hemangioma');
	assert.equal(result.filters.date_from, 'invalid');
	assert.equal(Object.hasOwn(result.filters, 'context'), false);
	assert.equal(result.validationError, 'Enter valid Jalali dates.');
	for (const status of [401, 403]) {
		state.failure = { status, message: 'Private error details' };
		await assert.rejects(page.load(event()), (caught) => caught.status === status && caught.body.message === 'Forbidden');
	}
	state.failure = new Error('Unexpected database failure');
	await assert.rejects(page.load(event()), (caught) => caught === state.failure);
});

async function compiledPage() {
	const source = read('+page.svelte');
	for (const generate of ['client', 'server']) assert.deepEqual(compile(source, { filename: '+page.svelte', generate }).warnings, []);
	const code = compile(source, { filename: '+page.svelte', generate: 'server' }).js.code.replace(/from (['"])([^'"]+)\1/g, (_statement, _quote, specifier) => {
		const target = specifier === '$app/paths' ? moduleUrl('export const resolve = (path) => path;')
			: specifier.startsWith('$lib/') ? new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href : import.meta.resolve(specifier);
		return `from ${JSON.stringify(target)}`;
	});
	return (await import(moduleUrl(code))).default;
}

test('search page renders escaped excerpts, report signature states, warnings and filter-preserving pagination', async () => {
	const Page = await compiledPage();
	const filters = { q: 'liver hemangioma', date_range: 'custom', date_from: '1405-08-01', date_to: '1405-08-22' };
	const data = { filters, validationError: null, search: {
		searched: true, scanned: 25, unavailable: 2, total: 21, totalPages: 2, page: 1, expansions: [['hemangioma', 'haemangioma']],
		rows: [0, 1].map((signed) => ({ recording_id: signed + 1, study_id: 1, patient_code: 'SYNTHETIC & CODE', patient_fullname: '<Synthetic patient>', exam_date_jalali: '1405-08-22', attending_checked: signed, disabled: signed, mentionCount: 4,
			mentions: [{ excerpt: 'No hepatic hemangioma. <script>not executable</script>' }] }))
	} };
	const { body } = render(Page, { props: { data } });
	assert.match(body, /Text search, not a diagnosis/);
	assert.match(body, /Unsigned draft — not attending-signed/);
	assert.match(body, /Attending signed/);
	assert.match(body, /Disabled study/);
	assert.doesNotMatch(body, /name="context"|data-context|context-label|Positive wording|Uncertain wording|Negated wording|Unclassified context/);
	assert.match(body, /&lt;script(?:>|&gt;)not executable&lt;\/script(?:>|&gt;)/);
	assert.doesNotMatch(body, /<script>|<Synthetic patient>/);
	assert.match(body, /Results may be incomplete/);
	assert.match(body, /Showing 1 of 4 matching sentences/);
	assert.ok(body.includes('/studies?patient_code=SYNTHETIC+%26+CODE'));
	assert.ok(body.includes('q=liver+hemangioma&amp;date_range=custom&amp;date_from=1405-08-01&amp;date_to=1405-08-22&amp;page=2'));
	assert.doesNotMatch(body, /[?&](?:amp;)?context=/);
	assert.match(body, /type="search" required(?:="")? maxlength="160"/);
	assert.match(body, /value="1405-08-01"/);
});

test('initial, empty and validation-error page states remain useful without report data', async () => {
	const Page = await compiledPage();
	for (const data of [
		{ filters: {}, search: { searched: false }, validationError: null },
		{ filters: { q: 'HCC' }, search: { searched: true, scanned: 0, unavailable: 0, total: 0, expansions: [], rows: [], totalPages: 1, page: 1 }, validationError: null },
		{ filters: { q: 'HCC' }, search: null, validationError: 'Enter valid dates.' }
	]) {
		const { body } = render(Page, { props: { data } });
		if (data.validationError) assert.match(body, /role="alert"[^>]*>Enter valid dates/);
		else if (data.search.searched) assert.match(body, /No matching report text found/);
		else assert.match(body, /Search for a pathology to explore/);
	}
});
