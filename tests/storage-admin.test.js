import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
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
	const input = form({
		...settings,
		enabled: true,
		archiveEnabled: true,
		backupsEnabled: true,
		uploadTimeoutSeconds: 120,
		verificationTimeoutSeconds: 90
	});
	input.set('password', 'synthetic-new-secret');
	const result = await submit('save', input);
	assert.ok(result.message);
	const loaded = page.load({ locals: admin });
	assert.equal(loaded.passwordConfigured, true);
	assert.equal(loaded.settings.enabled, true);
	assert.equal(loaded.settings.uploadTimeoutSeconds, 120);
	assert.equal(loaded.settings.verificationTimeoutSeconds, 90);
	assert.equal(loaded.keyConfigured, true);
	assert.ok(!JSON.stringify([result, loaded]).includes('synthetic-new-secret'));
	assert.equal(getStorageConnection(db).password, 'synthetic-new-secret');
	assert.ok((await submit('save')).message);
	assert.equal(getStorageConnection(db).password, 'synthetic-new-secret');
	for (const [name, value] of [
		['port', '0'],
		['hourlyRetention', '0'],
		['databaseIntervalHours', '1.5'],
		['enabled', 'yes'],
		['uploadTimeoutSeconds', '0'],
		['uploadTimeoutSeconds', '601'],
		['verificationTimeoutSeconds', '1.5'],
		['verificationTimeoutSeconds', '']
	]) {
		const invalid = form();
		invalid.set(name, value);
		assert.equal((await submit('save', invalid)).status, 400);
	}
	for (const name of ['uploadTimeoutSeconds', 'verificationTimeoutSeconds']) {
		const missing = form();
		missing.delete(name);
		assert.equal((await submit('save', missing)).status, 400);
		const repeated = form();
		repeated.append(name, '30');
		assert.equal((await submit('save', repeated)).status, 400);
	}
	const duplicate = form();
	duplicate.append('username', 'duplicate');
	assert.equal((await submit('save', duplicate)).status, 400);
});

test('admin persists parallel connection limits and rejects malformed, missing and duplicate controls', async (t) => {
	const { submit, form, page, db } = await fixture(t);
	for (const parallelConnections of [1, 16]) {
		const input = form();
		input.set('parallelConnections', String(parallelConnections));
		assert.ok((await submit('save', input)).message);
		assert.equal(page.load({ locals: admin }).settings.parallelConnections, parallelConnections);
		assert.equal(getStorageConnection(db).parallelConnections, parallelConnections);
	}
	for (const value of ['0', '17', '-1', '1.5', '4x', '', 'NaN', 'Infinity']) {
		const input = form();
		input.set('parallelConnections', value);
		assert.equal((await submit('save', input)).status, 400);
	}
	const missing = form();
	missing.delete('parallelConnections');
	assert.equal((await submit('save', missing)).status, 400);
	const repeated = form();
	repeated.append('parallelConnections', '4');
	assert.equal((await submit('save', repeated)).status, 400);
	assert.equal(getStorageConnection(db).parallelConnections, 16);
});

test('admin saves and loads bounded sync intervals and accepts legacy forms without the new field', async (t) => {
	const { submit, form, page, db } = await fixture(t);
	assert.equal(page.load({ locals: admin }).settings.syncIntervalMinutes, 1);
	for (const minutes of [1, 7, 1440]) {
		const input = form();
		input.set('syncIntervalMinutes', String(minutes));
		assert.ok((await submit('save', input)).message);
		assert.equal(page.load({ locals: admin }).settings.syncIntervalMinutes, minutes);
		assert.equal(getStorageConnection(db).syncIntervalMinutes, minutes);
	}
	for (const value of ['0', '1441', '-1', '1.5', '5x', '', 'NaN', 'Infinity']) {
		const invalid = form();
		invalid.set('syncIntervalMinutes', value);
		const result = await submit('save', invalid);
		assert.equal(result.status, 400);
		assert.match(result.data.error, /whole minutes from 1 to 1440/);
	}
	const duplicate = form();
	duplicate.append('syncIntervalMinutes', '5');
	assert.equal((await submit('save', duplicate)).status, 400);
	assert.equal(getStorageConnection(db).syncIntervalMinutes, 1440);
	const legacy = form();
	legacy.delete('syncIntervalMinutes');
	assert.ok((await submit('save', legacy)).message);
	assert.equal(page.load({ locals: admin }).settings.syncIntervalMinutes, 1);
});

