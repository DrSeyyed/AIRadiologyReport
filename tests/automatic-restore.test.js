import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { queueActivationFiles, applyPendingActivation, finalizeActivation } from '../src/lib/server/restore-activation-files.js';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { automaticRestoreApproval, processAutomaticRestore, retryAutomaticRestore } from '../src/lib/server/automatic-restore.js';
import { queueStorageJob, cancelStorageJob, pauseAndCancelStorageJobs, clearStorageJobLog, storageStatus, runStorageWorkerTick, processStorageJob } from '../src/lib/server/storage-worker.js';
import { createActivationRuntime } from '../src/lib/server/restore-activation-runtime.js';
import { activatePreparedRestore } from '../src/lib/server/restore-activation.js';
import { DEFAULT_STORAGE_SETTINGS, saveStorageSettings } from '../src/lib/server/storage-settings.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const available = () => ({ supported: true, state: 'idle' });
function fixture(t, filename = ':memory:') {
	const db = new Database(filename);
	initializeSchema(db, schema);
	t.after(() => { if (db.open) db.close(); });
	const backupId = `1800000000-${randomUUID()}`;
	const options = { backupId, audioMode: 'remote', activate: true, requestedBy: 7, integrationFields: [] };
	const jobId = queueStorageJob(db, 'restore', options);
	const restoreId = randomUUID();
	const ready = () => db.prepare("UPDATE storage_jobs SET status='succeeded',result=? WHERE id=?")
		.run(JSON.stringify({ id: backupId, restoreId, audioMode: 'remote', remoteAudioFiles: 0 }), jobId);
	const approval = () => db.prepare('SELECT * FROM storage_restore_activations WHERE job_id=?').get(jobId);
	return { db, jobId, backupId, restoreId, options, ready, approval };
}

test('live restore approvals survive schema initialization, bind immutable consent and never upgrade preparation jobs', (t) => {
	const f = fixture(t);
	initializeSchema(f.db, schema);
	assert.equal(f.approval().requested_by, 7);
	assert.equal(f.approval().integration_fields, '[]');
	assert.equal(queueStorageJob(f.db, 'restore', f.options), f.jobId);
	for (const changes of [{ requestedBy: 8 }, { integrationFields: ['OPENAI_API_KEY'] }, { activate: false, requestedBy: null }])
		assert.throws(() => queueStorageJob(f.db, 'restore', { ...f.options, ...changes }), /approval|credentials/);
	assert.throws(() => automaticRestoreApproval({ activate: true, requestedBy: 0 }));
	assert.throws(() => automaticRestoreApproval({ activate: true, requestedBy: 7, integrationFields: ['STORAGE_ENCRYPTION_KEY'] }));
	assert.throws(() => automaticRestoreApproval({ activate: true, requestedBy: 7, integrationFields: ['OPENAI_API_KEY', 'OPENAI_API_KEY'] }));
	cancelStorageJob(f.db, f.jobId);
	const prepareId = queueStorageJob(f.db, 'restore', { backupId: f.backupId });
	assert.ok(prepareId > f.jobId);
	assert.throws(() => queueStorageJob(f.db, 'restore', { ...f.options, audioMode: 'download' }), /approval/);
});

test('only verified approved restores activate, with zero unrelated requests allowed and selected credentials retained', async (t) => {
	const f = fixture(t);
	let calls = 0;
	const activate = async (db, options, runtimeOptions) => {
		calls++;
		assert.equal(db, f.db);
		assert.deepEqual(options, { jobId: f.jobId, userId: 7, integrationFields: ['OPENAI_API_KEY'] });
		assert.deepEqual(runtimeOptions, { requestAllowance: 0 });
		assert.equal(f.approval().state, 'activating');
	};
	f.db.prepare('UPDATE storage_restore_activations SET integration_fields=?').run('["OPENAI_API_KEY"]');
	assert.equal(await processAutomaticRestore(f.db, { status: available, activate }), false);
	assert.equal(calls, 0);
	f.ready();
	assert.equal(await processAutomaticRestore(f.db, { status: () => ({ supported: false }), activate }), false);
	assert.equal(await processAutomaticRestore(f.db, { status: available, activate }), true);
	assert.equal(f.approval().state, 'queued');
	assert.equal(await processAutomaticRestore(f.db, { status: () => ({ ...available(), restoreId: f.restoreId, state: 'completed' }), activate }), false);
	assert.equal(f.approval().state, 'completed');
	assert.equal(calls, 1);
});

