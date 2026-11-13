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
	const state = { db, dbCalls: 0, probes: 0, lists: 0, activations: 0, recoveryPoints: [] };
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
			else if (specifier === '$lib/server/storage-worker.js') {
				const worker = JSON.stringify(new URL('../src/lib/server/storage-worker.js', import.meta.url).href);
				target = `data:text/javascript,${encodeURIComponent(`export * from ${worker};import {queueStorageJob as queue} from ${worker};export function queueStorageJob(db,kind,options){const state=globalThis[${JSON.stringify(key)}];if(options?.activate){state.liveQueues=(state.liveQueues||0)+1;state.liveOptions=options;state.liveKind=kind;if(state.queueError)throw new Error(state.queueError);return 42;}return queue(db,kind,options);}export function retryAutomaticRestore(db,jobId){const state=globalThis[${JSON.stringify(key)}];state.retries=(state.retries||0)+1;state.retryJobId=jobId;if(state.retryError)throw new Error(state.retryError);}`)}`;
			}
			else if (specifier === '$lib/server/restore-activation.js')
				target = `data:text/javascript,${encodeURIComponent(`export async function activatePreparedRestore(db,options){const state=globalThis[${JSON.stringify(key)}];state.activations++;state.activationOptions=options;if(state.activationError)throw Object.assign(new Error(state.activationError),{code:state.activationErrorCode});return {id:'synthetic-activation'};}`)}`;
			else if (specifier === '$lib/server/restore-activation-runtime.js')
				target = `data:text/javascript,${encodeURIComponent(`export function restoreActivationStatus(){const state=globalThis[${JSON.stringify(key)}];return {supported:state.activationSupported??true,state:'idle'};}`)}`;
			else if (specifier === '$lib/server/integration-restore-admin.js')
				target = `data:text/javascript,${encodeURIComponent(`export {integrationRestoreSelection,validateIntegrationRestoreSelection,withRestoreIntegrationMetadata} from ${JSON.stringify(new URL('../src/lib/server/integration-restore-admin.js', import.meta.url).href)};export function pendingRestoreMetadata(){const state=globalThis[${JSON.stringify(key)}];state.pendingReads=(state.pendingReads||0)+1;return state.pendingRestore??{pending:false,fields:[]};}`)}`;
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
	assert.equal(state.pendingReads, undefined);
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
	const invalidModes = ['', 'REMOTE', 'local', '../outside'].map((mode) => {
		const form = body();
		form.set('audioMode', mode);
		return form;
	});
	const duplicateMode = body();
	duplicateMode.append('audioMode', 'remote');
	duplicateMode.append('audioMode', 'remote');
	for (const input of [missing, duplicate, invalid, wrong, ...invalidModes, duplicateMode])
		assert.equal((await submit('restore', input)).status, 400);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 0);
	const result = await submit('restore', body());
	assert.match(result.message, /live site will not be replaced/);
	assert.deepEqual(db.prepare('SELECT kind,status FROM storage_jobs').get(), {
		kind: 'restore',
		status: 'pending'
	});
	assert.deepEqual(db.prepare('SELECT backup_id,audio_mode FROM storage_restore_requests').get(), {
		backup_id: id, audio_mode: 'download'
	});
	assert.ok((await submit('restore', body())).message);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 1);
	const conflicting = body();
	conflicting.set('backupId', `1800000001-${randomUUID()}`);
	assert.equal((await submit('restore', conflicting)).status, 400);
});

