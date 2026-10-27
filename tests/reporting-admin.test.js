import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { compile } from 'svelte/compiler';
import { DEFAULT_REPORT_GENERATION_SETTINGS, REPORT_GENERATION_MODES } from '../src/lib/report-generation-models.js';

const admin = { user: { id: 1, role: 'admin' } };
const routeUrl = new URL('../src/routes/admin/reporting/+page.server.js', import.meta.url);

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
	async function submit(mode, locals = admin) {
		const form = new FormData();
		if (mode !== undefined) form.set('mode', mode);
		return page.actions.default({ locals, request: new Request('http://localhost/admin/reporting', { method: 'POST', body: form }) });
	}
	return { state, page, submit };
}

function assertNoSecrets(value) {
	const serialized = JSON.stringify(value);
	for (const secret of ['synthetic-openai-secret', 'synthetic-elevenlabs-secret', '<script>']) assert.ok(!serialized.includes(secret));
}

test('every load and save checks fresh administrator authorization before database or request access', async (t) => {
	const { state, page, submit } = await fixture(t);
	await submit('direct_audio');
	const calls = state.dbCalls;
	const writes = state.writes;
	for (const user of [undefined, { role: 'resident' }, { role: 'attending' }, { role: 'typist' }]) {
		const check = (caught) => {
			assert.equal(caught.status, user ? 403 : 302);
			if (!user) assert.equal(caught.location, '/login');
			return true;
		};
		const event = { locals: { user }, get request() { throw new Error('Unauthorized request was read'); } };
		assert.throws(() => page.load(event), check);
		await assert.rejects(page.actions.default(event), check);
	}
	assert.equal(state.dbCalls, calls);
	assert.equal(state.writes, writes);
});

test('default stays unchanged and load exposes only settings, recovery warning and OpenAI key boolean', async (t) => {
	for (const env of [{}, { ELEVENLABS_API_KEY: 'synthetic-elevenlabs-secret' }, { OPENAI_API_KEY: 'synthetic-openai-secret', ELEVENLABS_API_KEY: 'synthetic-elevenlabs-secret' }]) {
		const { page, state } = await fixture(t, env);
		const data = page.load({ locals: admin });
		assert.deepEqual(data, {
			settings: DEFAULT_REPORT_GENERATION_SETTINGS,
			recoveryWarning: null,
			configured: { openai: Boolean(env.OPENAI_API_KEY) }
		});
		assert.equal(data.settings.mode, 'transcribe_then_generate');
		assert.equal(state.writes, 0);
		assertNoSecrets(data);
	}
});

test('all supported modes persist and survive a fresh route instance without requiring a key', async (t) => {
	const { page, state, submit } = await fixture(t);
	for (const { id } of REPORT_GENERATION_MODES) {
		const settings = { mode: id };
		assert.deepEqual(await submit(id), { success: true, settings });
		assert.deepEqual(JSON.parse(state.value), settings);
		assert.deepEqual(page.load({ locals: admin }).settings, settings);
		const reloaded = await fixture(t, {}, state.value);
		assert.deepEqual(reloaded.page.load({ locals: admin }).settings, settings);
	}
	assert.equal(state.writes, REPORT_GENERATION_MODES.length);
});

test('invalid mode returns safe 400 before database access and never echoes submitted input', async (t) => {
	const { state, submit } = await fixture(t);
	await submit('direct_audio');
	const saved = state.value;
	const calls = state.dbCalls;
	for (const mode of [undefined, '', 'DIRECT_AUDIO', 'unknown', 'synthetic-openai-secret', '<script>', new Blob(['synthetic-elevenlabs-secret'])]) {
		const result = await submit(mode);
		assert.equal(result.status, 400);
		assert.deepEqual(result.data, { error: 'Select a supported reporting mode.' });
		assertNoSecrets(result);
		assert.equal(state.dbCalls, calls);
		assert.equal(state.value, saved);
		assert.equal(state.writes, 1);
	}
});

test('corrupt saved config is recoverable only through explicit Save and does not leak stored content', async (t) => {
	for (const corrupt of ['not json synthetic-openai-secret', 'null', '{"mode":"synthetic-elevenlabs-secret"}', '{"mode":"<script>"}']) {
		const { page, state, submit } = await fixture(t, {}, corrupt);
		const data = page.load({ locals: admin });
		assert.deepEqual(data.settings, DEFAULT_REPORT_GENERATION_SETTINGS);
		assert.match(data.recoveryWarning, /recovery only/);
		assert.match(data.recoveryWarning, /Save to repair/);
		assertNoSecrets(data);
		assert.equal(state.value, corrupt);
		assert.equal(state.writes, 0);
		assert.equal((await submit('direct_audio')).success, true);
		assert.equal(page.load({ locals: admin }).recoveryWarning, null);
		assert.equal(state.writes, 1);
	}
});

test('database save failures are safe and unrelated load failures are not disguised as config recovery', async (t) => {
	const { state, page, submit } = await fixture(t);
	state.db.prepare = () => { throw new Error('synthetic-openai-secret'); };
	const result = await submit('direct_audio');
	assert.equal(result.status, 500);
	assert.deepEqual(result.data, { error: 'Unable to save reporting settings. Try again.' });
	assertNoSecrets(result);
	assert.throws(() => page.load({ locals: admin }), /synthetic-openai-secret/);
});

test('reporting UI compiles without accessibility warnings and documents explicit, future-only behavior', () => {
	const source = readFileSync(new URL('../src/routes/admin/reporting/+page.svelte', import.meta.url), 'utf8');
	for (const generate of ['server', 'client']) {
		assert.deepEqual(compile(source, { generate }).warnings, []);
	}
	for (const pattern of [/use:enhance/, /name="mode"/, /id="reporting-mode"/, /for="reporting-mode"/, /aria-describedby="pipeline-help direct-help scope-help"/, /aria-busy=\{saving\}/, /disabled=\{saving\}/, /result\.type === 'success'/, /role="status">Reporting settings saved\./, /role="alert"/, /Save settings/, /max-w-full/, /all ordered audio parts, templates/, /assigned attending's English preference/, /text output only/, /skips separate OpenAI\/ElevenLabs transcription/, /gpt-6\.1-sol/, /Transcription settings are retained/, /Both modes require OPENAI_API_KEY/, /10 minutes of total audio/, /Docker installs ffmpeg automatically/, /FFMPEG_PATH/, /future processing only/, /no automatic fallback or regeneration/, /Signed reports and existing clinical permissions remain unchanged/, /experimental; accuracy is not guaranteed/]) {
		assert.match(source, pattern);
	}
	const layout = readFileSync(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
	assert.match(layout, /\{#if data\.user\?\.role === 'admin'\}[^]*?href=\{resolve\('\/admin\/reporting'\)\}[^]*?>Reporting settings<[^]*?\{\/if\}/);
});