test('transient work drains automatically, permanent errors pause safely and explicit retry preserves consent', async (t) => {
	const f = fixture(t);
	f.ready();
	for (const code of ['RESTORE_ACTIVATION_BUSY', 'RESTORE_STORAGE_BUSY']) {
		await processAutomaticRestore(f.db, { status: available, activate: async () => { throw Object.assign(new Error('private detail'), { code }); } });
		assert.equal(f.approval().state, 'pending');
		assert.equal(f.approval().error, null);
	}
	await processAutomaticRestore(f.db, { status: available, activate: async () => { throw new Error('synthetic-private-password'); } });
	assert.equal(f.approval().state, 'blocked');
	assert.doesNotMatch(f.approval().error, /synthetic-private-password/);
	assert.equal(storageStatus(f.db).jobs[0].status, 'blocked');
	assert.equal(storageStatus(f.db).jobs[0].canCancel, true);
	retryAutomaticRestore(f.db, f.jobId);
	assert.equal(f.approval().state, 'pending');
	assert.equal(f.approval().integration_fields, '[]');
	await processAutomaticRestore(f.db, { status: available, activate: async () => {} });
	assert.equal(f.approval().state, 'queued');
	assert.throws(() => retryAutomaticRestore(f.db, f.jobId));
});

test('durable publication is recognized after interrupted receipt and rollback never replays without an explicit retry', async (t) => {
	const f = fixture(t);
	f.ready();
	let published = false;
	await processAutomaticRestore(f.db, {
		status: () => published ? { ...available(), state: 'queued', restoreId: f.restoreId } : available(),
		activate: async () => { published = true; throw new Error('receipt lost'); }
	});
	assert.equal(f.approval().state, 'queued');
	f.db.prepare("UPDATE storage_restore_activations SET state='activating'").run();
	const rolledBack = () => ({ ...available(), state: 'rolled_back', restoreId: f.restoreId });
	await processAutomaticRestore(f.db, { status: rolledBack, activate: () => assert.fail('must not replay') });
	assert.equal(f.approval().state, 'blocked');
	await processAutomaticRestore(f.db, { status: rolledBack, activate: () => assert.fail('must remain paused') });
	retryAutomaticRestore(f.db, f.jobId);
	await processAutomaticRestore(f.db, { status: rolledBack, activate: async () => {} });
	assert.equal(f.approval().state, 'queued');
	await processAutomaticRestore(f.db, { status: rolledBack, activate: () => assert.fail('queued rollback must not replay') });
	assert.equal(f.approval().state, 'blocked');
	assert.equal(storageStatus(f.db).jobs[0].status, 'blocked');
});

test('waiting approvals remain visible, can be cancelled or paused and cannot activate afterwards', async (t) => {
	const f = fixture(t);
	f.ready();
	assert.equal(storageStatus(f.db).jobs[0].status, 'waiting');
	assert.equal(storageStatus(f.db).jobs[0].restoreDirectory, null);
	assert.deepEqual(storageStatus(f.db).preparedRestores, []);
	assert.equal(clearStorageJobLog(f.db), 0);
	assert.equal(pauseAndCancelStorageJobs(f.db), 1);
	assert.equal(f.approval().state, 'cancelled');
	assert.equal(await processAutomaticRestore(f.db, { status: available, activate: () => assert.fail('cancelled') }), false);
	assert.equal(storageStatus(f.db).jobs[0].status, 'cancelled');
	assert.throws(() => retryAutomaticRestore(f.db, f.jobId));
});