test('admin saves comma-separated UTC full hours and audit cadence without deprecated schedule controls', async (t) => {
	const { submit, form, page, db } = await fixture(t);
	const input = form();
	input.delete('databaseIntervalHours');
	input.delete('fileBackupHour');
	input.set('fullBackupHours', ' 23, 0,12 ');
	input.set('integrityAuditDays', '14');
	assert.ok((await submit('save', input)).message);
	assert.deepEqual(page.load({ locals: admin }).settings.fullBackupHours, [0, 12, 23]);
	assert.equal(page.load({ locals: admin }).settings.integrityAuditDays, 14);
	assert.deepEqual(
		JSON.parse(
			db.prepare("SELECT value FROM application_settings WHERE key='storage_settings'").get().value
		).fullBackupHours,
		[0, 12, 23]
	);
	for (const value of [
		'',
		' ',
		'0,',
		',12',
		'0,,12',
		'0 12',
		'0,0',
		'-1',
		'24',
		'1.5',
		'[0,12]',
		'null'
	]) {
		const invalid = form();
		invalid.set('fullBackupHours', value);
		assert.equal((await submit('save', invalid)).status, 400, value);
	}
	for (const name of ['fullBackupHours', 'integrityAuditDays']) {
		const missing = form();
		missing.delete(name);
		assert.equal((await submit('save', missing)).status, 400);
		const duplicate = form();
		duplicate.append(name, duplicate.get(name));
		assert.equal((await submit('save', duplicate)).status, 400);
	}
	for (const value of ['0', '366', '1.5', '']) {
		const invalid = form();
		invalid.set('integrityAuditDays', value);
		assert.equal((await submit('save', invalid)).status, 400);
	}
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
	job.set('kind', 'archive');
	assert.ok((await submit('job', job)).message);
	assert.equal(
		db.prepare("SELECT status FROM storage_jobs WHERE kind='archive'").get().status,
		'pending'
	);
	job.set('kind', 'database');
	assert.equal((await submit('job', job)).status, 400);
	assert.equal(db.prepare("SELECT COUNT(*) n FROM storage_jobs WHERE kind='database'").get().n, 0);
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

test('admin cancel validates one job ID, stops queued tests and preserves completed jobs', async (t) => {
	const { submit, db, page } = await fixture(t);
	db.prepare(
		"INSERT INTO storage_jobs(kind,status,created_at) VALUES('test','pending',1),('full','succeeded',1)"
	).run();
	const form = new FormData();
	for (const invalid of ['0', '-1', '1.5', '9007199254740992', 'one']) {
		form.set('jobId', invalid);
		assert.equal((await submit('cancel', form)).status, 400);
	}
	form.set('jobId', '1');
	form.append('jobId', '2');
	assert.equal((await submit('cancel', form)).status, 400);
	form.set('jobId', '1');
	assert.ok((await submit('cancel', form)).message);
	assert.equal(
		page.load({ locals: admin }).status.jobs.find((job) => job.id === 1).status,
		'cancelled'
	);
	form.set('jobId', '2');
	assert.match((await submit('cancel', form)).message, /already finished/);
	assert.equal(db.prepare('SELECT status FROM storage_jobs WHERE id=2').get().status, 'succeeded');
});

test('admin pause cancels all jobs without requiring a usable encryption key or exposing stored credentials', async (t) => {
	const { submit, db, page } = await fixture(t);
	db.prepare(
		"INSERT INTO storage_jobs(kind,status,created_at) VALUES('test','pending',1),('database','failed',1)"
	).run();
	const form = new FormData();
	assert.equal((await submit('pause', form)).status, 400);
	form.set('confirmation', 'pause');
	const before = db
		.prepare("SELECT value FROM application_settings WHERE key='storage_password'")
		.get().value;
	delete process.env.STORAGE_ENCRYPTION_KEY;
	const result = await submit('pause', form);
	assert.ok(result.message);
	assert.ok(!JSON.stringify(result).includes(before));
	assert.equal(page.load({ locals: admin }).settings.enabled, false);
	assert.ok(page.load({ locals: admin }).status.jobs.every((job) => job.status === 'cancelled'));
	assert.equal(
		db.prepare("SELECT value FROM application_settings WHERE key='storage_password'").get().value,
		before
	);
});

test('clearing finished log requires one exact confirmation without a key or network', async (t) => {
	const { submit, db, state, page } = await fixture(t);
	db.prepare(
		"INSERT INTO storage_jobs(kind,status,attempts,created_at) VALUES('full','succeeded',1,1),('test','failed',8,1),('test','pending',0,1),('database','failed',1,1),('archive','failed',8,1)"
	).run();
	db.prepare('INSERT INTO storage_job_cancellations(job_id,requested_at) VALUES(2,1)').run();
	const before = db.prepare('SELECT * FROM storage_jobs ORDER BY id').all();
	delete process.env.STORAGE_ENCRYPTION_KEY;
	for (const confirmation of [undefined, 'CLEAR', 'clear ', 'clear\n']) {
		const form = new FormData();
		if (confirmation !== undefined) form.set('confirmation', confirmation);
		assert.equal((await submit('clearLog', form)).status, 400);
	}
	const duplicate = new FormData();
	duplicate.append('confirmation', 'clear');
	duplicate.append('confirmation', 'clear');
	assert.equal((await submit('clearLog', duplicate)).status, 400);
	assert.deepEqual(db.prepare('SELECT * FROM storage_jobs ORDER BY id').all(), before);
	const form = new FormData();
	form.set('confirmation', 'clear');
	const result = await submit('clearLog', form);
	assert.match(result.message, /Cleared 3 finished jobs/);
	assert.deepEqual(
		page
			.load({ locals: admin })
			.status.jobs.map((job) => job.id)
			.sort(),
		[3, 4]
	);
	assert.deepEqual(db.prepare('SELECT * FROM storage_jobs ORDER BY id').all(), before);
	assert.equal(state.probes, 0);
	assert.equal(state.lists, 0);
});

const deletionId = '1800000100-22222222-2222-2222-2222-222222222222';
function deleteBackupsForm() {
	const form = new FormData();
	form.set('confirmation', 'DELETE BACKUPS');
	form.set('acknowledge', 'on');
	form.set('backupIds', deletionId);
	return form;
}

test('audit and deletion queue without network access while schedules are paused', async (t) => {
	const { submit, page, db, state } = await fixture(t);
	const audit = new FormData();
	audit.set('confirmation', 'audit');
	assert.match((await submit('audit', audit)).message, /Checksum audit job/);
	assert.match((await submit('deleteBackups', deleteBackupsForm())).message, /Backup deletion job/);
	assert.deepEqual(page.load({ locals: admin }).status.jobs.map((job) => job.kind), ['delete', 'audit']);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_deleted_recovery_points').get().n, 0);
	assert.equal(state.lists, 0);
	assert.equal(state.probes, 0);
});

test('backup deletion requires exact single confirmation, acknowledgment and strict bounded selections', async (t) => {
	const { submit, db } = await fixture(t);
	for (const [field, value] of [
		['confirmation', null], ['confirmation', 'delete backups'], ['confirmation', 'DELETE BACKUPS '],
		['acknowledge', null], ['acknowledge', 'yes'], ['backupIds', null], ['backupIds', '../escape'],
		['backupIds', '1800000100-ABCDEFAB-2222-2222-2222-222222222222']
	]) {
		const form = deleteBackupsForm();
		if (value === null) form.delete(field);
		else form.set(field, value);
		assert.equal((await submit('deleteBackups', form)).status, 400);
	}
	for (const name of ['confirmation', 'acknowledge', 'backupIds']) {
		const form = deleteBackupsForm();
		form.append(name, form.get(name));
		assert.equal((await submit('deleteBackups', form)).status, 400);
	}
	const tooMany = deleteBackupsForm();
	for (let index = 0; index < 100; index++) tooMany.append('backupIds', deletionId);
	assert.equal((await submit('deleteBackups', tooMany)).status, 400);
	const audit = new FormData();
	assert.equal((await submit('audit', audit)).status, 400);
	audit.append('confirmation', 'audit');
	audit.append('confirmation', 'audit');
	assert.equal((await submit('audit', audit)).status, 400);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 0);
});

test('maintenance validates saved connection and encryption key and refuses active resets', async (t) => {
	const { submit, db, settings } = await fixture(t);
	const audit = new FormData();
	audit.set('confirmation', 'audit');
	delete process.env.STORAGE_ENCRYPTION_KEY;
	assert.equal((await submit('audit', audit)).status, 400);
	assert.equal((await submit('deleteBackups', deleteBackupsForm())).status, 400);
	process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
	assert.equal((await submit('audit', audit)).status, 400);
	saveStorageSettings(db, settings, 'new-synthetic-password');
	assert.ok((await submit('reset', resetForm())).message);
	assert.equal((await submit('audit', audit)).status, 400);
	assert.equal((await submit('deleteBackups', deleteBackupsForm())).status, 400);
});

function resetForm() {
	const form = new FormData();
	form.set('confirmation', 'RESET STORAGE');
	form.set('recoverAudio', 'on');
	return form;
}

test('reset requires exact single confirmation and explicit single recovery approval', async (t) => {
	const { submit, db, state } = await fixture(t);
	for (const [field, value] of [
		['confirmation', undefined],
		['confirmation', 'reset storage'],
		['confirmation', 'RESET STORAGE '],
		['confirmation', 'RESET STORAGE\n'],
		['recoverAudio', undefined],
		['recoverAudio', 'yes'],
		['recoverAudio', 'off']
	]) {
		const form = resetForm();
		if (value === undefined) form.delete(field);
		else form.set(field, value);
		assert.equal((await submit('reset', form)).status, 400);
	}
	for (const field of ['confirmation', 'recoverAudio']) {
		const form = resetForm();
		form.append(field, form.get(field));
		assert.equal((await submit('reset', form)).status, 400);
	}
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 0);
	assert.equal(state.dbCalls, 0);
	assert.equal(state.probes, 0);
	assert.equal(state.lists, 0);
});

