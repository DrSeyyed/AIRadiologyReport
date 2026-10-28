import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { compile } from 'svelte/compiler';
import { DEFAULT_TRANSCRIPTION_SETTINGS, TRANSCRIPTION_PROVIDERS } from '../src/lib/transcription-models.js';

const locals = { user: { id: 1, role: 'admin' } };
const routeUrl = new URL('../src/routes/admin/transcription/+page.server.js', import.meta.url);

async function fixture(t, env = {}, initialValue) {
	const state = { value: initialValue, dbCalls: 0, writes: 0, env };
	const key = randomUUID();
	globalThis[key] = state;
	t.after(() => delete globalThis[key]);
	state.db = {
		prepare(sql) {
			if (sql.startsWith('SELECT')) return { get: () => state.value === undefined ? undefined : { value: state.value } };
			assert.match(sql, /INSERT INTO application_settings/);
			return { run(value) { state.value = value; state.writes++; } };
		}
	};
	const source = readFileSync(routeUrl, 'utf8')
		.replaceAll('process.env', `globalThis[${JSON.stringify(key)}].env`)
		.replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
			let target;
			if (specifier === '$lib/server/db') {
				target = `data:text/javascript,${encodeURIComponent(`export function getDb(){const state=globalThis[${JSON.stringify(key)}];state.dbCalls++;return state.db;}`)}`;
			} else if (specifier.startsWith('$lib/')) target = new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href;
			else target = import.meta.resolve(specifier);
			return `from ${JSON.stringify(target)}`;
		});
	const page = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
	async function submit(provider, model) {
		const form = new FormData();
		if (provider !== undefined) form.set('provider', provider);
		if (model !== undefined) form.set('model', model);
		return page.actions.default({ locals, request: new Request('http://localhost/admin/transcription', { method: 'POST', body: form }) });
	}
	return { state, page, submit };
}

function assertNoSecrets(value) {
	const serialized = JSON.stringify(value);
	for (const secret of ['private-openai-secret', 'private-elevenlabs-secret']) assert.ok(!serialized.includes(secret));
}

test('load and action require admin before accessing database or request', async (t) => {
	const { state, page } = await fixture(t);
	for (const user of [undefined, { role: 'resident' }, { role: 'attending' }, { role: 'typist' }]) {
		const check = (caught) => {
			assert.equal(caught.status, user ? 403 : 302);
			if (!user) assert.equal(caught.location, '/login');
			return true;
		};
		assert.throws(() => page.load({ locals: { user } }), check);
		await assert.rejects(page.actions.default({ locals: { user } }), check);
	}
	assert.equal(state.dbCalls, 0);
	assert.equal(state.writes, 0);
});

test('default load exposes only boolean key flags and never automatically switches providers', async (t) => {
	for (const env of [{}, { ELEVENLABS_API_KEY: 'private-elevenlabs-secret' }, { OPENAI_API_KEY: 'private-openai-secret', ELEVENLABS_API_KEY: 'private-elevenlabs-secret' }]) {
		const { page, state } = await fixture(t, env);
		const data = page.load({ locals });
		assert.deepEqual(data.settings, DEFAULT_TRANSCRIPTION_SETTINGS);
		assert.deepEqual(data.configured, { openai: Boolean(env.OPENAI_API_KEY), elevenlabs: Boolean(env.ELEVENLABS_API_KEY) });
		assert.equal(data.recoveryWarning, null);
		assert.equal(state.writes, 0);
		assertNoSecrets(data);
	}
});

test('every catalog pair saves and reloads persistently even without keys', async (t) => {
	const { page, state, submit } = await fixture(t);
	for (const provider of TRANSCRIPTION_PROVIDERS) {
		for (const model of provider.models) {
			const settings = { provider: provider.id, model: model.id };
			const result = await submit(provider.id, model.id);
			assert.deepEqual(result, { success: true, settings });
			assert.deepEqual(JSON.parse(state.value), settings);
			assert.deepEqual(page.load({ locals }).settings, settings);
			const reloaded = await fixture(t, {}, state.value);
			assert.deepEqual(reloaded.page.load({ locals }).settings, settings);
		}
	}
});

