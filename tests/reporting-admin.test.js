import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { compile } from 'svelte/compiler';
import { DEFAULT_REPORT_GENERATION_SETTINGS, REPORT_GENERATION_MODES } from '../src/lib/report-generation-models.js';
import { DEFAULT_GPT_AUDIO_SETTINGS, GPT_AUDIO_SUBSTITUTES, MAX_GPT_AUDIO_LIMIT_SECONDS } from '../src/lib/gpt-audio-settings.js';

const admin = { user: { id: 1, role: 'admin' } };
const routeUrl = new URL('../src/routes/admin/reporting/+page.server.js', import.meta.url);

async function fixture(t, env = {}, initialValue) {
	const state = { value: initialValue, audioValue: undefined, dbCalls: 0, writes: 0, env };
	const key = randomUUID();
	globalThis[key] = state;
	t.after(() => delete globalThis[key]);
	state.db = {
		prepare(sql) {
			const field = sql.includes("'gpt_audio_settings'") ? 'audioValue' : 'value';
			if (sql.startsWith('SELECT')) return { get: () => state[field] === undefined ? undefined : { value: state[field] } };
			assert.match(sql, /INSERT INTO application_settings/);
			return { run(value) { state[field] = value; state.writes++; } };
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
	async function submitAudio(limitSeconds, substitute = '', extra = {}) {
		const form = new FormData();
		form.set('section', 'gpt_audio');
		if (limitSeconds !== undefined) form.set('limitSeconds', limitSeconds);
		if (substitute !== undefined) form.set('substitute', substitute);
		for (const [key, value] of Object.entries(extra)) form.append(key, value);
		return page.actions.default({ locals: admin, request: new Request('http://localhost/admin/reporting', { method: 'POST', body: form }) });
	}
	return { state, page, submit, submitAudio };
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

test('default stays unchanged and load exposes settings, recovery warnings and key booleans', async (t) => {
	for (const env of [{}, { ELEVENLABS_API_KEY: 'synthetic-elevenlabs-secret' }, { OPENAI_API_KEY: 'synthetic-openai-secret', ELEVENLABS_API_KEY: 'synthetic-elevenlabs-secret' }]) {
		const { page, state } = await fixture(t, env);
		const data = page.load({ locals: admin });
		assert.deepEqual(data, {
			settings: DEFAULT_REPORT_GENERATION_SETTINGS,
			recoveryWarning: null,
			gptAudioSettings: DEFAULT_GPT_AUDIO_SETTINGS,
			gptAudioRecoveryWarning: null,
			configured: { openai: Boolean(env.OPENAI_API_KEY), elevenlabs: Boolean(env.ELEVENLABS_API_KEY) }
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

test('reporting UI stays concise, compiles accessibly and retains essential warnings and save behavior', () => {
	const source = readFileSync(new URL('../src/routes/admin/reporting/+page.svelte', import.meta.url), 'utf8');
	for (const generate of ['server', 'client']) {
		assert.deepEqual(compile(source, { generate }).warnings, []);
	}
	for (const pattern of [/use:enhance/, /name="mode"/, /id="reporting-mode"/, /for="reporting-mode"/, /aria-describedby="mode-help"/, /aria-busy=\{saving\}/, /disabled=\{saving\}/, /result\.type === 'success'/, /role="status">Reporting settings saved\./, /role="alert"/, /Save settings/, /max-w-full/, /each REPORT_GENERATION_MODES/, /mode === 'direct_audio'/, /Requires FFmpeg/, /shared GPT Audio total recording limit/, /OPENAI_API_KEY is missing/, /future processing only/, /Existing reports are unchanged/, /Review generated reports before signing/]) {
		assert.match(source, pattern);
	}
	assert.doesNotMatch(source, /pipeline-help|direct-help|scope-help|fixed gpt-6\.1-sol|all ordered audio parts/);
	const layout = readFileSync(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
	assert.match(layout, /\{#if data\.user\?\.role === 'admin'\}[^]*?href=\{resolve\('\/admin\/reporting'\)\}[^]*?>Reporting settings<[^]*?\{\/if\}/);
});

test('GPT Audio saves independently before mode validation and all dedicated choices reload', async (t) => {
	const { page, state, submit, submitAudio } = await fixture(t);
	await submit('direct_audio');
	const reportingValue = state.value;
	const choices = [null, ...GPT_AUDIO_SUBSTITUTES.flatMap((provider) => provider.models.map((model) => ({ provider: provider.id, model: model.id })))];
	for (const [index, substitute] of choices.entries()) {
		const limitSeconds = index === 0 ? MAX_GPT_AUDIO_LIMIT_SECONDS : 601 + index;
		const settings = { limitSeconds, substitute };
		const result = await submitAudio(String(limitSeconds), substitute ? `${substitute.provider}:${substitute.model}` : '', { mode: 'invalid-mode' });
		assert.deepEqual(result, { section: 'gpt_audio', success: true, gptAudioSettings: settings });
		assert.deepEqual(JSON.parse(state.audioValue), settings);
		assert.deepEqual(page.load({ locals: admin }).gptAudioSettings, settings);
		assert.equal(state.value, reportingValue);
		const reloaded = await fixture(t, {}, reportingValue);
		reloaded.state.audioValue = state.audioValue;
		assert.deepEqual(reloaded.page.load({ locals: admin }).gptAudioSettings, settings);
	}
	const audioValue = state.audioValue;
	await submit('transcribe_then_generate');
	assert.equal(state.audioValue, audioValue);
	assertNoSecrets(page.load({ locals: admin }));
});

test('invalid GPT Audio form data is rejected without reading or changing any database setting', async (t) => {
	const { state, submitAudio } = await fixture(t);
	await submitAudio('600');
	const saved = state.audioValue;
	const calls = state.dbCalls;
	for (const [limit, substitute, extra] of [
		[undefined, ''], ['', ''], ['0', ''], ['-1', ''], ['1.5', ''], ['Infinity', ''], ['NaN', ''],
		['1e3', ''], [' 600', ''], [String(MAX_GPT_AUDIO_LIMIT_SECONDS + 1), ''],
		['9999999999999999999999999999', ''], [new Blob(['x']), ''], ['600', new Blob(['x'])],
		['600', 'openai:gpt-audio-1.5'], ['600', 'openai:scribe_v2'], ['600', 'elevenlabs:gpt-transcribe'],
		['600', 'openai:gpt-transcribe:extra'], ['600', '<script>synthetic-openai-secret'],
		['600', '', { limitSeconds: '1' }], ['600', '', { substitute: 'openai:gpt-transcribe' }]
	]) {
		const result = await submitAudio(limit, substitute, extra);
		assert.equal(result.status, 400);
		assert.equal(result.data.section, 'gpt_audio');
		assertNoSecrets(result);
		assert.equal(state.audioValue, saved);
		assert.equal(state.value, undefined);
	}
	assert.equal(state.dbCalls, calls);
	assert.equal(state.writes, 1);
});

test('GPT Audio recovery never writes defaults or repairs the wrong section', async (t) => {
	for (const corrupt of ['not json synthetic-openai-secret', 'null', '{}', '{"limitSeconds":0,"substitute":null}', '{"limitSeconds":600,"substitute":{"provider":"openai","model":"gpt-audio-1.5"}}', '{"limitSeconds":600,"substitute":null,"secret":"synthetic-elevenlabs-secret"}']) {
		const { state, page, submit, submitAudio } = await fixture(t);
		state.audioValue = corrupt;
		let data = page.load({ locals: admin });
		assert.deepEqual(data.gptAudioSettings, DEFAULT_GPT_AUDIO_SETTINGS);
		assert.match(data.gptAudioRecoveryWarning, /recovery only/);
		assert.match(data.gptAudioRecoveryWarning, /Save GPT Audio settings to repair/);
		assertNoSecrets(data);
		assert.equal(state.writes, 0);
		assert.equal(state.audioValue, corrupt);
		await submit('direct_audio');
		assert.equal(state.audioValue, corrupt);
		assert.ok(page.load({ locals: admin }).gptAudioRecoveryWarning);
		await submitAudio('700', 'elevenlabs:scribe_v2_medical');
		data = page.load({ locals: admin });
		assert.equal(data.gptAudioRecoveryWarning, null);
		assert.equal(data.settings.mode, 'direct_audio');
	}
});

test('GPT Audio save failures are safe and real database load errors are not recovery errors', async (t) => {
	const { state, page, submitAudio } = await fixture(t);
	const prepare = state.db.prepare;
	state.db.prepare = (sql) => {
		if (sql.includes("'gpt_audio_settings'")) throw new Error('synthetic-openai-secret');
		return prepare(sql);
	};
	const result = await submitAudio('600');
	assert.equal(result.status, 500);
	assert.deepEqual(result.data, { section: 'gpt_audio', error: 'Unable to save GPT Audio settings. Try again.' });
	assertNoSecrets(result);
	assert.throws(() => page.load({ locals: admin }), /synthetic-openai-secret/);
	assert.equal(state.writes, 0);
});

test('GPT Audio controls use a separate form, accessible seconds input and dedicated choices', () => {
	const source = readFileSync(new URL('../src/routes/admin/reporting/+page.svelte', import.meta.url), 'utf8');
	assert.equal((source.match(/<form /g) ?? []).length, 2);
	for (const pattern of [/name="section" value="gpt_audio"/, /name="limitSeconds" type="number" min="1"/, /max=\{MAX_GPT_AUDIO_LIMIT_SECONDS\} step="1" required/, /name="substitute"/, /each GPT_AUDIO_SUBSTITUTES/, /Disabled \(stop processing above the limit\)/, /gptAudioRecoveryWarning/, /ELEVENLABS_API_KEY is missing/, /future processing/, /Primary transcription selection is unchanged/, /Save GPT Audio settings/]) assert.match(source, pattern);
	assert.doesNotMatch(source, /10 minutes|per audio part/);
});

test('enhanced forms reset only their own draft after success and keep all drafts after failure', async () => {
	const source = readFileSync(new URL('../src/routes/admin/reporting/+page.svelte', import.meta.url), 'utf8');
	const callbacks = [...source.matchAll(/use:enhance=\{(\(\) => \{[^]*?\n\t\})\}/g)].map((match) => match[1]);
	assert.equal(callbacks.length, 2);
	for (const [index, callback] of callbacks.entries()) {
		for (const type of ['success', 'failure']) {
			const state = { selection: 'direct_audio', audioSelection: 'elevenlabs:scribe_v2', limitSelection: '1800', saving: false, savingAudio: false };
			const enhance = new Function('state', `with (state) { return (${callback}); }`)(state);
			const completion = enhance();
			assert.equal(state[index === 0 ? 'saving' : 'savingAudio'], true);
			let updates = 0;
			await completion({ result: { type }, update: async (options) => {
				assert.deepEqual(options, { reset: false }, 'Native form resets must not replace the saved reactive selections');
				updates++;
			} });
			assert.equal(updates, 1);
			assert.equal(state.saving, false);
			assert.equal(state.savingAudio, false);
			assert.equal(state.selection, index === 0 && type === 'success' ? null : 'direct_audio');
			assert.equal(state.audioSelection, index === 1 && type === 'success' ? null : 'elevenlabs:scribe_v2');
			assert.equal(state.limitSelection, index === 1 && type === 'success' ? null : '1800');
		}
	}
	assert.match(source, /let limitSeconds = \$derived\(limitSelection \?\? audio.limitSeconds\)/);
	assert.match(source, /oninput=\{\(event\) => limitSelection = event.currentTarget.value\}/);
});
