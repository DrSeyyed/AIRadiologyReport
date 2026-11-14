import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';

const route = '../src/routes/admin/telegram-study-refresh/';
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const component = read(`${route}TelegramStudyRefresh.svelte`);
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const reply = (body, ok = true) => ({ ok, json: async () => body });

function controller(fetch, confirmed = true) {
	const script = component.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;$/gm, '');
	let mount;
	let cleanup;
	let nextTimer = 0;
	const timers = new Map();
	const confirmations = [];
	const api = new Function('onMount', '$state', 'resolve', 'fetch', 'window', 'setTimeout', 'clearTimeout', `
		${script}
		return { refresh, loadStatus, snapshot: () => ({ status, sending, error, message }) };
	`)(
		(callback) => { mount = callback; },
		(value) => value,
		(path) => `/base${path}`,
		fetch,
		{ confirm: (message) => { confirmations.push(message); return confirmed; } },
		(callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
		(id) => timers.delete(id)
	);
	return {
		...api, timers, confirmations,
		async mount() { cleanup = mount(); await new Promise(setImmediate); },
		unmount() { cleanup(); },
		async poll() {
			assert.equal(timers.size, 1);
			const [id, timer] = timers.entries().next().value;
			timers.delete(id);
			assert.equal(timer.delay, 3000);
			await timer.callback();
		}
	};
}

