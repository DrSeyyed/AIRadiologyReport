import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import {
	DEFAULT_STORAGE_SETTINGS,
	saveStorageSettings,
	getStorageConnection
} from '../src/lib/server/storage-settings.js';

const admin = { user: { id: 1, role: 'admin' } };
const routeUrl = new URL('../src/routes/admin/storage/+page.server.js', import.meta.url);
async function fixture(t) {
	const previousKey = process.env.STORAGE_ENCRYPTION_KEY;
	process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
	const db = new Database(':memory:');
	initializeSchema(db, readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
	const settings = {
		...DEFAULT_STORAGE_SETTINGS,
		host: 'storage.invalid',
		username: 'synthetic',
		root: '/radiology',
		fingerprint: `SHA256:${'a'.repeat(43)}`
	};
	saveStorageSettings(db, settings, 'synthetic-storage-secret');
	const key = randomUUID();
	const state = { db, dbCalls: 0, probes: 0, lists: 0, recoveryPoints: [] };
	globalThis[key] = state;
	t.after(() => {
		db.close();
		delete globalThis[key];
		if (previousKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
		else process.env.STORAGE_ENCRYPTION_KEY = previousKey;
	});
	const source = readFileSync(routeUrl, 'utf8').replace(
		/from (['"])([^'"]+)\1/g,
		(statement, quote, specifier) => {
			let target;
			if (specifier === '$lib/server/db')
				target = `data:text/javascript,${encodeURIComponent(`export function getDb(){const state=globalThis[${JSON.stringify(key)}];state.dbCalls++;return state.db;}`)}`;
			else if (specifier === '$lib/server/storage-transport.js')
				target = `data:text/javascript,${encodeURIComponent(`export async function probeStorageHost(config){if ('password' in config) throw new Error('Probe must not receive credentials');globalThis[${JSON.stringify(key)}].probes++;return 'SHA256:'+'b'.repeat(43);}`)}`;
			else if (specifier === '$lib/server/recovery-backups.js')
				target = `data:text/javascript,${encodeURIComponent(`export async function listRecovery(){const state=globalThis[${JSON.stringify(key)}];state.lists++;if(state.listError)throw new Error(state.listError);return state.recoveryPoints;}`)}`;
			else if (specifier.startsWith('$lib/'))
				target = new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href;
			else target = import.meta.resolve(specifier);
			return `from ${JSON.stringify(target)}`;
		}
	);
	const page = await import(
		`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
	);
	function form(values = settings) {
		const output = new FormData();
		for (const [name, value] of Object.entries(values)) {
			if (typeof value === 'boolean') {
				if (value) output.set(name, 'on');
			} else output.set(name, String(value));
		}
		output.set('password', '');
		return output;
	}
	async function submit(action, body = form(), locals = admin) {
		return page.actions[action]({
			locals,
			request: new Request('http://localhost/admin/storage', { method: 'POST', body })
		});
	}
	return { page, db, state, settings, form, submit };
}

test('storage admin load and all actions reject non-admins before DB, form or network access', async (t) => {
	const { page, state } = await fixture(t);
	for (const locals of [
		{},
		{ user: { role: 'resident' } },
		{ user: { role: 'attending' } },
		{ user: { role: 'typist' } }
	]) {
		assert.throws(
			() => page.load({ locals }),
			(error) => error.status === (locals.user ? 403 : 302)
		);
		for (const action of Object.values(page.actions))
			await assert.rejects(
				action({
					locals,
					request: {
						formData() {
							throw new Error('Must not read request');
						}
					}
				}),
				(error) => error.status === (locals.user ? 403 : 302)
			);
	}
	assert.equal(state.dbCalls, 0);
	assert.equal(state.probes, 0);
	assert.equal(state.lists, 0);
});

test('admin save preserves passwords, rejects duplicate/out-of-range form fields and never echoes credentials', async (t) => {
	const { page, submit, form, settings, db } = await fixture(t);
	const input = form({ ...settings, enabled: true, archiveEnabled: true, backupsEnabled: true });
	input.set('password', 'synthetic-new-secret');
	const result = await submit('save', input);
	assert.ok(result.message);
	const loaded = page.load({ locals: admin });
	assert.equal(loaded.passwordConfigured, true);
	assert.equal(loaded.settings.enabled, true);
	assert.equal(loaded.keyConfigured, true);
	assert.ok(!JSON.stringify([result, loaded]).includes('synthetic-new-secret'));
	assert.equal(getStorageConnection(db).password, 'synthetic-new-secret');
	assert.ok((await submit('save')).message);
	assert.equal(getStorageConnection(db).password, 'synthetic-new-secret');
	for (const [name, value] of [
		['port', '0'],
		['hourlyRetention', '0'],
		['databaseIntervalHours', '1.5'],
		['enabled', 'yes']
	]) {
		const invalid = form();
		invalid.set(name, value);
		assert.equal((await submit('save', invalid)).status, 400);
	}
	const duplicate = form();
	duplicate.append('username', 'duplicate');
	assert.equal((await submit('save', duplicate)).status, 400);
});

test('fingerprint discovery does not authenticate, save or implicitly trust an observed key', async (t) => {
	const { page, state, submit, form, db, settings } = await fixture(t);
	const input = form();
	input.set('password', 'must-not-be-used');
	const result = await submit('probe', input);
	assert.equal(result.fingerprint, `SHA256:${'b'.repeat(43)}`);
	assert.equal(state.probes, 1);
	assert.equal(page.load({ locals: admin }).settings.fingerprint, settings.fingerprint);
	assert.equal(getStorageConnection(db).password, 'synthetic-storage-secret');
	assert.ok(!JSON.stringify(result).includes('must-not-be-used'));
});

test('manual actions queue persistent jobs, enforce service toggles and do not expose storage secrets', async (t) => {
	const { submit, db, form, settings } = await fixture(t);
	const job = new FormData();
	job.set('kind', 'full');
	assert.equal((await submit('job', job)).status, 400);
	assert.ok(
		(await submit('save', form({ ...settings, enabled: true, backupsEnabled: true }))).message
	);
	assert.ok((await submit('job', job)).message);
	assert.equal(db.prepare('SELECT kind,status FROM storage_jobs').get().kind, 'full');
	assert.equal(db.prepare('SELECT kind,status FROM storage_jobs').get().status, 'pending');
	job.set('kind', 'unknown');
	assert.equal((await submit('job', job)).status, 400);
});

test('admin can discover remote recovery points while services are paused without exposing internal metadata', async (t) => {
	const { submit, state } = await fixture(t);
	const id = `1800000000-${randomUUID()}`;
	state.recoveryPoints = [{ id, kind: 'full', createdAt: 1800000000, secret: 'must-not-appear' }];
	const result = await submit('recoveryPoints');
	assert.deepEqual(result.recoveryPoints, [{ id, kind: 'full' }]);
	assert.equal(state.lists, 1);
	assert.ok(!JSON.stringify(result).includes('must-not-appear'));
	state.recoveryPoints = [
		{ id, kind: 'full' },
		{ id, kind: 'database' }
	];
	assert.equal((await submit('recoveryPoints')).status, 400);
	state.recoveryPoints = [];
	assert.match((await submit('recoveryPoints')).message, /No completed/);
	state.listError = 'synthetic-private-failure';
	const failed = await submit('recoveryPoints');
	assert.equal(failed.status, 400);
	assert.ok(!JSON.stringify(failed).includes('synthetic-private-failure'));
});

test('admin restore requires explicit confirmation and a single valid recovery ID and only queues preparation', async (t) => {
	const { submit, db } = await fixture(t);
	const id = `1800000000-${randomUUID()}`;
	function body() {
		const form = new FormData();
		form.set('backupId', id);
		form.set('confirmation', 'prepare');
		return form;
	}
	const missing = body();
	missing.delete('confirmation');
	const duplicate = body();
	duplicate.append('backupId', id);
	const invalid = body();
	invalid.set('backupId', '../outside');
	const wrong = body();
	wrong.set('confirmation', 'activate');
	for (const input of [missing, duplicate, invalid, wrong])
		assert.equal((await submit('restore', input)).status, 400);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 0);
	const result = await submit('restore', body());
	assert.match(result.message, /live site will not be replaced/);
	assert.deepEqual(db.prepare('SELECT kind,status FROM storage_jobs').get(), {
		kind: 'restore',
		status: 'pending'
	});
	assert.equal(db.prepare('SELECT backup_id FROM storage_restore_requests').get().backup_id, id);
	assert.ok((await submit('restore', body())).message);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 1);
	const conflicting = body();
	conflicting.set('backupId', `1800000001-${randomUUID()}`);
	assert.equal((await submit('restore', conflicting)).status, 400);
});

test('storage settings page compiles and navigation is admin-only', () => {
	const page = readFileSync(
		new URL('../src/routes/admin/storage/+page.svelte', import.meta.url),
		'utf8'
	);
	const result = compile(page, { filename: '+page.svelte', generate: 'server' });
	assert.equal(result.warnings.filter((warning) => warning.code.startsWith('a11y')).length, 0);
	assert.match(page, /type="password"/);
	assert.match(page, /bind:value=\{settings\.fingerprint\}/);
	assert.ok(!page.includes('bind:value={settings.password}'));
	assert.match(page, /action="\?\/recoveryPoints"/);
	assert.match(page, /action="\?\/restore"/);
	assert.match(page, /name="confirmation" value="prepare" required/);
	assert.match(page, /Manual activation required/);
	const layout = readFileSync(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
	assert.match(layout, /data\.user\?\.role === 'admin'[\s\S]*\/admin\/storage/);
});
