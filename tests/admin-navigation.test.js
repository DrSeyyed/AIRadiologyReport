import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { adminNavigation } from '../src/lib/admin-navigation.js';

const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const linksFor = (user) => adminNavigation(user).flatMap((group) => group.links);

async function component(path, route = '/admin') {
	const source = read(path).replace("import '../app.css';", '').replace("import favicon from '$lib/assets/favicon.svg';", "const favicon = 'favicon.svg';");
	for (const generate of ['client', 'server']) {
		const { warnings } = compile(source, { filename: path, generate });
		assert.deepEqual(warnings.filter((warning) => warning.code.startsWith('a11y')), []);
	}
	const output = compile(source, { filename: path, generate: 'server' }).js.code.replace(
		/from (['"])([^'"]+)\1/g,
		(_statement, _quote, specifier) => {
			const stubs = {
				'$app/paths': 'export const resolve = (path) => path;',
				'$app/navigation': 'export function goto(){}; export function invalidateAll(){}',
				'$app/state': `export const page = { route: { id: ${JSON.stringify(route)} } };`
			};
			const target = specifier in stubs ? moduleUrl(stubs[specifier])
				: specifier.startsWith('$lib/') ? new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href
					: import.meta.resolve(specifier);
			return `from ${JSON.stringify(target)}`;
		}
	);
	return (await import(moduleUrl(output))).default;
}

test('admin navigation includes every admin page once in meaningful groups', () => {
	const groups = adminNavigation({ role: 'admin' });
	assert.deepEqual(groups.map((group) => group.label), ['Clinical workflow', 'Telegram', 'System']);
	const links = linksFor({ role: 'admin' });
	assert.equal(new Set(links.map((link) => link.href)).size, links.length);
	for (const link of links) {
		assert.ok(link.label && link.description);
		assert.ok(existsSync(new URL(`../src/routes${link.href}/+page.svelte`, import.meta.url)), link.href);
	}
	const pages = readdirSync(new URL('../src/routes/admin/', import.meta.url), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(new URL(`../src/routes/admin/${entry.name}/+page.svelte`, import.meta.url)))
		.map((entry) => `/admin/${entry.name}`).sort();
	assert.deepEqual(links.map((link) => link.href).sort(), pages);
});

test('only eligible clinical roles retain template navigation; other admin links stay admin-only', () => {
	for (const role of ['resident', 'attending']) {
		assert.deepEqual(linksFor({ role }).map((link) => link.href), ['/admin/templates']);
	}
	for (const user of [null, undefined, {}, { role: 'typist' }, { role: 'unknown' }]) {
		assert.deepEqual(adminNavigation(user), []);
	}
});

test('admin overview requires administrator authorization', async () => {
	const source = read('../src/routes/admin/+page.server.js').replace("from '@sveltejs/kit'", `from ${JSON.stringify(import.meta.resolve('@sveltejs/kit'))}`);
	const { load } = await import(moduleUrl(source));
	assert.throws(() => load({ locals: {} }), { status: 302, location: '/login' });
	for (const role of ['resident', 'attending', 'typist']) {
		assert.throws(() => load({ locals: { user: { role } } }), { status: 403 });
	}
	assert.deepEqual(load({ locals: { user: { role: 'admin' } } }), {});
});

test('admin overview renders grouped tool descriptions and dedicated Telegram refresh entry', async () => {
	const Page = await component('../src/routes/admin/+page.svelte');
	const { body } = render(Page, { props: { data: { user: { role: 'admin' } } } });
	assert.match(body, /<h1[^>]*>Administration<\/h1>/);
	for (const link of linksFor({ role: 'admin' })) assert.ok(body.includes(`href="${link.href}"`), link.href);
	assert.match(body, /Refresh existing Telegram study messages and monitor progress/);
});

test('shared admin navigation highlights current page and shows only its category links', async () => {
	for (const group of adminNavigation({ role: 'admin' })) {
		for (const link of group.links) {
			const Layout = await component('../src/routes/admin/+layout.svelte', link.href);
			const { body } = render(Layout, { props: { data: { user: { role: 'admin' } } } });
			assert.match(body, /aria-label="Administration"/);
			assert.ok(body.includes(`aria-label="${group.label} pages"`));
			assert.equal((body.match(/aria-current="page"/g) ?? []).length, 1);
			assert.match(body, new RegExp(`href="${link.href}"[^>]*aria-current="page"`));
			for (const sibling of group.links) assert.ok(body.includes(`href="${sibling.href}"`));
			assert.doesNotMatch(body, /role="tab"|tabindex="-1"/);
		}
	}
	const Layout = await component('../src/routes/admin/+layout.svelte', '/admin/templates');
	for (const role of ['resident', 'attending']) {
		const { body } = render(Layout, { props: { data: { user: { role } } } });
		assert.doesNotMatch(body, /aria-label="Administration"|Clinical workflow|Report templates/);
		assert.doesNotMatch(body, /Admin overview|Telegram registrations|Storage &amp; Backups|href="\/admin\/users"/);
	}
});

test('root drawer has one admin panel entry while non-admins retain Account and eligible template access', async () => {
	const Layout = await component('../src/routes/+layout.svelte', '/admin/users');
	for (const user of [null, { role: 'typist' }, { role: 'resident' }, { role: 'attending' }, { role: 'admin' }]) {
		const { body } = render(Layout, { props: { data: { user } } });
		const drawer = body.slice(body.indexOf('<aside'));
		assert.equal(drawer.includes('Admin panel'), user?.role === 'admin');
		assert.equal(drawer.includes('Report templates'), ['resident', 'attending'].includes(user?.role));
		assert.equal(drawer.includes('href="/account"'), Boolean(user && user.role !== 'admin'));
		assert.equal(drawer.includes('href="/pathology-search"'), Boolean(user));
		assert.equal(drawer.includes('href="/favorites"'), Boolean(user));
		assert.equal(drawer.includes('href="/statistics"'), ['resident', 'attending', 'typist'].includes(user?.role));
		assert.doesNotMatch(drawer, /href="\/admin\/statistics"/);
		assert.doesNotMatch(drawer, /Admin overview|Telegram registrations|Storage &amp; Backups|Clinical workflow|href="\/admin\/users"|href="\/admin\/telegram-study-refresh"/);
		if (user?.role === 'admin') {
			assert.match(drawer, /href="\/admin"[^>]*aria-current="location"/);
			assert.equal((drawer.match(/<a\s/g) ?? []).length, 4);
		}
	}
});

test('favorites is a standalone dashboard entry and highlights only its own destination for every signed-in role', async () => {
	for (const route of ['/favorites', '/studies']) {
		const Layout = await component('../src/routes/+layout.svelte', route);
		for (const role of ['admin', 'resident', 'attending', 'typist']) {
			const { body } = render(Layout, { props: { data: { user: { role } } } });
			const drawer = body.slice(body.indexOf('<aside'));
			const anchor = drawer.match(/<a[^>]*href="\/favorites"[^>]*>My study favorites<\/a>/)?.[0];
			assert.ok(anchor);
			if (route === '/favorites') assert.match(anchor, /class="p-3 active"[^>]*aria-current="page"/);
			else assert.doesNotMatch(anchor, /aria-current=|\bactive\b/);
			assert.equal((drawer.match(/aria-current="page"/g) ?? []).length, 1);
			assert.doesNotMatch(drawer, /href="\/studies\/favorites"/);
		}
	}
});

test('statistics drawer entry is active for supported non-admins without exposing admin tools', async () => {
	const Layout = await component('../src/routes/+layout.svelte', '/statistics');
	for (const role of ['resident', 'attending', 'typist']) {
		const { body } = render(Layout, { props: { data: { user: { role } } } });
		const drawer = body.slice(body.indexOf('<aside'));
		assert.match(drawer, /href="\/statistics"[^>]*aria-current="page"/);
		assert.doesNotMatch(drawer, /href="\/admin"|href="\/admin\/statistics"/);
	}
});

test('Studies and Account use standard menu styling and highlight only the current destination', async () => {
	for (const route of ['/studies', '/account', '/statistics']) {
		const Layout = await component('../src/routes/+layout.svelte', route);
		const { body } = render(Layout, { props: { data: { user: { role: 'resident' } } } });
		const drawer = body.slice(body.indexOf('<aside'));
		assert.doesNotMatch(drawer, /class="[^"]*\blink(?:-primary)?\b/);
		for (const href of ['/studies', '/account']) {
			const anchor = drawer.match(new RegExp(`<a[^>]*href="${href}"[^>]*>`))?.[0];
			assert.ok(anchor);
			assert.match(anchor, /class="p-3(?: active)?"/);
			if (route === href) assert.match(anchor, /class="p-3 active"[^>]*aria-current="page"/);
			else assert.doesNotMatch(anchor, /aria-current=|\bactive\b/);
		}
	}
	const source = read('../src/routes/+layout.svelte');
	for (const href of ['/studies', '/account']) {
		assert.ok(source.split('\n').some((line) => line.includes(`resolve('${href}')`) && line.includes('onclick={closeNavigation}')));
	}
});

test('shared header stays above page content and below the navigation drawer', async () => {
	const Layout = await component('../src/routes/+layout.svelte', '/studies');
	for (const user of [null, { role: 'resident', full_name: 'Synthetic user' }, { role: 'admin' }]) {
		const { body } = render(Layout, { props: { data: { user } } });
		assert.match(body, /<header class="sticky top-0 z-30 [^"]*flex-wrap[^"]*border-slate-200 bg-white[^"]*shadow-sm/);
		assert.match(body, /<aside[^>]*class="drawer-side z-40"/);
		assert.match(body, /aria-label="Open navigation"/);
		assert.ok(body.includes(user ? 'Logout' : 'Login'));
	}
});

