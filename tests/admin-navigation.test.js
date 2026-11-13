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
		assert.match(body, /Report templates/);
		assert.doesNotMatch(body, /Admin overview|Telegram registrations|Storage &amp; Backups|href="\/admin\/users"/);
	}
});

test('root drawer groups administration and preserves role-scoped clinical links', async () => {
	const Layout = await component('../src/routes/+layout.svelte', '/admin/users');
	for (const user of [null, { role: 'typist' }, { role: 'resident' }, { role: 'attending' }, { role: 'admin' }]) {
		const { body } = render(Layout, { props: { data: { user } } });
		assert.equal(body.includes('Admin overview'), user?.role === 'admin');
		assert.equal(body.includes('Report templates'), ['admin', 'resident', 'attending'].includes(user?.role));
		assert.equal(body.includes('/admin/telegram-study-refresh'), user?.role === 'admin');
		if (user?.role === 'admin') {
			assert.match(body, /href="\/admin\/users"[^>]*aria-current="page"/);
			for (const group of adminNavigation(user)) assert.ok(body.includes(group.label));
		}
	}
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
