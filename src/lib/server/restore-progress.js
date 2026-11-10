const phases = [
	'preparing',
	'listing',
	'manifest',
	'downloading',
	'decrypting',
	'verifying',
	'database',
	'publishing',
	'complete'
];
const fields = [
	'downloadedObjects',
	'totalObjects',
	'restoredFiles',
	'totalFiles',
	'downloadedBytes',
	'verificationBytes',
	'elapsedSeconds',
	'lastActivityAt'
];

export function safeRestoreProgress(progress) {
	if (
		!progress ||
		!phases.includes(progress.phase) ||
		!fields.every((field) => Number.isSafeInteger(progress[field]) && progress[field] >= 0) ||
		progress.downloadedObjects > progress.totalObjects ||
		progress.restoredFiles > progress.totalFiles ||
		progress.totalObjects > 100_000 ||
		progress.totalFiles > 100_000
	)
		return null;
	return {
		phase: progress.phase,
		...Object.fromEntries(fields.map((field) => [field, progress[field]]))
	};
}

/** Only allowlisted aggregate counters leave the restore pipeline. */
export function restoreProgress(onProgress = () => {}) {
	const started = Date.now();
	const state = {
		phase: 'preparing',
		...Object.fromEntries(fields.map((field) => [field, 0])),
		lastActivityAt: Math.floor(started / 1000)
	};
	let failure;
	let lastReport = 0;
	const report = () => {
		if (failure) return;
		state.elapsedSeconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
		lastReport = Date.now();
		try {
			onProgress({ ...state });
		} catch (error) {
			failure = error;
		}
	};
	const assertHealthy = () => {
		if (failure) throw failure;
	};
	const timer = setInterval(report, 2_000);
	timer.unref();
	report();
	return {
		assertHealthy,
		set(values) {
			assertHealthy();
			const changed = values.phase && values.phase !== state.phase;
			Object.assign(state, values);
			state.lastActivityAt = Math.floor(Date.now() / 1000);
			if (changed || Date.now() - lastReport >= 2_000) report();
			assertHealthy();
		},
		add(field, count = 1) {
			this.set({ [field]: state[field] + count });
		},
		finish() {
			clearInterval(timer);
		}
	};
}
