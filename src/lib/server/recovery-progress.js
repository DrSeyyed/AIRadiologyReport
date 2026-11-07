import { MAX_STORAGE_PARALLEL_CONNECTIONS } from './storage-settings.js';

const phases = [
	'preparing',
	'snapshotting',
	'discovering',
	'checking',
	'collecting',
	'transferring',
	'verifying',
	'publishing',
	'cleanup',
	'pruning'
];
const fields = [
	'files',
	'totalFiles',
	'bundles',
	'uploadedObjects',
	'reusedObjects',
	'uploading',
	'verifying',
	'uploadedBytes',
	'downloadedBytes',
	'verificationBytes',
	'lastActivityAt'
];

export function safeRecoveryProgress(progress) {
	if (
		!progress ||
		!phases.includes(progress.phase) ||
		!fields.every((field) => Number.isSafeInteger(progress[field]) && progress[field] >= 0)
	)
		return null;
	if (
		progress.files > progress.totalFiles ||
		progress.uploadedObjects + progress.reusedObjects > progress.bundles ||
		progress.uploading + progress.verifying > MAX_STORAGE_PARALLEL_CONNECTIONS
	)
		return null;
	return {
		phase: progress.phase,
		...Object.fromEntries(fields.map((field) => [field, progress[field]]))
	};
}

export function recoveryProgress(onProgress = () => {}) {
	const state = {
		phase: 'preparing',
		files: 0,
		totalFiles: 0,
		bundles: 0,
		uploadedObjects: 0,
		reusedObjects: 0,
		uploading: 0,
		verifying: 0,
		uploadedBytes: 0,
		downloadedBytes: 0,
		verificationBytes: 0,
		lastActivityAt: Math.floor(Date.now() / 1000)
	};
	let failure;
	const activity = () => {
		state.lastActivityAt = Math.floor(Date.now() / 1000);
	};
	const report = () => {
		try {
			onProgress({ ...state });
		} catch (error) {
			failure ||= error;
		}
	};
	const timer = setInterval(report, 2_000);
	timer.unref();
	report();
	return {
		activity,
		set(values) {
			Object.assign(state, values);
			activity();
		},
		add(field, count = 1) {
			state[field] += count;
			activity();
		},
		assertHealthy() {
			if (failure) throw failure;
		},
		async track(field, operation) {
			state[field]++;
			activity();
			try {
				return await operation();
			} finally {
				state[field]--;
				activity();
			}
		},
		finish() {
			clearInterval(timer);
			report();
		}
	};
}