test('reset validates saved encryption key and connection before queuing', async (t) => {
	const { submit, db, settings } = await fixture(t);
	const key = process.env.STORAGE_ENCRYPTION_KEY;
	delete process.env.STORAGE_ENCRYPTION_KEY;
	assert.equal((await submit('reset', resetForm())).status, 400);
	process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
	assert.equal((await submit('reset', resetForm())).status, 400);
	process.env.STORAGE_ENCRYPTION_KEY = key;
	saveStorageSettings(db, { ...settings, host: '' });
	assert.equal((await submit('reset', resetForm())).status, 400);
	saveStorageSettings(db, settings);
	db.prepare("DELETE FROM application_settings WHERE key='storage_password'").run();
	assert.equal((await submit('reset', resetForm())).status, 400);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 0);
});

test('reset request only queues work, pauses schedules and preserves connection and live data', async (t) => {
	const { submit, db, state, page, settings } = await fixture(t);
	saveStorageSettings(db, { ...settings, enabled: true, backupsEnabled: true });
	db.prepare("INSERT INTO storage_jobs(kind,status,created_at) VALUES('test','pending',1)").run();
	const connection = getStorageConnection(db);
	const result = await submit('reset', resetForm());
	assert.match(result.message, /queued; schedules are paused/);
	assert.match(result.message, /live database is not restored or deleted/);
	assert.ok(!JSON.stringify(result).includes(connection.password));
	const loaded = page.load({ locals: admin });
	assert.equal(loaded.settings.enabled, false);
	assert.equal(loaded.status.resetActive, true);
	assert.equal(loaded.status.jobs.find((job) => job.kind === 'test').status, 'cancelled');
	const reset = loaded.status.jobs.find((job) => job.kind === 'reset');
	assert.equal(reset.status, 'pending');
	assert.equal(reset.canCancel, true);
	assert.ok(reset.progress === null || typeof reset.progress === 'string');
	assert.deepEqual(getStorageConnection(db), { ...connection, enabled: false });
	assert.equal(state.probes, 0);
	assert.equal(state.lists, 0);
	assert.equal((await submit('reset', resetForm())).status, 400);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_reset_requests').get().n, 1);
	const cancel = new FormData();
	cancel.set('jobId', String(reset.id));
	assert.ok((await submit('cancel', cancel)).message);
	assert.equal(page.load({ locals: admin }).status.resetActive, false);
});