test('admin restore saves explicit remote and download modes without reusing a conflicting request', async (t) => {
	const { submit, db, page } = await fixture(t);
	const backupId = `1800000000-${randomUUID()}`;
	const form = new FormData();
	form.set('backupId', backupId);
	form.set('confirmation', 'prepare');
	form.set('audioMode', 'remote');
	assert.ok((await submit('restore', form)).message);
	assert.equal(db.prepare('SELECT audio_mode FROM storage_restore_requests').get().audio_mode, 'remote');
	assert.equal(page.load({ locals: admin }).status.jobs[0].audioMode, 'remote');
	assert.ok((await submit('restore', form)).message);
	form.set('audioMode', 'download');
	assert.equal((await submit('restore', form)).status, 400);
	assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_jobs').get().n, 1);
	db.exec("UPDATE storage_jobs SET status='failed',attempts=8");
	assert.ok((await submit('restore', form)).message);
	assert.deepEqual(db.prepare('SELECT audio_mode FROM storage_restore_requests ORDER BY job_id').all(), [
		{ audio_mode: 'remote' }, { audio_mode: 'download' }
	]);
	assert.equal(page.load({ locals: admin }).status.jobs[0].audioMode, 'download');
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
	assert.match(result.message, /pending approved restore jobs remain visible/);
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
	for (const heading of ['storage-status-heading', 'storage-jobs-heading', 'storage-connection-heading', 'storage-timeouts-heading', 'storage-schedule-heading', 'storage-log-heading', 'storage-reset-heading', 'storage-delete-heading']) {
		assert.match(body, new RegExp(`<section[^>]*aria-labelledby="${heading}"`));
		assert.match(body, new RegExp(`id="${heading}"`));
	}
	assert.ok(body.indexOf('id="storage-status-heading"') < body.indexOf('id="storage-jobs-heading"'));
	const visibleContent = body.replace(/<details\b[\s\S]*?<\/details>/g, '');
	for (const risk of ['Restore replaces the live database', 'Remote backups are permanently lost', 'newest or only backups', 'Type RESET STORAGE', 'I approve live replacement'])
		assert.ok(visibleContent.includes(risk), risk);
	assert.match(visibleContent, /Background storage jobs: <strong>Paused<\/strong>/);
	assert.match(body, /<fieldset disabled/);
	for (const label of [
		'Test saved connection',
		'Sync files now',
		'Full recovery backup now',
		'Run full checksum audit',
		'Delete selected backups',
		'Load recovery points from storage',
		'Restore live site',
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
		{ id: 1001, kind: 'restore', status: 'blocked', attempts: 1, created_at: 1,
			restoreDirectory: '/recovery/verified-copy', audioMode: 'remote', remoteAudioFiles: 12,
			activationState: 'blocked', activationError: 'Activation needs attention.', canCancel: true },
		{ id: 1002, kind: 'delete', status: 'failed', attempts: 2, created_at: 1,
			error: 'Selected backup deletion failed.', retry_at: 2, canCancel: true }
	);
	data.status.preparedRestores = [
		{ id: 1001, finished_at: 1, directory: '/recovery/verified-copy', audioMode: 'remote', remoteAudioFiles: 12 },
		{ id: 998, finished_at: 1, directory: '/recovery/download-copy', audioMode: 'download', remoteAudioFiles: 0 }
	];
	const { body: restoreBody } = render(component.default, {
		props: { data, form: { recoveryPoints: [{ id: '1800000000-example', kind: 'full' }] } }
	});
	data.status.preparedRestores = [];
	const integrationKeys = ['OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'GEMINI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_WEBHOOK_BASE_URL'];
	const { body: credentialsBody } = render(component.default, { props: { data, form: { recoveryPoints: [{ id: '1800000000-example', kind: 'full' }] } } });
	const credentialInputs = credentialsBody.match(/<input\b[^>]*name="integrationField"[^>]*>/g) || [];
	assert.equal(credentialInputs.length, 7);
	for (const input of credentialInputs) assert.doesNotMatch(input, /\bchecked\b|STORAGE_ENCRYPTION_KEY/);
	for (const key of integrationKeys)
		assert.ok(credentialInputs.some(input => input.includes(`value="${key}"`)));
	assert.match(credentialsBody, /availability in this backup is not yet known/);
	assert.match(credentialsBody, /Missing selected snapshots block activation safely/);
	assert.match(credentialsBody, /empty backed-up value explicitly clears/);
	assert.match(credentialsBody, /original storage encryption key is never restored/);
	data.activation.supported = false;
	const { body: unsupportedBody } = render(component.default, {
		props: { data, form: { recoveryPoints: [{ id: '1800000000-example', kind: 'full' }] } }
	});
	assert.match(unsupportedBody, /<button[^>]*disabled[^>]*>Restore live site<\/button>/);
	assert.match(unsupportedBody, /Use the README offline recovery procedure/);
	data.activation.supported = true;
	const restorePanel = restoreBody.split('id="storage-panel-restore"')[1]
		.split('id="storage-panel-maintenance"')[0];
	assert.match(restorePanel, /action="\?\/deleteBackups&(?:amp;)?tab=restore"/);
	assert.match(restorePanel, /<button(?![^>]*disabled)[^>]*>Delete selected backups<\/button>/);
	assert.match(restorePanel, /Restore &amp; backup deletion job log/);
	assert.match(restorePanel, /Preparing restore: downloading files 2 of 4/);
	assert.match(restorePanel, /Verified copy ready: \/recovery\/verified-copy/);
	assert.match(restorePanel, /Restore live site/);
	assert.doesNotMatch(restorePanel, /Activate this restore|Recent verified copies|Configured in backup/);
	assert.match(restorePanel, /name="confirmation"/);
	assert.match(restorePanel, /name="acknowledgement"[^>]*required/);
	assert.match(restorePanel, /action="\?\/restoreLive&(?:amp;)?tab=restore"/);
	assert.match(restorePanel, /<select[^>]*name="audioMode"[^>]*required[^>]*>/);
	assert.match(restorePanel, /<option value="remote" selected(?:="")?>Keep archived audio on storage \(less local disk\)<\/option>/);
	assert.match(restorePanel, /<option value="download">Download all audio \(independent copy\)<\/option>/);
	assert.match(restorePanel, /playback after activation needs the saved matching storage destination, original archive paths and original encryption key/);
	assert.match(restorePanel, /Downloading all audio needs full disk space and is the offline restore default/);
	assert.match(restorePanel, /match authenticated snapshot archive metadata/);
	assert.match(restorePanel, /Missing or mismatching archives fail preparation/);
	assert.match(restorePanel, /Legacy mixed bundles may still transfer archived audio bytes/);
	assert.match(restorePanel, /Storage services start paused in either mode/);
	assert.match(restorePanel, /audio files kept remote: 12/);
	assert.match(restorePanel, /not self-contained; matching storage and original key required/);
	assert.match(restorePanel, /Download all audio/);
	assert.match(restorePanel, /activation: blocked/);
	assert.match(restorePanel, /Activation needs attention/);
	assert.match(restorePanel, /Retry restore/);
	assert.match(restorePanel, /action="\?\/retryRestore&(?:amp;)?tab=restore"/);
	assert.match(restorePanel, /Selected backup deletion failed/);
	assert.match(restorePanel, /Retry:/);
	assert.match(restorePanel, /action="\?\/cancel&(?:amp;)?tab=restore"/);
	assert.doesNotMatch(restorePanel, /Copied: 97/);
	assert.match(restoreBody, /pending approved restores remain visible/);
	const originalJobs = data.status.jobs;
	for (const [activationState, status, canCancel] of [
		['pending', 'waiting', true], ['activating', 'activating', false],
		['queued', 'activating', false], ['blocked', 'blocked', true],
		['completed', 'succeeded', false], ['cancelled', 'cancelled', false]
	]) {
		data.status.jobs = [{
			id: 2000, kind: 'restore', status, activationState, canCancel,
			attempts: 8, created_at: 1, audioMode: 'remote',
			restoreDirectory: '/recovery/verified-copy',
			activationError: activationState === 'blocked' ? 'Restore rolled back. Resolve activation error and retry.' : null
		}];
		const { body: stateBody } = render(component.default, { props: { data } });
		const panel = stateBody.split('id="storage-panel-restore"')[1]
			.split('id="storage-panel-maintenance"')[0];
		assert.match(panel, new RegExp(`${status}.*activation: ${activationState}`));
		assert.equal(panel.includes('>Retry restore</button>'), activationState === 'blocked');
		assert.equal(panel.includes('>Cancel</button>'), canCancel);
		assert.doesNotMatch(panel, /\(8\/8\)|Retry:/);
		if (activationState === 'blocked') assert.match(panel, /Restore rolled back/);
		if (activationState === 'completed') {
			assert.match(panel, /Restore completed\./);
			assert.doesNotMatch(panel, /Maintenance remains on for review; storage schedules stay paused\./);
			assert.doesNotMatch(panel, /Verified copy ready|verified-copy/);
		}
	}
	data.status.jobs = originalJobs;
	const originalActivation = data.activation;
	for (const cleanupPending of [false, true, undefined]) {
		data.activation = { supported: true, state: 'completed', cleanupPending, rollbackDirectory: 'private-rollback-sentinel' };
		const { body: completedBody } = render(component.default, { props: { data } });
		assert.doesNotMatch(completedBody, /Last restore activation|Private rollback copy|Keep it until|private-rollback-sentinel/);
		assert.doesNotMatch(completedBody, /Maintenance remains on for review; storage schedules stay paused\./);
		assert.doesNotMatch(completedBody, /Temporary restore files removed\./);
		assert.equal(completedBody.includes('Temporary-file cleanup will retry on the next restart.'), cleanupPending === true);
	}
	data.activation = { supported: true, state: 'activating', cleanupPending: false };
	const { body: activatingBody } = render(component.default, { props: { data } });
	assert.doesNotMatch(activatingBody, /Temporary restore files removed\./);
	assert.match(activatingBody, /Last restore activation: activating/);
	data.activation = { supported: true, state: 'rolled_back', error: 'Restore needs attention' };
	const { body: rolledBackBody } = render(component.default, { props: { data } });
	assert.match(rolledBackBody, /Last restore activation: rolled_back/);
	assert.match(rolledBackBody, /Restore needs attention/);
	data.activation = originalActivation;
	assert.match(archiveBody, /<input[^>]*name="parallelConnections"[^>]*min="1"[^>]*max="16"/);
	assert.match(archiveBody, /Parallel storage connections: 1–16, default 4/);
	assert.match(archiveBody, /Connection tests probe every configured session/);
	assert.match(archiveBody, /Database checks, publication and ordering-dependent cleanup stay serial/);
	assert.match(archiveBody, /Independent downloads, decryption and verification use the saved parallel connection limit/);
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
		`const $derived = Object.assign(value => value, {by: read => read()});\n${script}\nreturn { selectTab, tabClick, tabKeydown, settings, active: () => activeTab, hours: () => fullBackupHours };`
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

test('settings submissions retain fields, clear only saved passwords and handle temporary errors inline', async () => {
	const source = readFileSync(new URL('../src/routes/admin/storage/+page.svelte', import.meta.url), 'utf8');
	const script = source.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^\s*import .+;$/gm, '');
	assert.match(source, /action="\?\/save&tab=settings" use:enhance=\{settingsEnhance\}/);
	assert.match(source, /role="alert">\{settingsRequestError\}/);
	for (const [action, result, inline, clearPassword] of [
		['save', { type: 'success' }, false, true],
		['probe', { type: 'success' }, false, false],
		['save', { type: 'failure', status: 400 }, false, false],
		['save', { type: 'error', status: 503 }, true, false],
		['probe', { type: 'error', status: 503 }, true, false],
		['save', { type: 'error', status: 500 }, true, false],
		['save', { type: 'error', error: new SyntaxError('Unexpected HTML') }, true, false],
		['save', { type: 'error', error: new TypeError('Failed to fetch') }, true, false],
		['save', { type: 'error', status: 403 }, false, false],
		['save', { type: 'redirect', location: '/login' }, false, false]
	]) {
		const api = new Function('onMount', 'untrack', '$props', '$state',
			`const $derived = Object.assign(value => value, {by: read => read()});\n${script}\nreturn { settingsEnhance, settings, hours: () => fullBackupHours, error: () => settingsRequestError };`)(
			() => {}, (read) => read(), () => ({ data: { settings: { host: 'saved.invalid', enabled: false, fullBackupHours: [0, 12] } } }), (value) => value
		);
		api.settings.host = 'edited.invalid';
		api.settings.enabled = true;
		const password = { value: 'synthetic-secret' };
		const input = {
			action: new URL(`http://localhost/admin/storage?/${action}&tab=settings`),
			formElement: { elements: { namedItem: (name) => { assert.equal(name, 'password'); return password; } } }
		};
		const updates = [];
		await api.settingsEnhance(input)({ result, update: async (options) => {
			updates.push(options);
			if (options?.reset !== false) {
				api.settings.host = '';
				api.settings.enabled = false;
			}
		} });
		assert.equal(api.settings.host, 'edited.invalid');
		assert.equal(api.settings.enabled, true);
		assert.equal(api.hours(), '0, 12');
		assert.equal(password.value, clearPassword ? '' : 'synthetic-secret');
		assert.deepEqual(updates, inline ? [] : [{ reset: false }]);
		if (inline) {
			assert.match(api.error(), /not confirmed.*Refresh to check saved settings before retrying/);
			api.settingsEnhance(input);
		}
		assert.equal(api.error(), '');
	}
});

test('loaded recovery points persist independently of polling and clear only on successful deletion', async () => {
	const source = readFileSync(new URL('../src/routes/admin/storage/+page.svelte', import.meta.url), 'utf8');
	const script = source.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^\s*import .+;$/gm, '');
	const points = [{ id: deletionId, kind: 'full' }];
	const api = new Function('onMount', 'untrack', '$props', '$state',
		`const $derived = Object.assign(value => value, {by: read => read()});\n${script}\nreturn { recoveryEnhance, points: () => recoveryPoints };`)(
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
		`const $derived = Object.assign(value => value, {by: read => read()});\n${script}\nreturn settings;`
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

test('storage settings page compiles and navigation is admin-only', async () => {
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
	assert.match(page, /action="\?\/restoreLive&tab=restore"/);
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
	assert.match(page, /name="confirmation"[^>]*pattern="RESTORE" required/);
	assert.match(page, /Restore live site/);
	const { adminNavigation } = await import('../src/lib/admin-navigation.js');
	for (const user of [null, { role: 'resident' }, { role: 'attending' }, { role: 'typist' }, { role: 'admin' }]) {
		const links = adminNavigation(user).flatMap((group) => group.links);
		assert.equal(links.some((link) => link.href === '/admin/storage'), user?.role === 'admin');
	}
});

test('one-form restore validates approval and queues immutable automatic intent without activating', async (t) => {
	const { submit, state, settings } = await fixture(t);
	const valid = {
		backupId: `1800000000-${randomUUID()}`, audioMode: 'remote',
		confirmation: 'RESTORE', acknowledgement: 'on'
	};
	function body(values = valid) {
		const form = new FormData();
		for (const [key, value] of Object.entries(values)) form.set(key, value);
		return form;
	}
	for (const values of [
		{ ...valid, confirmation: 'restore' }, { ...valid, confirmation: 'RESTORE ' },
		{ ...valid, acknowledgement: 'yes' }, { ...valid, backupId: '../backup' },
		{ ...valid, audioMode: 'invalid' }, { ...valid, unexpected: 'value' }
	]) assert.equal((await submit('restoreLive', body(values))).status, 400);
	for (const key of Object.keys(valid)) {
		const missing = body(); missing.delete(key);
		assert.equal((await submit('restoreLive', missing)).status, 400);
		const duplicate = body(); duplicate.append(key, valid[key]);
		assert.equal((await submit('restoreLive', duplicate)).status, 400);
	}
	for (const selected of [
		['OPENAI_API_KEY'], ['unknown'], ['STORAGE_ENCRYPTION_KEY'], ['OPENAI_API_KEY', 'OPENAI_API_KEY']
	]) {
		const form = body();
		for (const key of selected) form.append('integrationField', key);
		if (selected.length !== 1 || selected[0] !== 'OPENAI_API_KEY') form.set('integrationConfirmation', 'RESTORE CREDENTIALS');
		assert.equal((await submit('restoreLive', form)).status, 400);
	}
	for (const confirmation of ['restore credentials', 'RESTORE CREDENTIALS ']) {
		const form = body(); form.set('integrationField', 'OPENAI_API_KEY'); form.set('integrationConfirmation', confirmation);
		assert.equal((await submit('restoreLive', form)).status, 400);
	}
	const duplicateConfirmation = body();
	duplicateConfirmation.append('integrationConfirmation', 'RESTORE CREDENTIALS');
	duplicateConfirmation.append('integrationConfirmation', 'RESTORE CREDENTIALS');
	assert.equal((await submit('restoreLive', duplicateConfirmation)).status, 400);
	state.activationSupported = false;
	assert.equal((await submit('restoreLive', body())).status, 400);
	assert.equal(state.liveQueues || 0, 0);
	state.activationSupported = true;
	const result = await submit('restoreLive', body());
	assert.equal(result.message, 'Restore queued. Backup will be verified, live site replaced and restarted automatically. Maintenance remains on for review.');
	assert.equal(state.liveKind, 'restore');
	assert.deepEqual(state.liveOptions, {
		backupId: valid.backupId, audioMode: 'remote', retryNow: true,
		activate: true, requestedBy: 1, integrationFields: []
	});
	const selected = body({ ...valid, audioMode: 'download' });
	selected.set('integrationConfirmation', 'RESTORE CREDENTIALS');
	for (const key of ['OPENAI_API_KEY', 'TELEGRAM_CHAT_ID']) selected.append('integrationField', key);
	assert.ok((await submit('restoreLive', selected)).message);
	assert.equal(state.liveOptions.audioMode, 'download');
	assert.deepEqual(state.liveOptions.integrationFields, ['OPENAI_API_KEY', 'TELEGRAM_CHAT_ID']);
	assert.equal(state.activations, 0);
	assert.equal(state.lists, 0);
	state.queueError = 'synthetic-private-error';
	const failed = await submit('restoreLive', body());
	assert.equal(failed.status, 400);
	assert.doesNotMatch(JSON.stringify(failed), /synthetic-private-error/);
	state.queueError = null;
	saveStorageSettings(state.db, { ...settings, host: '' });
	assert.equal((await submit('restoreLive', body())).status, 400);
});

test('restore retry accepts only a strict job ID and retains approved choices', async (t) => {
	const { submit, state } = await fixture(t);
	for (const id of ['0', '-1', '1.2', '../42', '9007199254740992', '42 ']) {
		const form = new FormData(); form.set('jobId', id);
		assert.equal((await submit('retryRestore', form)).status, 400);
	}
	const form = new FormData(); form.set('jobId', '42');
	form.append('jobId', '42');
	assert.equal((await submit('retryRestore', form)).status, 400);
	form.set('jobId', '42'); form.set('integrationField', 'OPENAI_API_KEY');
	assert.equal((await submit('retryRestore', form)).status, 400);
	form.delete('integrationField');
	state.activationSupported = false;
	assert.equal((await submit('retryRestore', form)).status, 400);
	assert.equal(state.retries || 0, 0);
	state.activationSupported = true;
	assert.match((await submit('retryRestore', form)).message, /original approved choices/);
	assert.equal(state.retryJobId, 42);
	state.retryError = 'synthetic-private-error';
	const failed = await submit('retryRestore', form);
	assert.equal(failed.status, 400);
	assert.doesNotMatch(JSON.stringify(failed), /synthetic-private-error/);
});

test('admin activation requires exact confirmation and acknowledgement before queueing', async (t) => {
	const { submit, state } = await fixture(t);
	const valid = { jobId: '42', confirmation: 'ACTIVATE RESTORE', acknowledgement: 'on' };
	for (const values of [
		{ ...valid, confirmation: 'activate restore' },
		{ ...valid, acknowledgement: 'no' },
		{ ...valid, jobId: '../42' },
		{ ...valid, jobId: '0' }
	]) {
		const body = new FormData();
		for (const [key, value] of Object.entries(values)) body.set(key, value);
		assert.equal((await submit('activateRestore', body)).status, 400);
	}
	const duplicate = new FormData();
	for (const [key, value] of Object.entries(valid)) duplicate.set(key, value);
	duplicate.append('confirmation', 'ACTIVATE RESTORE');
	assert.equal((await submit('activateRestore', duplicate)).status, 400);
	assert.equal(state.activations, 0);
	const body = new FormData();
	for (const [key, value] of Object.entries(valid)) body.set(key, value);
	const result = await submit('activateRestore', body);
	assert.equal(result.activationQueued, true);
	assert.deepEqual(state.activationOptions, { jobId: 42, userId: 1, integrationFields: [] });
	assert.match(result.message, /restart/);
	body.append('integrationField', 'OPENAI_API_KEY');
	assert.equal((await submit('activateRestore', body)).status, 400);
	body.set('integrationConfirmation', 'restore credentials');
	assert.equal((await submit('activateRestore', body)).status, 400);
	body.set('integrationConfirmation', 'RESTORE CREDENTIALS');
	body.append('integrationField', 'OPENAI_API_KEY');
	assert.equal((await submit('activateRestore', body)).status, 400);
	body.set('integrationField', 'STORAGE_ENCRYPTION_KEY');
	assert.equal((await submit('activateRestore', body)).status, 400);
	body.set('integrationField', 'unknown');
	assert.equal((await submit('activateRestore', body)).status, 400);
	assert.equal(state.activations, 1);
	body.set('integrationField', 'OPENAI_API_KEY');
	body.append('integrationField', 'TELEGRAM_CHAT_ID');
	assert.equal((await submit('activateRestore', body)).activationQueued, true);
	assert.deepEqual(state.activationOptions.integrationFields, ['OPENAI_API_KEY', 'TELEGRAM_CHAT_ID']);
	state.activationError = 'synthetic-private-error';
	const failed = await submit('activateRestore', body);
	assert.equal(failed.status, 400);
	assert.ok(!JSON.stringify(failed).includes(state.activationError));
	for (const [code, message] of [
		['RESTORE_PREPARED_DATABASE_HAS_JOURNALS', /Prepare a fresh verified copy/],
		['INTEGRATION_RESTORE_PRIVATE_PLAN_REQUIRED', /Uncheck all integration settings/],
		['TELEGRAM_MAINTENANCE_INVALID_PERMISSIONS', /Telegram returned unsupported or invalid group permissions/]
	]) {
		state.activationErrorCode = code;
		const specific = await submit('activateRestore', body);
		assert.equal(specific.status, 400);
		assert.match(specific.data.error, message);
		assert.doesNotMatch(JSON.stringify(specific), /synthetic-private-error/);
	}
});
