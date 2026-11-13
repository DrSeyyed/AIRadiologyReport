import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { statisticsPresets, statisticsMetrics } from '../src/lib/study-statistics-options.js';

const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const generalRoute = '../src/routes/statistics/+page.server.js';
const adminRoute = '../src/routes/admin/statistics/+page.server.js';
const componentPath = '../src/lib/components/StudyStatistics.svelte';

async function fixture(t, { admin = false, realStatistics = false } = {}) {
	const key = randomUUID();
	const state = { calls: [], dbCalls: 0, db: {}, result: sampleData().statistics };
	globalThis[key] = state;
	t.after(() => delete globalThis[key]);
	const db = moduleUrl(`export function getDb(){const s=globalThis[${JSON.stringify(key)}];s.dbCalls++;return s.db;}`);
	const statistics = moduleUrl(`export function getStudyStatistics(...args){const s=globalThis[${JSON.stringify(key)}];s.calls.push(args);if(s.failure)throw s.failure;return s.result;}`);
	const source = read(generalRoute).replace(/from (['"])([^'"]+)\1/g, (_statement, _quote, specifier) => {
		const target = specifier === '$lib/server/db' ? db
			: specifier === '$lib/server/study-statistics.js' ? (realStatistics ? new URL('../src/lib/server/study-statistics.js', import.meta.url).href : statistics) : import.meta.resolve(specifier);
		return `from ${JSON.stringify(target)}`;
	});
	const generalModule = moduleUrl(source);
	const routeSource = admin ? read(adminRoute)
		.replace("from '@sveltejs/kit'", `from ${JSON.stringify(import.meta.resolve('@sveltejs/kit'))}`)
		.replace("from '../../statistics/+page.server.js'", `from ${JSON.stringify(generalModule)}`) : source;
	const page = await import(moduleUrl(routeSource));
	const event = (user = { id: 1, role: admin ? 'admin' : 'resident' }, query = '') => ({ locals: { user }, url: new URL(`http://localhost/${admin ? 'admin/' : ''}statistics${query}`) });
	return { state, page, event };
}

function sampleData(scope = 'all') {
	return {
		filters: { date_range: '7-days', date_from: '', date_to: '' },
		validationError: null,
		statistics: {
			scope,
			range: { preset: '7-days', date_from: '1405-08-17', date_to: '1405-08-23', label: 'Last 7 days', timeZone: 'Asia/Tehran' },
			totals: Object.fromEntries(statisticsMetrics.map((metric, index) => [metric.key, index * 1000]))
		}
	};
}

async function compiledComponent(path) {
	const source = read(path);
	for (const generate of ['client', 'server']) {
		const { warnings } = compile(source, { filename: path, generate });
		assert.deepEqual(warnings, []);
	}
	const nested = path === componentPath ? null : await compiledComponent(componentPath);
	const code = compile(source, { filename: path, generate: 'server' }).js.code.replace(/from (['"])([^'"]+)\1/g, (_statement, _quote, specifier) => {
		const target = specifier === '$lib/components/StudyStatistics.svelte' ? nested.url
			: specifier.startsWith('$lib/') ? new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href : import.meta.resolve(specifier);
		return `from ${JSON.stringify(target)}`;
	});
	const url = moduleUrl(code);
	return { Component: (await import(url)).default, url };
}

test('general statistics load authorizes every supported role and forwards only the aggregate contract', async (t) => {
	const { page, state, event } = await fixture(t);
	for (const role of ['admin', 'resident', 'attending', 'typist']) {
		const request = event({ id: 12, role });
		const result = page.load(request);
		assert.deepEqual(result, { statistics: state.result, filters: { date_range: '7-days', date_from: '', date_to: '' }, validationError: null });
		assert.deepEqual(state.calls.at(-1), [state.db, request.locals.user, request.url.searchParams]);
		assert.equal(state.calls.at(-1)[2], request.url.searchParams);
	}
	assert.equal(state.dbCalls, 4);
	assert.equal(page.actions, undefined);
});

test('both routes reject unauthorized requests before touching the database or URL', async (t) => {
	for (const admin of [false, true]) {
		const { page, state } = await fixture(t, { admin });
		for (const user of [null, undefined, {}, { role: 'unknown' }, ...(admin ? ['resident', 'attending', 'typist'].map((role) => ({ role })) : [])]) {
			assert.throws(() => page.load({ locals: { user }, get url() { throw new Error('URL read before authorization'); } }), (caught) => {
				assert.equal(caught.status, user ? 403 : 302);
				if (!user) assert.equal(caught.location, '/login');
				return true;
			});
		}
		assert.equal(state.dbCalls, 0);
		assert.equal(state.calls.length, 0);
	}
});

test('admin statistics delegates to the same read-only load', async (t) => {
	const { page, state, event } = await fixture(t, { admin: true });
	const request = event(undefined, '?date_range=custom&date_from=1405-08-01&date_to=1405-08-23');
	const result = page.load(request);
	assert.equal(result.statistics, state.result);
	assert.deepEqual(result.filters, { date_range: 'custom', date_from: '1405-08-01', date_to: '1405-08-23' });
	assert.deepEqual(state.calls[0], [state.db, request.locals.user, request.url.searchParams]);
	assert.equal(page.actions, undefined);
});

test('range validation is inline, preserves inputs, and never exposes server error content', async (t) => {
	for (const admin of [false, true]) {
		const { page, state, event } = await fixture(t, { admin });
		state.failure = { status: 400, message: 'private server content' };
		for (const query of ['?date_range=custom&date_from=1405-13-42&date_to=1405-08-01', '?date_range=invalid', '?date_range=custom&date_from=&date_to=', '?date_range=today&date_range=custom']) {
			const request = event(undefined, query);
			const result = page.load(request);
			assert.equal(result.statistics, null);
			assert.match(result.validationError, /valid date range/);
			for (const key of ['date_from', 'date_to']) assert.equal(result.filters[key], request.url.searchParams.get(key) ?? '');
			assert.equal(result.filters.date_range, request.url.searchParams.get('date_range'));
			assert.doesNotMatch(JSON.stringify(result), /private server content/);
		}
	}
});

test('authorization errors stay errors and unexpected failures are not hidden as invalid ranges', async (t) => {
	const { page, state, event } = await fixture(t);
	for (const status of [401, 403]) {
		state.failure = { status, message: 'private server content' };
		assert.throws(() => page.load(event()), (caught) => caught.status === status && caught.body.message === 'Forbidden');
	}
	state.failure = new Error('Database unavailable');
	assert.throws(() => page.load(event()), (caught) => caught === state.failure);
});

test('page loads integrate the real statistics contract, preserve integer identities and recover invalid ranges', async (t) => {
	for (const admin of [false, true]) {
		const { page, state, event } = await fixture(t, { admin, realStatistics: true });
		const queries = [];
		state.db.prepare = (sql) => ({ get: (...values) => { queries.push({ sql, values }); return state.result.totals; } });
		const result = page.load(event(undefined, '?date_range=custom&date_from=1405-08-01&date_to=1405-08-23'));
		assert.equal(result.statistics.scope, admin ? 'all' : 'assigned');
		assert.deepEqual(queries[0].values, admin ? ['1405-08-01', '1405-08-23'] : ['1405-08-01', '1405-08-23', 1, 1]);
		assert.equal(result.statistics.totals, state.result.totals);
		for (const query of ['?date_range=custom&date_from=1405-13-42&date_to=1405-08-01', '?date_range=custom&date_from=1405-08-23&date_to=1405-08-01', '?date_range=today&date_range=custom']) {
			const invalid = page.load(event(undefined, query));
			assert.equal(invalid.statistics, null);
			assert.match(invalid.validationError, /valid date range/);
		}
		assert.equal(queries.length, 1);
		assert.equal(page.load(event(undefined, '?date_range=&date_from=stale&date_to=stale')).filters.date_range, '7-days');
		assert.equal(page.load(event(undefined, '?date_range=today&date_from=stale&date_to=stale')).statistics.range.preset, 'today');
		assert.throws(() => page.load(event({ id: '1', role: admin ? 'admin' : 'resident' })), { status: 403 });
	}
});

test('shared statistics component and both pages compile and SSR every aggregate card without patient information', async () => {
	for (const path of [componentPath, '../src/routes/statistics/+page.svelte', '../src/routes/admin/statistics/+page.svelte']) {
		const { Component } = await compiledComponent(path);
		const data = sampleData();
		const { body } = render(Component, { props: { data } });
		assert.match(body, /Study statistics/);
		assert.match(body, /method="GET"/);
		assert.doesNotMatch(body, /method="POST"|patient_name|accession_number|recording_id/);
		for (const preset of statisticsPresets) assert.ok(body.includes(`value="${preset.value}"`), preset.value);
		for (const metric of statisticsMetrics) {
			assert.ok(body.includes(metric.label), metric.key);
			assert.ok(body.includes(data.statistics.totals[metric.key].toLocaleString('en-US')), metric.key);
		}
		for (const explanation of [/Asia\/Tehran/, /exam date/, /not creation, reporting or signing activity/, /inclusive/, /active studies only and may overlap/, /report file path on every recording/, /resident, attending and typist signatures on every recording/]) assert.match(body, explanation);
		assert.match(body, /sm:grid-cols-2/);
	}
});

test('scope help explains current assignment and personally signed typist visibility', async () => {
	const { Component } = await compiledComponent(componentPath);
	for (const [scope, expected] of [['all', /All studies/], ['assigned', /study-level or recording-level assignments; for attendings, study-level assignments only/], ['signed', /currently signed recording personally signed by you as typist/]]) {
		const { body } = render(Component, { props: { data: sampleData(scope) } });
		assert.match(body, expected);
	}
});

test('invalid custom input is escaped and preserved beside an accessible error without stale totals', async () => {
	const { Component } = await compiledComponent(componentPath);
	const data = { ...sampleData(), statistics: null, filters: { date_range: 'custom', date_from: '<script>invalid</script>', date_to: '1405-08-01' }, validationError: 'Select a valid date range.' };
	const { body } = render(Component, { props: { data } });
	assert.match(body, /role="alert"/);
	assert.match(body, /Select a valid date range/);
	assert.match(body, /name="date_from"[^>]*value="&lt;script>/);
	assert.match(body, /name="date_to"[^>]*value="1405-08-01"/);
	assert.doesNotMatch(body, /<script>|statistics-totals-heading|statistics-status-heading/);
});
