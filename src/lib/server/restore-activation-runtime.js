import path from 'node:path';
import { queueActivationFiles, activationStatus } from './restore-activation-files.js';
import { isSiteMaintenanceEnabled, setSiteMaintenance } from './site-maintenance.js';

export function createActivationRuntime({
	env = process.env,
	cwd = process.cwd(),
	connected = () => process.connected === true && typeof process.send === 'function',
	send = (message) => process.send(message),
	queue = queueActivationFiles,
	maintenanceEnabled = isSiteMaintenanceEnabled,
	enableMaintenance = (userId) => setSiteMaintenance({ enabled: true, userId }),
	schedule = (operation) => setTimeout(operation, 1000),
	wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
	let requests = 0;
	let background = 0;
	let preparing = false;
	let booting = env.RESTORE_ACTIVATION_PENDING || '';
	function supported() {
		const voice = path.resolve(cwd, env.VOICE_SAVE_DIR || 'uploads/audio');
		const inside = (root) => voice === root || voice.startsWith(`${root}${path.sep}`);
		return env.RESTORE_ACTIVATION_SUPERVISED === '1' &&
			env.RESTORE_ACTIVATION_DATA_PERSISTED === '1' && connected() &&
			(inside(path.join(cwd, 'uploads')) || voice === path.join(cwd, 'voice'));
	}
	function maintenance() { return preparing || Boolean(booting); }
	return {
		maintenance,
		availability: () => ({ supported: supported(), maintenance: maintenance() }),
		confirm(id) { if (booting && id === booting) booting = ''; },
		async request(operation) {
			requests += 1;
			try { return await operation(); }
			finally { requests -= 1; }
		},
		async background(operation, { allowDuringMaintenance = false } = {}) {
			if (maintenance() || (!allowDuringMaintenance && maintenanceEnabled())) return;
			background += 1;
			try { return await operation(); }
			finally { background -= 1; }
		},
		async activate({ validate = () => {}, ...options }) {
			if (!supported() || maintenance()) throw new Error('Automatic activation is unavailable.');
			preparing = true;
			let queued = false;
			try {
				if (background) throw new Error('Wait for background jobs to finish.');
				for (let attempt = 0; requests > 1; attempt += 1) {
					if (attempt >= 600) throw new Error('Wait for active requests to finish.');
					await wait(50);
				}
				if (!supported()) throw new Error('Startup supervisor is unavailable.');
				await validate();
				await enableMaintenance(options.requestedBy);
				const activation = await queue({ ...options, cwd });
				queued = true;
				schedule(() => {
					try { send({ type: 'restore-activation-requested', id: activation.id }); }
					catch { console.error('Restore activation is queued; restart the container to continue.'); }
				});
				return activation;
			} catch (error) {
				if (!queued) preparing = false;
				throw error;
			}
		}
	};
}

export const restoreActivation = createActivationRuntime();
export const runBackgroundTask = (operation, options) => restoreActivation.background(operation, options);
export function restoreActivationStatus() {
	return { ...activationStatus({ cwd: process.cwd() }), ...restoreActivation.availability() };
}
if (process.env.RESTORE_ACTIVATION_SUPERVISED === '1') {
	process.on('message', (message) => {
		if (message?.type === 'restore-activation-confirmed') restoreActivation.confirm(message.id);
	});
}
