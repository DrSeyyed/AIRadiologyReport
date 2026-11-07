import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryProgress, safeRecoveryProgress } from '../src/lib/server/recovery-progress.js';

test('backup progress reports live counters without treating a heartbeat as file activity', (t) => {
	t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_800_000_000_000 });
	const snapshots = [];
	const progress = recoveryProgress((value) => snapshots.push(value));
	try {
		progress.set({ phase: 'collecting', totalFiles: 3 });
		progress.add('files');
		t.mock.timers.tick(2_000);
		assert.equal(snapshots.at(-1).files, 1);
		assert.equal(snapshots.at(-1).phase, 'collecting');
		assert.equal(snapshots.at(-1).lastActivityAt, 1_800_000_000);
		t.mock.timers.tick(10_000);
		assert.equal(snapshots.at(-1).lastActivityAt, 1_800_000_000);
		progress.add('uploadedBytes', 64);
		t.mock.timers.tick(2_000);
		assert.equal(snapshots.at(-1).uploadedBytes, 64);
		assert.equal(snapshots.at(-1).lastActivityAt, 1_800_000_012);
		assert.equal(snapshots[0].files, 0, 'earlier snapshots must not be mutated');
	} finally {
		progress.finish();
	}
	const count = snapshots.length;
	t.mock.timers.tick(60_000);
	assert.equal(snapshots.length, count);
});

test('parallel transfer counts settle on success and failure', async () => {
	const snapshots = [];
	const progress = recoveryProgress((value) => snapshots.push(value));
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	try {
		const first = progress.track('uploading', () => gate);
		const second = progress.track('uploading', () => gate);
		progress.finish();
		assert.equal(snapshots.at(-1).uploading, 2);
		release();
		await Promise.all([first, second]);
		await assert.rejects(
			progress.track('verifying', () => {
				throw new Error('test');
			}),
			/test/
		);
	} finally {
		release();
		progress.finish();
	}
	assert.equal(snapshots.at(-1).uploading, 0);
	assert.equal(snapshots.at(-1).verifying, 0);
});

test('progress callback failures are captured instead of escaping interval callbacks', (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] });
	const progress = recoveryProgress(() => {
		throw new Error('observer failed');
	});
	try {
		t.mock.timers.tick(2_000);
		assert.throws(() => progress.assertHealthy(), /observer failed/);
	} finally {
		progress.finish();
	}
});

test('only valid numeric counters and known phases are exposed by the progress sanitizer', () => {
	let snapshot;
	const progress = recoveryProgress((value) => {
		snapshot = value;
	});
	progress.finish();
	const safe = safeRecoveryProgress(snapshot);
	assert.deepEqual(safeRecoveryProgress({ ...safe, secret: 'not for the browser' }), safe);
	assert.equal(safeRecoveryProgress({ ...safe, phase: 'verifying', verifying: 16 }).verifying, 16);
	assert.equal(safeRecoveryProgress({ ...safe, uploading: 8, verifying: 8 }).uploading, 8);
	for (const invalid of [
		null,
		{},
		{ ...safe, phase: 'private path/password' },
		{ ...safe, files: -1 },
		{ ...safe, files: 1 },
		{ ...safe, uploading: 17 },
		{ ...safe, uploading: 8, verifying: 9 },
		{ ...safe, verifying: 17 },
		{ ...safe, uploadedObjects: 1 },
		{ ...safe, reusedObjects: 1 },
		{ ...safe, uploadedBytes: Infinity },
		{ ...safe, verificationBytes: 0.5 },
		{ ...safe, downloadedBytes: '123' },
		{ ...safe, lastActivityAt: Number.MAX_SAFE_INTEGER + 1 }
	])
		assert.equal(safeRecoveryProgress(invalid), null);
});