test('worker prepares and activates in one tick only after leaving tracked background work', async (t) => {
	const f = fixture(t);
	const previousKey = process.env.STORAGE_ENCRYPTION_KEY;
	process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
	t.after(() => {
		if (previousKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
		else process.env.STORAGE_ENCRYPTION_KEY = previousKey;
	});
	saveStorageSettings(f.db, { ...DEFAULT_STORAGE_SETTINGS, host: 'storage.invalid', username: 'synthetic', root: '/test', fingerprint: `SHA256:${'a'.repeat(43)}` }, 'synthetic-password');
	const events = [];
	const runtime = createActivationRuntime({
		env: { RESTORE_ACTIVATION_SUPERVISED: '1', RESTORE_ACTIVATION_DATA_PERSISTED: '1' },
		connected: () => true,
		maintenanceEnabled: () => false,
		enableMaintenance: async () => { events.push('maintenance'); },
		queue: async () => { events.push('queued'); return { id: 'synthetic-activation' }; },
		schedule: () => {}
	});
	await runStorageWorkerTick(() => f.db, {
		background: (operation, options) => runtime.background(operation, options),
		process: (db) => processStorageJob(db, {
			maintenanceOnly: true,
			prepareRestore: async () => { events.push('prepared'); return { restoreId: f.restoreId, audioMode: 'remote', remoteAudioFiles: 0 }; }
		}),
		activate: (db) => processAutomaticRestore(db, {
			status: () => ({ state: 'idle', ...runtime.availability() }),
			activate: (database, options, runtimeOptions) => activatePreparedRestore(database, options, {
				...runtimeOptions, activate: (value) => runtime.activate(value), stage: () => { events.push('credentials checked'); }
			})
		})
	});
	assert.deepEqual(events, ['prepared', 'credentials checked', 'maintenance', 'queued']);
	assert.equal(f.approval().state, 'queued');
	assert.equal(runtime.maintenance(), true);
});

test('approved restore replaces real SQLite only offline and cleans its source only after healthy finalization', async (t) => {
	const cwd = mkdtempSync(path.join(tmpdir(), 'arr-auto-restore-'));
	for (const root of ['db', 'uploads', 'voice', 'restore-staging']) mkdirSync(path.join(cwd, root));
	const f = fixture(t, path.join(cwd, 'db', 'pacs.db'));
	const previousKey = process.env.STORAGE_ENCRYPTION_KEY;
	process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
	t.after(() => {
		if (f.db.open) f.db.close();
		rmSync(cwd, { recursive: true, force: true });
		if (previousKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
		else process.env.STORAGE_ENCRYPTION_KEY = previousKey;
	});
	f.db.exec("CREATE TABLE restore_smoke(value TEXT); INSERT INTO restore_smoke VALUES('original')");
	saveStorageSettings(f.db, { ...DEFAULT_STORAGE_SETTINGS, host: 'storage.invalid', username: 'synthetic', root: '/test', fingerprint: `SHA256:${'a'.repeat(43)}` }, 'synthetic-password');
	const prepared = path.join(cwd, 'restore-staging', f.restoreId);
	let activation;
	const runtime = createActivationRuntime({
		cwd,
		env: { RESTORE_ACTIVATION_SUPERVISED: '1', RESTORE_ACTIVATION_DATA_PERSISTED: '1' },
		connected: () => true, maintenanceEnabled: () => false,
		enableMaintenance: async () => {}, schedule: () => {},
		queue: async (options) => { activation = await queueActivationFiles(options); return activation; }
	});
	await runStorageWorkerTick(() => f.db, {
		background: (operation, options) => runtime.background(operation, options),
		process: (db) => processStorageJob(db, { maintenanceOnly: true, prepareRestore: async () => {
			for (const root of ['db', 'uploads', 'voice']) mkdirSync(path.join(prepared, root), { recursive: true });
			await db.backup(path.join(prepared, 'db', 'pacs.db'));
			const copy = new Database(path.join(prepared, 'db', 'pacs.db'));
			try {
				copy.exec("DELETE FROM storage_restore_activations; DELETE FROM storage_restore_requests; DELETE FROM storage_jobs; DELETE FROM storage_worker_lock; UPDATE restore_smoke SET value='restored'");
				copy.pragma('wal_checkpoint(TRUNCATE)');
			} finally { copy.close(); }
			return { restoreId: f.restoreId, audioMode: 'remote', remoteAudioFiles: 0 };
		} }),
		activate: (db) => processAutomaticRestore(db, {
			status: () => ({ state: 'idle', ...runtime.availability() }),
			activate: (database, options, runtimeOptions) => activatePreparedRestore(database, options, {
				...runtimeOptions, cwd, activate: (value) => runtime.activate(value), stage: () => {}
			})
		})
	});
	assert.equal(f.approval().state, 'queued');
	assert.equal(f.db.prepare('SELECT value FROM restore_smoke').get().value, 'original');
	f.db.close();
	const installed = await applyPendingActivation({ cwd });
	assert.equal(installed.state, 'installed');
	assert.equal(existsSync(prepared), true);
	const healthy = new Database(path.join(cwd, 'db', 'pacs.db'));
	try {
		assert.equal(healthy.prepare('SELECT value FROM restore_smoke').get().value, 'restored');
		assert.equal(healthy.prepare('SELECT count(*) AS n FROM storage_restore_activations').get().n, 0);
		assert.equal((await finalizeActivation({ cwd, id: activation.id })).state, 'completed');
	} finally { healthy.close(); }
	assert.equal(existsSync(prepared), false);
	const rollback = new Database(path.join(cwd, installed.rollbackDirectory, 'db', 'pacs.db'), { readonly: true });
	try {
		assert.equal(rollback.prepare('SELECT value FROM restore_smoke').get().value, 'original');
		assert.equal(rollback.prepare('SELECT state FROM storage_restore_activations').get().state, 'queued');
	} finally { rollback.close(); }
});