async function renderComponent(status) {
	const source = component.replace('let status = $state(null);', `let status = $state(${JSON.stringify(status)});`);
	const compiled = compile(source, { filename: 'TelegramStudyRefresh.svelte', generate: 'server' }).js.code
		.replace(/from (['"])([^'"]+)\1/g, (_statement, _quote, specifier) => {
			const target = specifier === '$app/paths'
				? moduleUrl('export const resolve = (path) => path;') : import.meta.resolve(specifier);
			return `from ${JSON.stringify(target)}`;
		});
	const { default: Component } = await import(moduleUrl(compiled));
	return render(Component).body;
}

test('dedicated refresh page redirects anonymous users and rejects every non-admin role', async () => {
	const source = read(`${route}+page.server.js`).replace("from '@sveltejs/kit'", `from ${JSON.stringify(import.meta.resolve('@sveltejs/kit'))}`);
	const { load } = await import(moduleUrl(source));
	assert.throws(() => load({ locals: {} }), { status: 302, location: '/login' });
	for (const role of ['resident', 'attending', 'typist']) {
		assert.throws(() => load({ locals: { user: { role } } }), { status: 403 });
	}
	assert.deepEqual(load({ locals: { user: { role: 'admin' } } }), {});
});

test('refresh controls live only on the dedicated admin page and compile for server and client', () => {
	const page = read(`${route}+page.svelte`);
	assert.match(page, /<header class="space-y-1">/);
	assert.match(page, /<h1[^>]*>Telegram study message refresh<\/h1>/);
	assert.match(page, /<p class="text-sm text-base-content\/70">/);
	assert.match(page, /recreate missing messages.*Disabled studies stay marked disabled; reports and signatures are unchanged/);
	assert.match(page, /<TelegramStudyRefresh\s*\/>/);
	for (const path of ['../src/routes/studies/+page.svelte', '../src/routes/studies/StudyTable.svelte']) {
		assert.doesNotMatch(read(path), /TelegramStudyRefresh|\/api\/telegram\/study-refresh/);
	}
	assert.equal(existsSync(new URL('../src/routes/studies/TelegramStudyRefresh.svelte', import.meta.url)), false);
	for (const [filename, source] of [['+page.svelte', page], ['TelegramStudyRefresh.svelte', component]]) {
		for (const generate of ['server', 'client']) {
			assert.deepEqual(compile(source, { filename, generate }).warnings, []);
		}
	}
});

test('refresh retains global-scope confirmation, base-aware API requests and background progress polling', async () => {
	const requests = [];
	let status = { configured: true, total: 0, pending: 0 };
	const ui = controller(async (url, options) => {
		requests.push({ url, options });
		if (options?.method === 'POST') status = { configured: true, total: 2, pending: 2, queued: 2 };
		return reply(status);
	});
	await ui.mount();
	assert.equal(ui.timers.size, 0);
	await ui.refresh();
	assert.match(ui.confirmations[0], /including disabled studies.*ignores current filters.*Missing messages will be recreated.*reports and signatures will not change/);
	assert.deepEqual(requests[1], {
		url: '/base/api/telegram/study-refresh',
		options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
	});
	assert.match(ui.snapshot().message, /Queued 2 study messages.*continues if you leave this page/);
	await ui.refresh();
	assert.equal(requests.length, 3, 'bulk requests can include studies not covered by pending single-study work');
	status = { configured: true, total: 2, pending: 1, refreshed: 1, failed: 0, skipped: 0 };
	await ui.poll();
	assert.deepEqual(ui.snapshot().status, status);
	status = { ...status, pending: 0, refreshed: 2 };
	await ui.poll();
	assert.equal(ui.timers.size, 0);
	assert.equal(ui.snapshot().status.refreshed, 2);
	assert.ok(requests.every(({ url }) => url === '/base/api/telegram/study-refresh'));
	ui.unmount();
});

test('unconfigured, loading and cancelled refreshes never submit a job', async () => {
	for (const configured of [false, true]) {
		let requests = 0;
		const ui = controller(async () => { requests++; return reply({ configured, pending: 0 }); }, false);
		await ui.refresh();
		assert.equal(requests, 0);
		await ui.mount();
		await ui.refresh();
		assert.equal(requests, 1);
		assert.equal(ui.confirmations.length, configured ? 1 : 0);
		ui.unmount();
	}
});

test('running work resumes polling on entry, survives transient status errors and cancels polling on leave', async () => {
	let fail = false;
	const ui = controller(async () => fail ? reply({ error: 'Status unavailable' }, false) : reply({ configured: true, pending: 1 }));
	await ui.mount();
	assert.equal(ui.timers.size, 1);
	fail = true;
	await ui.poll();
	assert.equal(ui.snapshot().error, 'Status unavailable');
	assert.equal(ui.timers.size, 1);
	fail = false;
	await ui.poll();
	assert.equal(ui.snapshot().error, '');
	ui.unmount();
	assert.equal(ui.timers.size, 0);
});

test('queue outcomes and errors remain visible without duplicate submissions', async () => {
	for (const [result, ok, expected] of [
		[{ configured: true, pending: 1, already_running: true }, true, /already running/],
		[{ configured: true, pending: 0, queued: 0 }, true, /No studies found/],
		[{ error: 'Temporarily unavailable' }, false, /Temporarily unavailable/]
	]) {
		let finish;
		let submissions = 0;
		const ui = controller(async (_url, options) => {
			if (!options) return reply({ configured: true, pending: 0 });
			submissions++;
			return new Promise((resolve) => { finish = () => resolve(reply(result, ok)); });
		});
		await ui.mount();
		const pending = ui.refresh();
		assert.equal(ui.snapshot().sending, true);
		await ui.refresh();
		assert.equal(submissions, 1);
		finish();
		await pending;
		assert.equal(ui.snapshot().sending, false);
		assert.match(ok ? ui.snapshot().message : ui.snapshot().error, expected);
		ui.unmount();
	}
});

test('unmounted status requests cannot update state or restart polling', async () => {
	let finish;
	const ui = controller(() => new Promise((resolve) => { finish = resolve; }));
	await ui.mount();
	ui.unmount();
	finish(reply({ configured: true, pending: 2 }));
	await new Promise(setImmediate);
	assert.equal(ui.snapshot().status, null);
	assert.equal(ui.timers.size, 0);
});

test('refresh panel renders configuration guidance, progress counts, retry advice and allows extending pending work', async () => {
	assert.match(await renderComponent({ configured: false }), /Configure the Telegram bot token and study group first/);
	const pending = await renderComponent({ configured: true, total: 4, pending: 1, refreshed: 1, failed: 1, skipped: 1 });
	assert.doesNotMatch(pending, /<button[^>]*disabled/);
	assert.match(pending, /Pending: 1 · Refreshed \/ recovered: 1 · Failed: 1 · Skipped: 1/);
	assert.match(pending, /including disabled; ignores current filters/);
	const done = await renderComponent({ configured: true, total: 4, pending: 0, refreshed: 2, failed: 1, skipped: 1 });
	assert.doesNotMatch(done, /disabled(?:[\s=>])/);
	assert.match(done, /Check bot permissions and Telegram configuration, then refresh again to retry/);
});
