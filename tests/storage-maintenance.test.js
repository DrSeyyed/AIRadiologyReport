import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import {
	DEFAULT_STORAGE_SETTINGS,
	saveStorageSettings
} from '../src/lib/server/storage-settings.js';
import {
	queueStorageMaintenance,
	queueStorageJob,
	queueStorageReset,
	processStorageJob,
	storageStatus,
	cancelStorageJob
} from '../src/lib/server/storage-worker.js';

const backupId = '1800000100-22222222-2222-2222-2222-222222222222';
const now = Math.floor(Date.now() / 1000);
function fixture(t) {
	const previous = process.env.STORAGE_ENCRYPTION_KEY;
	process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
	const db = new Database(':memory:');
	initializeSchema(db, readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
	const settings = {
		...DEFAULT_STORAGE_SETTINGS,
		enabled: false,
		host: 'storage.invalid',
		username: 'synthetic',
		root: '/radiology',
		fingerprint: `SHA256:${'a'.repeat(43)}`
	};
	saveStorageSettings(db, settings, 'synthetic-password');
	t.after(() => {
		db.close();
		if (previous === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
		else process.env.STORAGE_ENCRYPTION_KEY = previous;
	});
	return { db, settings };
}
const progress = (checked = 1) => ({
	checked,
	total: 3,
	verifiedBytes: checked * 1024 * 1024,
	elapsedSeconds: 4,
	lastActivityAt: now
});

test('maintenance queues durably while paused, deduplicates retries and remains separate from restores', (t) => {
	const { db } = fixture(t);
	const id = queueStorageMaintenance(db, 'audit', { now });
	assert.equal(queueStorageMaintenance(db, 'audit', { now }), id);
	const restore = queueStorageJob(db, 'restore', { backupId, now });
	assert.notEqual(id, restore);
	assert.deepEqual(
		storageStatus(db, now).jobs.map((job) => job.kind),
		['restore', 'audit']
	);
	assert.throws(
		() => queueStorageMaintenance(db, 'delete', { backupIds: [backupId], now }),
		/restore preparation/
	);
	cancelStorageJob(db, restore, { now });
	const deletion = queueStorageMaintenance(db, 'delete', { backupIds: [backupId], now });
	assert.equal(queueStorageMaintenance(db, 'delete', { backupIds: [backupId], now }), deletion);
	assert.throws(() => queueStorageJob(db, 'restore', { backupId, now }), /backup deletion/);
	assert.throws(() =>
		queueStorageMaintenance(db, 'delete', {
			backupIds: [backupId.replace('22222222', '33333333')],
			now
		})
	);
	assert.throws(() => queueStorageMaintenance(db, 'delete', { backupIds: ['../escape'], now }));
	assert.throws(() => queueStorageMaintenance(db, 'full', { now }));
});

test('maintenance cannot queue during reset and reset cancels queued maintenance', (t) => {
	const { db } = fixture(t);
	const audit = queueStorageMaintenance(db, 'audit', { now });
	queueStorageReset(db, { now });
	assert.equal(storageStatus(db, now).jobs.find((job) => job.id === audit).status, 'cancelled');
	assert.throws(() => queueStorageMaintenance(db, 'audit', { now }), /reset/);
	assert.throws(
		() => queueStorageMaintenance(db, 'delete', { backupIds: [backupId], now }),
		/reset/
	);
});

test('manual audit runs while paused, persists sanitized progress and exposes duration without restore/reset labels', async (t) => {
	const { db } = fixture(t);
	const id = queueStorageMaintenance(db, 'audit', { now });
	await processStorageJob(db, {
		now,
		async runAudit(_db, _connection, options) {
			assert.equal(options.owned(), true);
			options.onProgress({ ...progress(), secret: 'must-not-appear' });
			const job = storageStatus(db, now).jobs[0];
			assert.equal(job.kind, 'audit');
			assert.match(job.progress, /Checksums: 1\/3/);
			assert.match(job.progress, /elapsed: 4s/);
			assert.ok(!JSON.stringify(job).includes('must-not-appear'));
			return { ...progress(3), secret: 'must-not-appear' };
		}
	});
	const status = storageStatus(db, now);
	assert.equal(status.jobs[0].id, id);
	assert.equal(status.jobs[0].status, 'succeeded');
	assert.equal(status.jobs[0].kind, 'audit');
	assert.equal(status.jobs[0].restoreDirectory, null);
	assert.deepEqual(status.preparedRestores, []);
	assert.deepEqual(status.last, []);
	assert.deepEqual(
		JSON.parse(db.prepare('SELECT result FROM storage_jobs WHERE id=?').get(id).result),
		progress(3)
	);
});

test('cancelling running audit keeps safe progress and prevents success or retry', async (t) => {
	const { db } = fixture(t);
	const id = queueStorageMaintenance(db, 'audit', { now });
	await processStorageJob(db, {
		now,
		async runAudit(_db, _connection, options) {
			options.onProgress(progress());
			cancelStorageJob(db, id, { now });
			assert.equal(options.owned(), false);
			assert.throws(() => options.onProgress(progress(2)));
			return progress(3);
		}
	});
	const job = storageStatus(db, now).jobs[0];
	assert.equal(job.status, 'cancelled');
	assert.match(job.progress, /Checksums: 1\/3/);
	assert.equal(job.canCancel, false);
	assert.equal(await processStorageJob(db, { now: now + 1000 }), false);
});

test('deletion persists plan and eviction fence before mutations and reuses it after interruption', async (t) => {
	const { db } = fixture(t);
	const id = queueStorageMaintenance(db, 'delete', { backupIds: [backupId], now });
	const plan = [{ id: backupId, kind: 'full' }];
	await processStorageJob(db, {
		now,
		async deleteBackups(_connection, options) {
			assert.equal(options.plan, null);
			options.onPlan(plan);
			assert.deepEqual(
				JSON.parse(
					db.prepare('SELECT plan FROM storage_maintenance_requests WHERE job_id=?').get(id).plan
				),
				plan
			);
			assert.ok(
				db.prepare('SELECT 1 FROM storage_deleted_recovery_points WHERE backup_id=?').get(backupId)
			);
			options.onProgress({ deleted: 0, total: 1, secret: 'hidden' });
			throw new Error('sensitive remote failure');
		}
	});
	assert.equal(storageStatus(db, now).jobs[0].kind, 'delete');
	assert.equal(storageStatus(db, now).jobs[0].status, 'failed');
	assert.ok(!JSON.stringify(storageStatus(db, now)).includes('sensitive'));
	assert.equal(
		queueStorageMaintenance(db, 'delete', { backupIds: [backupId], now, retryNow: true }),
		id
	);
	await processStorageJob(db, {
		now,
		async deleteBackups(_connection, options) {
			assert.deepEqual(options.plan, plan);
			options.onProgress({ deleted: 1, total: 1 });
			return { deleted: 1, total: 1, secret: 'not persisted' };
		}
	});
	const job = storageStatus(db, now).jobs[0];
	assert.equal(job.status, 'succeeded');
	assert.equal(job.kind, 'delete');
	assert.match(job.progress, /removed: 1\/1/);
	assert.equal(job.backupId, null);
	assert.deepEqual(
		JSON.parse(db.prepare('SELECT result FROM storage_jobs WHERE id=?').get(id).result),
		{ deleted: 1, total: 1 }
	);
});

test('changing saved destination fails maintenance before remote work', async (t) => {
	const { db, settings } = fixture(t);
	for (const operation of ['audit', 'delete']) {
		saveStorageSettings(db, settings);
		const id = queueStorageMaintenance(db, operation, { backupIds: [backupId], now });
		saveStorageSettings(db, { ...settings, root: '/other-storage' });
		await processStorageJob(db, {
			now,
			runAudit() {
				assert.fail('must not audit changed destination');
			},
			deleteBackups() {
				assert.fail('must not delete changed destination');
			}
		});
		assert.equal(storageStatus(db, now).jobs[0].status, 'failed');
		assert.match(
			storageStatus(db, now).jobs[0].error,
			operation === 'audit' ? /Checksum audit stopped/ : /Backup deletion stopped/
		);
		cancelStorageJob(db, id, { now });
	}
});

test('maintenance failure diagnostics never accept raw injected errors or invalid final progress', async (t) => {
	const { db } = fixture(t);
	queueStorageMaintenance(db, 'audit', { now });
	await processStorageJob(db, {
		now,
		runAudit: async () => ({ checked: 'not safe', secret: 'credential' })
	});
	const job = storageStatus(db, now).jobs[0];
	assert.equal(job.status, 'failed');
	assert.match(job.error, /Checksum audit stopped/);
	assert.ok(!JSON.stringify(job).includes('credential'));
});
