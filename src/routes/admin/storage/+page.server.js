import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { assertStorageKey } from '$lib/server/storage-crypto.js';
import {
	DEFAULT_STORAGE_SETTINGS,
	getStorageSettings,
	getStorageConnection,
	normalizeStorageSettings,
	saveStorageSettings,
	storagePasswordConfigured
} from '$lib/server/storage-settings.js';
import { probeStorageHost } from '$lib/server/storage-transport.js';
import {
	queueStorageJob,
	storageStatus,
	cancelStorageJob,
	pauseAndCancelStorageJobs,
	clearStorageJobLog,
	queueStorageReset
} from '$lib/server/storage-worker.js';
import { listRecovery } from '$lib/server/recovery-backups.js';

function requireAdmin(locals) {
	if (!locals.user) throw redirect(302, '/login');
	if (locals.user.role !== 'admin') throw error(403, 'Forbidden');
}

function field(form, name) {
	if (form.getAll(name).length !== 1 || typeof form.get(name) !== 'string')
		throw new Error('Complete each connection, schedule and retention field once.');
	return form.get(name);
}

function storageFormSettings(form) {
	const values = {};
	for (const [key, defaultValue] of Object.entries(DEFAULT_STORAGE_SETTINGS)) {
		if (typeof defaultValue === 'boolean') {
			if (form.getAll(key).length > 1 || (form.has(key) && form.get(key) !== 'on'))
				throw new Error('Invalid storage switch.');
			values[key] = form.has(key);
		} else if (typeof defaultValue === 'number') {
			const value = field(form, key);
			if (!/^\d+$/.test(value)) throw new Error('Enter whole numbers for schedules and retention.');
			values[key] = Number(value);
		} else values[key] = field(form, key).trim();
	}
	return normalizeStorageSettings(values);
}

export function load({ locals }) {
	requireAdmin(locals);
	const db = getDb();
	let keyConfigured = false;
	try {
		assertStorageKey();
		keyConfigured = true;
	} catch {
		/* Only expose whether a valid key exists. */
	}
	return {
		settings: getStorageSettings(db),
		passwordConfigured: storagePasswordConfigured(db),
		keyConfigured,
		status: storageStatus(db)
	};
}