test('reset refuses running jobs without pausing or scheduling reset', async (t) => {
	const { submit, db, page, settings } = await fixture(t);
	saveStorageSettings(db, { ...settings, enabled: true });
	db.prepare("INSERT INTO storage_jobs(kind,status,created_at) VALUES('test','running',1)").run();
	assert.equal((await submit('reset', resetForm())).status, 400);
	assert.equal(page.load({ locals: admin }).settings.enabled, true);
	assert.equal(db.prepare("SELECT COUNT(*) n FROM storage_jobs WHERE kind='reset'").get().n, 0);
});

test('pending reset UI disables settings, manual jobs and restore but retains cancellation', async (t) => {
	const { page, submit } = await fixture(t);
	assert.ok((await submit('reset', resetForm())).message);
	const source = readFileSync(
		new URL('../src/routes/admin/storage/+page.svelte', import.meta.url),
		'utf8'
	);
	const compiled = compile(source, {
		filename: '+page.svelte',
		generate: 'server'
	}).js.code.replace(
		/from (['"])([^'"]+)\1/g,
		(_statement, _quote, specifier) =>
			`from ${JSON.stringify(
				specifier === '$app/forms'
					? 'data:text/javascript,export function enhance(){}'
					: specifier === '$app/navigation'
						? 'data:text/javascript,export async function invalidateAll(){};export function replaceState(){}'
						: specifier === '$app/paths'
							? 'data:text/javascript,export function resolve(path){return path;}'
							: import.meta.resolve(specifier)
			)}`
	);
	const component = await import(
		`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
	);
	const data = page.load({ locals: admin });
	data.status.jobs.find((job) => job.kind === 'reset').progress = 'Recovering audio 1 of 2';
	const { body } = render(component.default, {
		props: {
			data,
			form: { recoveryPoints: [{ id: '1800000000-example', kind: 'full' }] }
		}
	});
	assert.match(body, /<fieldset disabled/);
	for (const label of [
		'Test saved connection',
		'Sync files now',
		'Full recovery backup now',
		'Run full checksum audit',
		'Delete selected backups',
		'Load recovery points from storage',
		'Prepare restore',
		'Reset storage',
		'Save settings'
	])
		assert.match(body, new RegExp(`<button[^>]*disabled[^>]*>${label}</button>`));
	assert.match(body, /Type DELETE BACKUPS to confirm/);
	assert.match(body, /name="backupIds"/);
	assert.match(body, /name="acknowledge" required/);
	assert.match(body, /newest or only backups/);
	assert.match(body, /Recovering audio 1 of 2/);
	assert.match(body, /Storage reset is active/);
	assert.match(body, /action="\?\/cancel&(?:amp;)?tab=overview"/);
	assert.match(body, /Clear finished log/);
	data.status.resetActive = false;
	data.status.jobs = [
		{
			id: 999,
			kind: 'archive',
			status: 'running',
			attempts: 1,
			created_at: 1,
			canCancel: true,
			progress: 'Copied: 97; preparing: 0; uploading: 2; verifying: 1'
		}
	];
	const { body: archiveBody } = render(component.default, { props: { data } });
	assert.match(archiveBody, /Copied: 97; preparing: 0; uploading: 2; verifying: 1/);
	assert.match(archiveBody, /Status refreshes every 5 seconds/);
	assert.match(archiveBody, /Backups &amp; restore/);
	assert.match(archiveBody, /Load recovery points above to select backups/);
	assert.match(archiveBody, /<button[^>]*disabled[^>]*>Delete selected backups<\/button>/);
	assert.match(archiveBody, /No restore or backup deletion jobs in the recent log/);
	assert.match(archiveBody, /href="\/admin\/storage\?tab=restore"[^>]*>Delete backups<\/a>/);
	data.status.jobs.push(
		{ id: 1000, kind: 'restore', status: 'running', attempts: 1, created_at: 1,
			canCancel: true, progress: 'Preparing restore: downloading files 2 of 4' },
		{ id: 1001, kind: 'restore', status: 'succeeded', attempts: 1, created_at: 1,
			restoreDirectory: '/recovery/verified-copy' },
		{ id: 1002, kind: 'delete', status: 'failed', attempts: 2, created_at: 1,
			error: 'Selected backup deletion failed.', retry_at: 2, canCancel: true }
	);
	const { body: restoreBody } = render(component.default, {
		props: { data, form: { recoveryPoints: [{ id: '1800000000-example', kind: 'full' }] } }
	});
	const restorePanel = restoreBody.split('id="storage-panel-restore"')[1]
		.split('id="storage-panel-maintenance"')[0];
	assert.match(restorePanel, /action="\?\/deleteBackups&(?:amp;)?tab=restore"/);
	assert.match(restorePanel, /<button(?![^>]*disabled)[^>]*>Delete selected backups<\/button>/);
	assert.match(restorePanel, /Restore &amp; backup deletion job log/);
	assert.match(restorePanel, /Preparing restore: downloading files 2 of 4/);
	assert.match(restorePanel, /Verified copy ready: \/recovery\/verified-copy/);
	assert.match(restorePanel, /Manual activation required/);
	assert.match(restorePanel, /Selected backup deletion failed/);
	assert.match(restorePanel, /Retry:/);
	assert.match(restorePanel, /action="\?\/cancel&(?:amp;)?tab=restore"/);
	assert.doesNotMatch(restorePanel, /Copied: 97/);
	assert.match(archiveBody, /<input[^>]*name="parallelConnections"[^>]*min="1"[^>]*max="16"/);
	assert.match(archiveBody, /Parallel storage connections: 1–16, default 4/);
	assert.match(archiveBody, /<input[^>]*name="syncIntervalMinutes"[^>]*min="1"[^>]*max="1440"[^>]*value="1"/);
	assert.match(archiveBody, /every 1–1440 minutes \(default 1\)/);
	assert.match(archiveBody, /Pending batches continue on the short worker cycle/);
	assert.match(archiveBody, /Full backup UTC hours are independent/);
	const configured = render(component.default, {
		props: { data: { ...data, settings: { ...data.settings, syncIntervalMinutes: 1440 } } }
	});
	assert.match(configured.body, /<input[^>]*name="syncIntervalMinutes"[^>]*value="1440"/);
	for (const name of ['uploadTimeoutSeconds', 'verificationTimeoutSeconds'])
		assert.match(
			archiveBody,
			new RegExp(`<input[^>]*name="${name}"[^>]*min="1"[^>]*max="600"[^>]*step="1"`)
		);
	assert.match(archiveBody, /<td class="whitespace-nowrap">[\s\S]*?action="\?\/cancel&(?:amp;)?tab=overview"/);
	assert.match(
		archiveBody,
		/<button class="[^"]*min-w-max whitespace-nowrap" name="jobId" value="999">Cancel<\/button>/
	);
	const tabs = ['overview', 'settings', 'restore', 'maintenance'];
	for (const requested of [...tabs, 'invalid', '']) {
		const expected = tabs.includes(requested) ? requested : 'overview';
		const tabData = page.load({
			locals: admin,
			url: new URL(`http://localhost/admin/storage?tab=${requested}`)
		});
		assert.equal(tabData.tab, expected);
		const { body: tabBody } = render(component.default, { props: { data: tabData } });
		assert.equal((tabBody.match(/role="tab"/g) || []).length, 4);
		for (const tab of tabs) {
			const panel = tabBody.match(new RegExp(`<div id="storage-panel-${tab}"[^>]*>`))[0];
			assert.equal(/\bhidden\b/.test(panel), tab !== expected);
			const link = tabBody.match(new RegExp(`<a id="storage-tab-${tab}"[^>]*>`))[0];
			assert.match(link, new RegExp(`aria-selected="${tab === expected}"`));
			assert.match(link, new RegExp(`tabindex="${tab === expected ? 0 : -1}"`));
		}
		assert.match(tabBody, /name="password"/);
		assert.match(tabBody, /Type RESET STORAGE to confirm/);
	}
});

