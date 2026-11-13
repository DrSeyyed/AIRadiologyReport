import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';

const admin = { user: { id: 7, role: 'admin' } };
const off = { enabled: false, phase: 'off', telegram: 'disabled' };
const on = { enabled: true, phase: 'enabled', telegram: 'locked' };
const route = new URL('../src/routes/admin/maintenance/+page.server.js', import.meta.url);
const pageUrl = new URL('../src/routes/admin/maintenance/+page.svelte', import.meta.url);
const layoutUrl = new URL('../src/routes/+layout.svelte', import.meta.url);
const moduleUrl = (source) =>
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

async function fixture(t) {
	const key = randomUUID();
	const state = { status: { ...off }, reads: 0, calls: [] };
	globalThis[key] = state;
	t.after(() => delete globalThis[key]);
	const mock = moduleUrl(`
		const state = globalThis[${JSON.stringify(key)}];
		export function siteMaintenanceStatus() {
			state.reads++;
			if (state.readError) throw new Error('private status secret');
			return state.status;
		}
		export async function setSiteMaintenance(options) {
			state.calls.push(options);
			state.status = state.next ?? { enabled: options.enabled, phase: options.enabled ? 'enabled' : 'off', telegram: options.enabled ? 'locked' : 'disabled' };
			if (state.setError) throw new Error('private Telegram token secret');
			return state.status;
		}
	`);
	const source = readFileSync(route, 'utf8').replace(
		/from (['"])([^'"]+)\1/g,
		(_statement, _quote, specifier) => {
			const pending = moduleUrl(`export function pendingRestoreMetadata(){const state=globalThis[${JSON.stringify(key)}];state.pendingReads=(state.pendingReads||0)+1;return state.pendingRestore??{pending:false,fields:[]};}`);
			const discard = moduleUrl(`export function discardPendingIntegrationRestore(options){const state=globalThis[${JSON.stringify(key)}];state.discards=(state.discards||[]).concat([options]);if(state.discardError)throw new Error('private discard secret');state.pendingRestore={pending:false,fields:[]};return {discarded:true,applied:true,fields:['OPENAI_API_KEY']};}`);
			const coordinate = moduleUrl('export async function withIntegrationConfigurationLock(operation){return operation();}');
			const target = specifier === '$lib/server/site-maintenance.js' ? mock :
				specifier === '$lib/server/integration-restore-admin.js' ? pending :
				specifier === '$lib/server/integration-backup.js' ? discard :
				specifier === '$lib/server/integration-coordination.js' ? coordinate : import.meta.resolve(specifier);
			return `from ${JSON.stringify(target)}`;
		}
	);
	const page = await import(moduleUrl(source));
	function form(action) {
		const body = new FormData();
		body.set('confirmation', action === 'enable' ? 'ENABLE MAINTENANCE' : 'DISABLE MAINTENANCE');
		body.set('acknowledgement', 'on');
		return body;
	}
	function submit(action, body = form(action), locals = admin) {
		return page.actions[action]({
			locals,
			request: new Request('http://localhost/admin/maintenance', { method: 'POST', body })
		});
	}
	return { state, page, form, submit };
}

test('maintenance load and every action authorize before reading state or forms', async (t) => {
	const { state, page } = await fixture(t);
	for (const locals of [
		{},
		...['resident', 'attending', 'typist'].map((role) => ({ user: { id: 1, role } }))
	]) {
		const denied = (error) => error.status === (locals.user ? 403 : 302);
		assert.throws(() => page.load({ locals }), denied);
		for (const action of Object.values(page.actions)) {
			await assert.rejects(
				action({
					locals,
					request: {
						formData() {
							throw new Error('Must not read form');
						}
					}
				}),
				denied
			);
		}
	}
	assert.equal(state.reads, 0);
	assert.equal(state.pendingReads, undefined);
	assert.deepEqual(state.calls, []);
});

test('maintenance actions require positive safe integer administrator IDs before form parsing', async (t) => {
	const { page, state } = await fixture(t);
	for (const id of [undefined, null, 0, -1, 1.5, '7', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		for (const action of Object.values(page.actions)) {
			let parsed = false;
			const result = await action({
				locals: { user: { id, role: 'admin' } },
				request: {
					formData() {
						parsed = true;
						throw new Error();
					}
				}
			});
			assert.equal(result.status, 400);
			assert.equal(parsed, false);
		}
	}
	assert.deepEqual(state.calls, []);
});

test('both directions require exact singleton confirmation and acknowledgement, without accepting extra fields', async (t) => {
	const { form, submit, state, page } = await fixture(t);
	for (const action of ['enable', 'disable']) {
		for (const mutate of [
			(body) => body.delete('confirmation'),
			(body) => body.delete('acknowledgement'),
			(body) => body.append('confirmation', body.get('confirmation')),
			(body) => body.append('acknowledgement', 'on'),
			(body) => body.set('confirmation', body.get('confirmation').toLowerCase()),
			(body) => body.set('confirmation', ` ${body.get('confirmation')}`),
			(body) => body.set('confirmation', `${body.get('confirmation')} `),
			(body) =>
				body.set(
					'confirmation',
					action === 'enable' ? 'DISABLE MAINTENANCE' : 'ENABLE MAINTENANCE'
				),
			(body) => body.set('acknowledgement', 'true'),
			(body) => body.set('acknowledgement', ''),
			(body) => body.set('acknowledgement', new Blob(['on']), 'ack.txt'),
			(body) => body.set('confirmation', new Blob(['ENABLE MAINTENANCE']), 'confirm.txt'),
			(body) => body.set('enabled', 'true'),
			(body) => body.set('userId', '1')
		]) {
			const body = form(action);
			mutate(body);
			const result = await submit(action, body);
			assert.equal(result.status, 400);
			assert.deepEqual(result.data.status, off);
		}
		const malformed = await page.actions[action]({
			locals: admin,
			request: {
				formData() {
					throw new Error('private parser secret');
				}
			}
		});
		assert.equal(malformed.status, 400);
		assert.ok(!JSON.stringify(malformed).includes('private parser secret'));
	}
	assert.deepEqual(state.calls, []);
});

test('discarding credential retries requires maintenance and explicit acknowledgement, never reopening or changing settings', async (t) => {
	const { state, page } = await fixture(t);
	state.pendingRestore = { pending: true, fields: ['OPENAI_API_KEY'] };
	const valid = () => new URLSearchParams({ confirmation: 'DISCARD CREDENTIAL RESTORE', acknowledgement: 'on' });
	const submit = body => page.actions.discardIntegrationRestore({ locals: admin, request: new Request('http://localhost/admin/maintenance', { method: 'POST', body }) });
	assert.equal((await submit(valid())).status, 400);
	assert.equal(state.discards, undefined);
	state.status = { ...on };
	for (const mutate of [body => body.set('confirmation', 'discard credential restore'), body => body.delete('acknowledgement'), body => body.append('confirmation', 'DISCARD CREDENTIAL RESTORE'), body => body.set('allowApplied', 'true')]) {
		const body = valid();
		mutate(body);
		assert.equal((await submit(body)).status, 400);
	}
	assert.equal(state.discards, undefined);
	const result = await submit(valid());
	assert.deepEqual(state.discards, [{ allowApplied: true }]);
	assert.equal(result.status.enabled, true);
	assert.equal(result.pendingRestore.pending, false);
	assert.match(result.message, /NOT rolled back/);
	assert.deepEqual(state.calls, []);
	state.discardError = true;
	const failed = await submit(valid());
	assert.equal(failed.status, 400);
	assert.doesNotMatch(JSON.stringify(failed), /private discard secret/);
});

test('maintenance enable, disable and retries pass only validated typed options', async (t) => {
	const { submit, state, page } = await fixture(t);
	assert.deepEqual(page.load({ locals: admin }), { status: off, pendingRestore: { pending: false, fields: [] } });
	for (const action of ['enable', 'enable', 'disable', 'disable']) {
		const result = await submit(action);
		assert.ok(result.message);
		assert.deepEqual(result.status, action === 'enable' ? on : off);
	}
	assert.deepEqual(
		state.calls,
		[true, true, false, false].map((enabled) => ({ enabled, userId: 7 }))
	);
	const result = await submit('enable', undefined, {
		user: { id: Number.MAX_SAFE_INTEGER, role: 'admin' }
	});
	assert.ok(result.message);
	assert.equal(state.calls.at(-1).userId, Number.MAX_SAFE_INTEGER);
});

test('failed lock and unlock return generic errors and current closed status without leaking backend details', async (t) => {
	const { state, submit, page } = await fixture(t);
	for (const action of ['enable', 'disable']) {
		state.setError = true;
		state.next = {
			enabled: true,
			phase: 'error',
			telegram: 'error',
			error: 'private Telegram token secret',
			token: 'never expose'
		};
		const result = await submit(action);
		assert.equal(result.status, 503);
		assert.equal(result.data.status.enabled, true);
		assert.equal(result.data.status.phase, 'error');
		assert.match(result.data.error, /remains closed/);
		assert.doesNotMatch(
			JSON.stringify([result, page.load({ locals: admin })]),
			/private|never expose|token/
		);
	}
	state.setError = false;
	const returnedFailure = await submit('disable');
	assert.equal(returnedFailure.status, 503);
	state.next = { ...off };
	assert.ok((await submit('disable')).message);
});

test('status output is allowlisted and fail-closed when unreadable; incomplete transitions are not reported as success', async (t) => {
	const { state, page, submit } = await fixture(t);
	state.status = { ...on, updatedAt: '2026-11-11T06:30:00Z', secret: 'not for browser' };
	assert.deepEqual(page.load({ locals: admin }).status, {
		...on,
		updatedAt: '2026-11-11T06:30:00.000Z'
	});
	state.status = { enabled: 'false', phase: '<script>', telegram: 'secret', updatedAt: '<img>' };
	const invalid = page.load({ locals: admin }).status;
	assert.equal(invalid.enabled, true);
	assert.equal(invalid.phase, 'error');
	assert.equal(invalid.telegram, 'error');
	assert.equal(invalid.updatedAt, undefined);
	state.readError = true;
	assert.equal(page.load({ locals: admin }).status.enabled, true);
	state.next = { enabled: true, phase: 'disabling', telegram: 'pending' };
	assert.equal((await submit('disable')).status, 503);
	state.next = { enabled: true, phase: 'enabling', telegram: 'pending' };
	assert.equal((await submit('enable')).status, 503);
});

async function component(source, filename) {
	for (const generate of ['client', 'server']) {
		const output = compile(source, { filename, generate });
		assert.deepEqual(
			output.warnings.filter((warning) => warning.code.startsWith('a11y')),
			[]
		);
	}
	const compiled = compile(source, { filename, generate: 'server' }).js.code.replace(
		/from (['"])([^'"]+)\1/g,
		(_statement, _quote, specifier) => {
			const stubs = {
				'$app/forms': 'export function enhance(){}',
				'$app/paths': 'export function resolve(path){return path;}',
				'$app/navigation': 'export function goto(){}; export function invalidateAll(){}',
				'$app/state': 'export const page={route:{id:"/admin/maintenance"}};',
				'$lib/template-permissions.js':
					'export function canManageTemplates(user){return user?.role === "admin";}',
				'$lib/page-title.js': 'export function pageTitle(){return "Maintenance";}'
			};
			const target = specifier === '$lib/admin-navigation.js'
				? new URL('../src/lib/admin-navigation.js', import.meta.url).href
				: specifier in stubs ? moduleUrl(stubs[specifier]) : import.meta.resolve(specifier);
			return `from ${JSON.stringify(target)}`;
		}
	);
	return (await import(moduleUrl(compiled))).default;
}

test('maintenance UI compiles and SSR renders explicit confirmations, acknowledgement, retry and operational warnings safely', async () => {
	const source = readFileSync(pageUrl, 'utf8');
	assert.doesNotMatch(source, /\{@html/);
	assert.match(source, /use:enhance/);
	const Page = await component(source, '+page.svelte');
	const { body } = render(Page, {
		props: {
			data: { status: off },
			form: {
				error: '<script>private input</script>',
				status: { enabled: true, phase: 'error', telegram: 'error' }
			}
		}
	});
	for (const text of [
		'ENABLE MAINTENANCE',
		'DISABLE MAINTENANCE',
		'Retry: ',
		'may remain closed',
		'restrict members',
		'not queued',
		'resend',
		'outside the database',
		'restore',
		'group administrators can still post',
		'storage connection tests',
		'startup temporarily blocks everyone'
	])
		assert.ok(body.includes(text), text);
	assert.ok(body.indexOf('id="maintenance-status-heading"') < body.indexOf('id="maintenance-actions-heading"'));
	assert.ok(body.indexOf('id="maintenance-actions-heading"') < body.indexOf('What maintenance pauses and preserves'));
	const visibleContent = body.replace(/<details\b[\s\S]*?<\/details>/g, '');
	for (const text of ['may remain closed', 'ENABLE MAINTENANCE', 'DISABLE MAINTENANCE', 'name="acknowledgement"'])
		assert.ok(visibleContent.includes(text), text);
	assert.match(body, /Current status/);
	assert.match(body, /<summary[^>]*>What maintenance pauses and preserves<\/summary>/);
	assert.doesNotMatch(body, /<details[^>]*\sopen(?:\s|>)/);
	assert.match(body, /Closed for maintenance/);
	assert.match(body, /&lt;script(?:>|&gt;)private input&lt;\/script(?:>|&gt;)/);
	assert.doesNotMatch(body, /<script>private input/);
	assert.equal((body.match(/name="confirmation"/g) ?? []).length, 2);
	assert.equal((body.match(/name="acknowledgement"/g) ?? []).length, 2);
	assert.match(body, /action="\?\/enable"/);
	assert.match(body, /action="\?\/disable"/);
	const busy = render(Page, { props: { data: { status: { ...on, phase: 'enabling' } } } }).body;
	assert.equal((busy.match(/<fieldset disabled/g) ?? []).length, 2);
	const disabledTelegram = render(Page, { props: { data: { status: off } } }).body;
	assert.match(disabledTelegram, /Telegram maintenance lock/);
	assert.match(disabledTelegram, /Not locked/);
	assert.doesNotMatch(disabledTelegram, /Not configured/);
	const unlocked = render(Page, { props: { data: { status: { ...off, updatedAt: '2026-11-12T04:18:09.528Z' } } } }).body;
	assert.match(unlocked, /Maintenance last changed/);
	assert.match(unlocked, /2026-11-12T04:18:09.528Z/);
	assert.doesNotMatch(unlocked, /Not configured/);
	const locked = render(Page, { props: { data: { status: on } } }).body;
	assert.match(locked, /Telegram maintenance lock/);
	assert.match(locked, />locked</);
});

test('maintenance pending restore keeps discard safety and reopening controls visible', async () => {
	const Page = await component(readFileSync(pageUrl, 'utf8'), '+page.svelte');
	const data = { status: on, pendingRestore: { pending: true, fields: ['OPENAI_API_KEY'] } };
	const body = render(Page, { props: { data } }).body;
	for (const text of ['Credential restore pending', 'Waiting settings: OpenAI API key', 'Restore order and recovery', 'DISCARD CREDENTIAL RESTORE', 'does not undo credentials already applied', 'leaves maintenance enabled'])
		assert.ok(body.includes(text), text);
	assert.match(body, /action="\?\/discardIntegrationRestore"/);
	assert.ok(body.indexOf('id="maintenance-status-heading"') < body.indexOf('Credential restore pending'));
	assert.ok(body.indexOf('id="maintenance-actions-heading"') < body.indexOf('id="maintenance-recovery-heading"'));
	assert.match(body.replace(/<details\b[\s\S]*?<\/details>/g, ''), /DISCARD CREDENTIAL RESTORE/);
	assert.equal((body.match(/name="confirmation"/g) ?? []).length, 3);
	assert.equal((body.match(/name="acknowledgement"/g) ?? []).length, 3);
	assert.doesNotMatch(body, /<details[^>]*\sopen(?:\s|>)/);
	const unreadable = render(Page, { props: { data: { ...data, pendingRestore: { pending: true, error: true } } } }).body;
	assert.match(unreadable, /Pending restore details are unavailable/);
});

test('layout maintenance navigation and enabled banner are admin-only and preserve existing admin entries', async () => {
	const source = readFileSync(layoutUrl, 'utf8')
		.replace("import '../app.css';", '')
		.replace("import favicon from '$lib/assets/favicon.svg';", "const favicon = 'favicon.svg';");
	const Layout = await component(source, '+layout.svelte');
	for (const user of [null, { role: 'resident' }, { role: 'admin' }]) {
		for (const enabled of [false, true]) {
			const { body } = render(Layout, { props: { data: { user, maintenance: { enabled } } } });
			assert.equal(body.includes('>Maintenance</a>'), user?.role === 'admin');
			assert.equal(body.includes('Manage maintenance'), user?.role === 'admin' && enabled);
			if (user?.role === 'admin') {
				assert.match(body, /href="\/admin\/maintenance"/);
				assert.match(body, /Storage &amp; Backups/);
				assert.match(body, /Telegram registrations/);
			}
		}
	}
});
