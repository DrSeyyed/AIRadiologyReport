import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreProgress, safeRestoreProgress } from '../src/lib/server/restore-progress.js';

const snapshot = {
	phase: 'downloading',
	downloadedObjects: 1,
	totalObjects: 2,
	restoredFiles: 0,
	totalFiles: 3,
	downloadedBytes: 20,
	verificationBytes: 20,
	elapsedSeconds: 2,
	lastActivityAt: 100
};

test('restore progress accepts only safe phases and bounded integer counts, stripping other fields', () => {
	assert.deepEqual(
		safeRestoreProgress({ ...snapshot, path: 'private/patient', error: 'secret' }),
		snapshot
	);
	for (const invalid of [
		null,
		{},
		{ ...snapshot, phase: 'private/patient' },
		{ ...snapshot, downloadedObjects: 3 },
		{ ...snapshot, restoredFiles: 4 },
		{ ...snapshot, totalObjects: 100_001 },
		{ ...snapshot, totalFiles: 100_001 }
	])
		assert.equal(safeRestoreProgress(invalid), null);
	for (const field of Object.keys(snapshot).filter((key) => key !== 'phase'))
		for (const value of [
			-1,
			NaN,
			Infinity,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
			'private/patient',
			undefined
		])
			assert.equal(safeRestoreProgress({ ...snapshot, [field]: value }), null);
});

test('live restore progress reports initially, throttles activity, retains elapsed and stops its timer', (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 100_000 });
	const reports = [];
	const progress = restoreProgress((value) => reports.push(value));
	assert.equal(reports.length, 1);
	assert.equal(reports[0].phase, 'preparing');
	progress.set({ phase: 'downloading', totalObjects: 2 });
	for (let i = 0; i < 100; i++) progress.add('downloadedBytes');
	assert.equal(reports.length, 2);
	t.mock.timers.tick(2_000);
	assert.equal(reports.at(-1).downloadedBytes, 100);
	assert.equal(reports.at(-1).elapsedSeconds, 2);
	assert.equal(reports.at(-1).lastActivityAt, 100);
	progress.set({ phase: 'complete' });
	assert.equal(reports.at(-1).phase, 'complete');
	progress.finish();
	const count = reports.length;
	t.mock.timers.tick(10_000);
	assert.equal(reports.length, count);
	assert.ok(reports.every((value) => safeRestoreProgress(value)));
});

test('progress callback failures halt preparation safely and timer is disposable', (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] });
	const progress = restoreProgress(() => {
		throw new Error('stopped');
	});
	assert.throws(() => progress.assertHealthy(), /stopped/);
	assert.throws(() => progress.set({ phase: 'downloading' }), /stopped/);
	progress.finish();
});