test('storage tabs support keyboard navigation and preserve unsaved settings', () => {
	const source = readFileSync(
		new URL('../src/routes/admin/storage/+page.svelte', import.meta.url),
		'utf8'
	);
	const script = source.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^\s*import .+;$/gm, '');
	const location = { href: 'http://localhost/admin/storage?tab=restore&keep=1' };
	let focused;
	let prevented = 0;
	const api = new Function(
		'onMount', 'untrack', '$props', '$state', 'replaceState', 'resolve', 'window', 'document',
		`${script}\nreturn { selectTab, tabClick, tabKeydown, settings, active: () => activeTab, hours: () => fullBackupHours };`
	)(
		() => {},
		(read) => read(),
		() => ({ data: { tab: 'restore', settings: { host: 'saved.invalid', fullBackupHours: [0, 12] } } }),
		(value) => value,
		(url) => { location.href = new URL(url, location.href).href; },
		(path) => path,
		{ location },
		{ getElementById: (id) => ({ focus: () => { focused = id; } }) }
	);
	api.settings.host = 'unsaved.invalid';
	const event = (values) => ({ button: 0, preventDefault: () => { prevented++; }, ...values });
	assert.equal(api.active(), 'restore');
	for (const values of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])
		api.tabClick(event(values), 'settings');
	assert.equal(api.active(), 'restore');
	assert.equal(prevented, 0);
	api.tabClick(event(), 'settings');
	assert.equal(api.active(), 'settings');
	assert.equal(new URL(location.href).searchParams.get('tab'), 'settings');
	assert.equal(new URL(location.href).searchParams.get('keep'), '1');
	for (const [key, index, expected] of [
		['ArrowLeft', 0, 'maintenance'], ['ArrowRight', 3, 'overview'],
		['Home', 2, 'overview'], ['End', 1, 'maintenance']
	]) {
		api.tabKeydown(event({ key }), index);
		assert.equal(api.active(), expected);
		assert.equal(focused, `storage-tab-${expected}`);
	}
	api.tabKeydown(event({ key: 'Tab' }), 0);
	assert.equal(prevented, 5);
	assert.equal(api.settings.host, 'unsaved.invalid');
	assert.equal(api.hours(), '0, 12');
	assert.doesNotMatch(source, /\{#if activeTab/);
});

