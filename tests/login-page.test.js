import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';

const source = readFileSync(new URL('../src/routes/login/+page.svelte', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;

function controller(response) {
	const script = source.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;$/gm, '');
	const requests = [];
	const events = [];
	const ui = new Function('fetch', 'invalidateAll', 'goto', `
		${script}
		return { onSubmit, setCredentials: (name, secret) => { username = name; password = secret; },
			snapshot: () => ({ loading, error }) };
	`)(async (url, options) => { requests.push({ url, options }); return response; },
		async () => { events.push('invalidate'); }, (url) => { events.push(url); });
	return { ...ui, requests, events };
}

test('login alone is centered in the shared content area; login and layout compile for both targets', () => {
	for (const name of ['flex', 'items-center', 'justify-center'])
		assert.ok(layout.includes(`class:${name}={page.route.id === '/login'}`));
	for (const [filename, content] of [['Login.svelte', source], ['Layout.svelte', layout]]) {
		for (const generate of ['server', 'client'])
			assert.deepEqual(compile(content, { filename, generate }).warnings, []);
	}
});

test('login renders a responsive neutral card with accessible credentials and shared typography', async () => {
	const compiled = compile(source, { filename: 'Login.svelte', generate: 'server' }).js.code
		.replace(/from (['"])([^'"]+)\1/g, (_match, _quote, specifier) => `from ${JSON.stringify(specifier === '$app/navigation'
			? moduleUrl('export const goto = () => {}; export const invalidateAll = async () => {};')
			: import.meta.resolve(specifier))}`);
	const { default: Component } = await import(moduleUrl(compiled));
	const html = render(Component).body;
	assert.match(html, /max-w-md/);
	assert.match(html, /rounded-2xl border border-slate-200 bg-white/);
	assert.match(html, /id="login-title" class="page-title"/);
	assert.match(html, /aria-labelledby="login-title"/);
	assert.match(html, /autocomplete="username"/);
	assert.match(html, /type="password"/);
	assert.match(html, /autocomplete="current-password"/);
	assert.doesNotMatch(html, /pink|text-3xl/);
	assert.match(html, /btn btn-primary/);
});

test('sign in preserves credentials payload, session refresh and study navigation', async () => {
	const ui = controller({ ok: true });
	ui.setCredentials('test-user', 'synthetic-password');
	await ui.onSubmit({ preventDefault() {} });
	assert.deepEqual(ui.requests, [{ url: '/api/auth/login', options: {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username: 'test-user', password: 'synthetic-password' })
	} }]);
	assert.deepEqual(ui.events, ['invalidate', '/studies']);
	assert.deepEqual(ui.snapshot(), { loading: false, error: '' });
});

test('failed sign in displays the error without navigation and resets loading', async () => {
	for (const [response, message] of [
		[{ ok: false, json: async () => ({ error: 'Invalid credentials' }) }, 'Invalid credentials'],
		[{ ok: false, json: async () => { throw new Error('Invalid JSON'); } }, 'Login failed']
	]) {
		const ui = controller(response);
		await ui.onSubmit({ preventDefault() {} });
		assert.deepEqual(ui.snapshot(), { loading: false, error: message });
		assert.deepEqual(ui.events, []);
	}
	assert.match(source, /role="alert"/);
	assert.match(source, /disabled=\{loading\}/);
	assert.match(source, /aria-busy=\{loading\}/);
});