export const actions = {
	save: async ({ locals, request }) => {
		requireAdmin(locals);
		let settings;
		let password;
		try {
			const form = await request.formData();
			settings = storageFormSettings(form);
			password = field(form, 'password');
		} catch {
			return fail(400, {
				error:
					'Invalid storage settings. Complete the connection, SHA256 fingerprint and schedule fields with valid values.'
			});
		}
		try {
			saveStorageSettings(getDb(), settings, password);
			return {
				message:
					'Storage settings saved. Passwords are never displayed. Background jobs run only for enabled services.'
			};
		} catch {
			return fail(400, {
				error:
					'Settings were not saved. Check the server encryption key and saved password. Wait for running jobs to finish; an in-use destination cannot be changed without migration.'
			});
		}
	},
	probe: async ({ locals, request }) => {
		requireAdmin(locals);
		try {
			const form = await request.formData();
			const port = field(form, 'port');
			if (!/^\d+$/.test(port)) throw new Error();
			const config = normalizeStorageSettings({
				host: field(form, 'host').trim(),
				port: Number(port)
			});
			if (!config.host) throw new Error();
			const fingerprint = await probeStorageHost(config);
			return {
				fingerprint,
				message:
					'Fingerprint observed without authentication. Verify it independently with your hosting provider before copying it into the trusted fingerprint field and saving.'
			};
		} catch {
			return fail(400, {
				error:
					'Unable to read the SSH host fingerprint. Check hostname, SSH port and network access.'
			});
		}
	},
	cancel: async ({ locals, request }) => {
		requireAdmin(locals);
		try {
			const form = await request.formData();
			const id = field(form, 'jobId');
			if (!/^[1-9]\d{0,15}$/.test(id)) throw new Error();
			const cancelled = cancelStorageJob(getDb(), Number(id));
			return {
				message: cancelled
					? 'Cancellation requested. Waiting/retrying jobs will not run again. Running work stops at its next safety check; refresh status before changing credentials. Automatic schedules remain enabled unless paused separately.'
					: 'This job has already finished or been cancelled.'
			};
		} catch {
			return fail(400, {
				error: 'Unable to cancel this job. Refresh status and select a valid job.'
			});
		}
	},
	pause: async ({ locals, request }) => {
		requireAdmin(locals);
		try {
			const form = await request.formData();
			if (field(form, 'confirmation') !== 'pause') throw new Error();
			const count = pauseAndCancelStorageJobs(getDb());
			return {
				message: `Background storage jobs paused; cancellation requested for ${count} jobs, including connection tests and restore preparations. Running operations may need to finish or time out before settings can be saved. Refresh status, then change the password and test the connection before re-enabling jobs.`
			};
		} catch {
			return fail(400, { error: 'Unable to pause storage jobs. Refresh status and try again.' });
		}
	},
	clearLog: async ({ locals, request }) => {
		requireAdmin(locals);
		try {
			const form = await request.formData();
			if (field(form, 'confirmation') !== 'clear') throw new Error();
			const count = clearStorageJobLog(getDb());
			return {
				message: `Cleared ${count} finished jobs from the log. Active and retrying jobs remain visible; safety metadata, audio and backups are preserved.`
			};
		} catch {
			return fail(400, { error: 'Unable to clear the log. Confirm clearing finished jobs once.' });
		}
	},
	reset: async ({ locals, request }) => {
		requireAdmin(locals);
		try {
			const form = await request.formData();
			if (field(form, 'confirmation') !== 'RESET STORAGE' || field(form, 'recoverAudio') !== 'on')
				throw new Error();
			const db = getDb();
			assertStorageKey();
			const connection = getStorageConnection(db);
			normalizeStorageSettings({ ...getStorageSettings(db), enabled: true });
			if (!connection.password) throw new Error();
			const id = queueStorageReset(db);
			return {
				message: `Storage reset job ${id} queued; schedules are paused. The worker first recovers and hash-verifies all archived audio locally, then removes only audio/ and backups/ under the saved remote root. The live database is not restored or deleted. Schedules remain paused after completion. Refresh status to monitor progress.`
			};
		} catch {
			return fail(400, {
				error:
					'Unable to queue storage reset. Enter RESET STORAGE exactly and confirm audio recovery once. Check the saved connection and encryption key. Use Pause & cancel all, then wait until no jobs are running or cancelling and no reset is active before retrying.'
			});
		}
	},
	recoveryPoints: async ({ locals }) => {
		requireAdmin(locals);
		try {
			const db = getDb();
			const connection = getStorageConnection(db);
			normalizeStorageSettings({ ...getStorageSettings(db), enabled: true });
			if (!connection.password) throw new Error();
			const seen = new Set();
			const recoveryPoints = (await listRecovery(connection)).map(({ id, kind }) => {
				if (seen.has(id)) throw new Error('Ambiguous recovery point.');
				seen.add(id);
				return { id, kind };
			});
			return {
				recoveryPoints,
				message: recoveryPoints.length
					? 'Select a completed recovery point to prepare a verified copy. The live site will not be replaced.'
					: 'No completed recovery points were found on the saved storage server.'
			};
		} catch {
			return fail(400, {
				error:
					'Unable to list recovery points. Check the saved storage connection, host fingerprint and encryption key.'
			});
		}
	},
	restore: async ({ locals, request }) => {
		requireAdmin(locals);
		try {
			const form = await request.formData();
			if (field(form, 'confirmation') !== 'prepare') throw new Error();
			const backupId = field(form, 'backupId');
			const db = getDb();
			const connection = getStorageConnection(db);
			normalizeStorageSettings({ ...getStorageSettings(db), enabled: true });
			if (!connection.password) throw new Error();
			const id = queueStorageJob(db, 'restore', { backupId, retryNow: true });
			return {
				message: `Restore preparation job ${id} queued. Refresh status for the verified copy's location. The live site will not be replaced; activation requires a server administrator.`
			};
		} catch {
			return fail(400, {
				error:
					'Unable to prepare restore. Select a valid completed recovery point, confirm preparation and check the saved connection. Wait for any existing restore preparation to finish.'
			});
		}
	},
	job: async ({ locals, request }) => {
		requireAdmin(locals);
		try {
			const form = await request.formData();
			const kind = field(form, 'kind');
			const db = getDb();
			const connection = getStorageConnection(db);
			normalizeStorageSettings({ ...getStorageSettings(db), enabled: true });
			if (!connection.password) throw new Error();
			const id = queueStorageJob(db, kind, { retryNow: true });
			return {
				message: `Job ${id} queued. Refresh this page to see progress. Failed jobs retry automatically, up to eight attempts.`
			};
		} catch {
			return fail(400, {
				error:
					'Unable to queue the job. Save a complete connection and enable the requested service first.'
			});
		}
	}
};