test('loaded recovery points persist independently of polling and clear only on successful deletion', async () => {
	const source = readFileSync(new URL('../src/routes/admin/storage/+page.svelte', import.meta.url), 'utf8');
	const script = source.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^\s*import .+;$/gm, '');
	const points = [{ id: deletionId, kind: 'full' }];
	const api = new Function('onMount', 'untrack', '$props', '$state',
		`${script}\nreturn { recoveryEnhance, points: () => recoveryPoints };`)(
		() => {}, (read) => read(), () => ({ data: { settings: { fullBackupHours: [0] } }, form: { recoveryPoints: points } }), (value) => value
	);
	assert.deepEqual(api.points(), points);
	const update = async () => {};
	await api.recoveryEnhance()({ result: { type: 'failure', data: { error: 'no' } }, update });
	assert.deepEqual(api.points(), points);
	await api.recoveryEnhance()({ result: { type: 'success', data: { message: 'unrelated status' } }, update });
	assert.deepEqual(api.points(), points);
	await api.recoveryEnhance()({ result: { type: 'success', data: { recoveryPoints: [] } }, update });
	assert.deepEqual(api.points(), []);
});

test('storage status refresh skips hidden pages and overlapping requests, preserves edits and cleans up', async () => {
	const source = readFileSync(
		new URL('../src/routes/admin/storage/+page.svelte', import.meta.url),
		'utf8'
	);
	const script = source.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^\s*import .+;$/gm, '');
	const data = { settings: { host: 'saved.invalid', fullBackupHours: [0, 12] } };
	const document = { visibilityState: 'hidden' };
	let tick,
		cleanup,
		finish,
		calls = 0,
		cleared = false,
		reject = false;
	const settings = new Function(
		'onMount',
		'untrack',
		'$props',
		'$state',
		'invalidateAll',
		'setInterval',
		'clearInterval',
		'document',
		`${script}\nreturn settings;`
	)(
		(mount) => {
			cleanup = mount();
		},
		(read) => read(),
		() => ({ data }),
		(value) => value,
		() => {
			calls++;
			return reject
				? Promise.reject(new Error('Unavailable'))
				: new Promise((resolve) => {
						finish = resolve;
					});
		},
		(callback, interval) => {
			tick = callback;
			assert.equal(interval, 5_000);
			return 123;
		},
		(timer) => {
			assert.equal(timer, 123);
			cleared = true;
		},
		document
	);
	settings.host = 'unsaved.invalid';
	await tick();
	assert.equal(calls, 0);
	document.visibilityState = 'visible';
	const pending = tick();
	await tick();
	assert.equal(calls, 1);
	data.settings.host = 'refreshed.invalid';
	finish();
	await pending;
	assert.equal(settings.host, 'unsaved.invalid');
	reject = true;
	await tick();
	await tick();
	assert.equal(calls, 3);
	cleanup();
	assert.equal(cleared, true);
});