test('admin panel drawer entry stays active on overview and account settings but not studies', async () => {
	for (const route of ['/admin', '/admin/account', '/admin/statistics', '/studies', null]) {
		const Layout = await component('../src/routes/+layout.svelte', route);
		const { body } = render(Layout, { props: { data: { user: { role: 'admin' } } } });
		const expected = route === '/admin' ? 'page' : ['/admin/account', '/admin/statistics'].includes(route) ? 'location' : null;
		if (expected) assert.match(body, new RegExp(`href="/admin"[^>]*aria-current="${expected}"`));
		else assert.doesNotMatch(body, /href="\/admin"[^>]*aria-current=/);
	}
});

test('admin account reuses existing account behavior with an admin-only page guard', async () => {
	const source = read('../src/routes/admin/account/+page.server.js')
		.replace("from '@sveltejs/kit'", `from ${JSON.stringify(import.meta.resolve('@sveltejs/kit'))}`)
		.replace("from '../../account/+page.server.js'", `from ${JSON.stringify(new URL('../src/routes/account/+page.server.js', import.meta.url).href)}`);
	const { load } = await import(moduleUrl(source));
	let requests = 0;
	const account = { id: 1, full_name: 'Administrator', username: 'admin', role: 'admin' };
	const fetch = async (path) => {
		requests++;
		assert.equal(path, '/api/account');
		return { ok: true, json: async () => account };
	};
	await assert.rejects(async () => load({ locals: {}, fetch }), { status: 302, location: '/login' });
	for (const role of ['resident', 'attending', 'typist']) {
		await assert.rejects(async () => load({ locals: { user: { role } }, fetch }), { status: 403 });
	}
	assert.equal(requests, 0);
	assert.deepEqual(await load({ locals: { user: { role: 'admin' } }, fetch }), { account, signingDelegates: null, reportPreferences: null });
	assert.equal(requests, 1);
	await assert.rejects(async () => load({ locals: { user: { role: 'admin' } }, fetch: async () => ({ ok: false, status: 503 }) }), { status: 503 });
	const wrapper = read('../src/routes/admin/account/+page.svelte');
	assert.match(wrapper, /import AccountSettings from '\.\.\/\.\.\/account\/\+page\.svelte'/);
	assert.match(wrapper, /<AccountSettings \{data\} \/>/);
	for (const generate of ['client', 'server']) assert.deepEqual(compile(wrapper, { filename: '+page.svelte', generate }).warnings, []);
	const Account = await component('../src/routes/account/+page.svelte');
	const { body } = render(Account, { props: { data: { account } } });
	assert.match(body, /Full name/);
	assert.match(body, /Username/);
	assert.match(body, /New password \(optional\)/);
	assert.match(body, /Save changes/);
});

test('users and registration pages compile and keep their primary controls and safety warnings', async () => {
	const Users = await component('../src/routes/admin/users/+page.svelte');
	const users = render(Users, { props: { data: { users: [], user: { role: 'admin' }, websiteUrl: '' } } }).body;
	assert.match(users, /<h1[^>]*>Users<\/h1>/);
	assert.match(users, /<summary[^>]*>Create administrator<\/summary>/);
	assert.match(users, /<summary[^>]*>Telegram onboarding links<\/summary>/);
	assert.match(users, /User accounts \(0\)/);
	assert.match(users, /approved Telegram registration/);
	assert.match(users, /Send group link/);
	assert.match(users, /Send website link/);
	const Registrations = await component('../src/routes/admin/telegram-registrations/+page.svelte');
	const registrations = render(Registrations, { props: { data: { registrations: [], telegramConfigured: false, webhookConfigured: false } } }).body;
	assert.match(registrations, /Verify identity and role before approving/);
	assert.match(registrations, /Telegram bot configuration required/);
	assert.match(registrations, /matching bot webhook secret/);
	assert.match(registrations, /No pending registrations/);
});