test('invalid and cross-provider pairs return safe 400 without database access or unvalidated echoes', async (t) => {
	const { page, submit, state } = await fixture(t, { OPENAI_API_KEY: 'private-openai-secret', ELEVENLABS_API_KEY: 'private-elevenlabs-secret' });
	await submit('elevenlabs', 'scribe_v2_medical');
	const saved = state.value;
	const calls = state.dbCalls;
	for (const pair of [[undefined, undefined], ['openai', undefined], ['openai', 'scribe_v2'], ['elevenlabs', 'gpt-transcribe'], ['private-openai-secret', 'private-elevenlabs-secret'], ['<script>', '<script>'], [new Blob(['x']), 'gpt-transcribe'], ['openai', new Blob(['x'])]]) {
		const result = await submit(...pair);
		assert.equal(result.status, 400);
		assert.deepEqual(Object.keys(result.data), ['error']);
		assert.equal(result.data.error, 'Select a supported transcription provider and model pair.');
		assertNoSecrets(result);
		assert.equal(state.value, saved);
	}
	assert.equal(state.dbCalls, calls);
	assertNoSecrets(page.load({ locals }));
});

test('corrupt persisted settings show defaults with an explicit recovery warning until Save', async (t) => {
	for (const corrupt of ['not json private-openai-secret', 'null', '{"provider":"other","model":"private-elevenlabs-secret"}', '{"provider":"openai","model":"scribe_v2"}']) {
		const { page, state, submit } = await fixture(t, {}, corrupt);
		const data = page.load({ locals });
		assert.deepEqual(data.settings, DEFAULT_TRANSCRIPTION_SETTINGS);
		assert.match(data.recoveryWarning, /Save to repair/);
		assert.equal(state.value, corrupt);
		assert.equal(state.writes, 0);
		assertNoSecrets(data);
		assert.equal((await submit('openai', 'gpt-transcribe')).success, true);
		assert.equal(page.load({ locals }).recoveryWarning, null);
	}
});

test('persistence failures return a generic error without secrets', async (t) => {
	const { state, submit } = await fixture(t);
	state.db.prepare = () => { throw new Error('private-openai-secret private-elevenlabs-secret'); };
	const result = await submit('openai', 'gpt-transcribe');
	assert.equal(result.status, 500);
	assert.equal(result.data.error, 'Unable to save transcription settings. Try again.');
	assertNoSecrets(result);
});

test('page compiles accessibly and uses enhanced forms, dependent model options and admin-only navigation', () => {
	const source = readFileSync(new URL('../src/routes/admin/transcription/+page.svelte', import.meta.url), 'utf8');
	for (const generate of ['server', 'client']) {
		assert.deepEqual(compile(source, { generate }).warnings, []);
	}
	assert.match(source, /use:enhance/);
	assert.match(source, /name="provider"/);
	assert.match(source, /name="model"/);
	assert.match(source, /model: next\.models\[0\]\.id/);
	assert.match(source, /each models as entry/);
	assert.match(source, /February 26, 2027/);
	assert.match(source, /Used only in Transcribe, then generate mode/);
	assert.match(source, /aria-describedby="model-help"/);
	assert.match(source, /OPENAI_API_KEY is missing/);
	assert.match(source, /ELEVENLABS_API_KEY is missing/);
	assert.match(source, /label\.includes\('\(legacy\)'\)/);
	assert.match(source, /model === DIRECT_AUDIO_MODEL/);
	assert.match(source, /total GPT Audio recording limit and substitute/);
	assert.match(source, /href=\{resolve\('\/admin\/reporting'\)\}/);
	assert.doesNotMatch(source, /10 minutes|per audio part/);
	assert.doesNotMatch(source, /audio-model-help|Chat Completions|gpt-6\.1-sol|Compare transcription accuracy/);
	const layout = readFileSync(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
	assert.match(layout, /\{#if data\.user\?\.role === 'admin'\}[^]*?href=\{resolve\('\/admin\/transcription'\)\}[^]*?\{\/if\}/);
});

test('enhanced save keeps the selected GPT Audio model visible and preserves drafts on failure', async () => {
	const source = readFileSync(new URL('../src/routes/admin/transcription/+page.svelte', import.meta.url), 'utf8');
	const callback = source.match(/use:enhance=\{\(\) => (async \(\{ result, update \}\) => \{[^]*?\n\t\})\}/)?.[1];
	assert.ok(callback);
	for (const type of ['success', 'failure', 'error']) {
		const selected = { provider: 'openai', model: 'gpt-audio-1.5' };
		const state = { selection: selected };
		const completion = new Function('state', `with (state) { return (${callback}); }`)(state);
		let visibleModel = selected.model;
		let updates = 0;
		await completion({ result: { type }, update: async (options) => {
			if (type === 'success' && options?.reset !== false) visibleModel = 'gpt-transcribe';
			assert.deepEqual(options, { reset: false });
			updates++;
		} });
		assert.equal(updates, 1);
		assert.equal(visibleModel, 'gpt-audio-1.5');
		assert.deepEqual(state.selection, type === 'success' ? null : selected);
	}
});