test('storage settings page compiles and navigation is admin-only', () => {
	const page = readFileSync(
		new URL('../src/routes/admin/storage/+page.svelte', import.meta.url),
		'utf8'
	);
	for (const generate of ['server', 'client']) {
		const result = compile(page, { filename: '+page.svelte', generate });
		assert.equal(result.warnings.filter((warning) => warning.code.startsWith('a11y')).length, 0);
	}
	assert.match(page, /type="password"/);
	assert.match(page, /name="fullBackupHours" bind:value=\{fullBackupHours\}/);
	assert.match(page, /fullBackupHours.join\(', '\)/);
	assert.match(page, /integrityAuditDays/);
	assert.match(page, /twice daily at 00:00 and 12:00 UTC/);
	assert.match(page, /Only audio is eligible for local removal/);
	assert.match(page, /individually encrypted objects without gzip compression/);
	assert.match(page, /sha256sum/);
	assert.match(page, /sudo ssh-keygen/);
	assert.match(page, /not downloaded or read back/);
	assert.match(page, /Storage-side hash\/link commands.*verification timeout as a hard deadline/);
	assert.match(page, /hard deadline, not an inactivity limit/);
	assert.doesNotMatch(
		page,
		/value="database"|databaseIntervalHours|fileBackupHour|nextDatabase|new\/reused bundles/
	);
	assert.match(page, /bind:value=\{settings\.fingerprint\}/);
	assert.ok(!page.includes('bind:value={settings.password}'));
	assert.match(page, /action="\?\/save&tab=settings"/);
	assert.match(page, /formaction="\?\/probe&tab=settings"/);
	assert.match(page, /action="\?\/job&tab=overview"/);
	assert.match(page, /action="\?\/recoveryPoints&tab=restore"/);
	assert.match(page, /action="\?\/restore&tab=restore"/);
	assert.ok(page.includes('action={`?/cancel&tab=${tab}`}'));
	assert.match(page, /action="\?\/pause&tab=overview" use:enhance=\{pauseEnhance\}/);
	assert.match(page, /action="\?\/clearLog&tab=maintenance"/);
	assert.match(page, /action="\?\/reset&tab=maintenance" use:enhance=\{pauseEnhance\}/);
	assert.match(page, /name="recoverAudio" required/);
	assert.match(page, /free SSD space for all archived audio/);
	assert.match(page, /Audio is recovered and verified locally before/);
	assert.match(page, /Remote backups are permanently lost/);
	assert.match(page, /\{#if job.progress\}/);
	assert.match(page, /\$state\(untrack\(/);
	assert.match(page, /result.type === 'success'\) settings.enabled = false/);
	assert.match(page, /name="confirmation" value="prepare" required/);
	assert.match(page, /Manual activation required/);
	const layout = readFileSync(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
	assert.match(layout, /data\.user\?\.role === 'admin'[\s\S]*\/admin\/storage/);
});
