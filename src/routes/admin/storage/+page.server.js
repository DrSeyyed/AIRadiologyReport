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
	queueStorageReset,
	queueStorageMaintenance
} from '$lib/server/storage-worker.js';
import { listRecovery } from '$lib/server/recovery-backups.js';

function requireAdmin(locals) {
	if (!locals.user) throw redirect(302, '/login');
	if (locals.user.role !== 'admin') throw error(403, 'Forbidden');
}

function field(form, name) {
	if (form.getAll(name).length !== 1 || typeof form.get(name) !== 'string')
		throw new Error('Complete each connection, timeout, schedule and retention field once.');
	return form.get(name);
}

function storageFormSettings(form) {
	const values = {};
	for (const [key, defaultValue] of Object.entries(DEFAULT_STORAGE_SETTINGS)) {
		if (typeof defaultValue === 'boolean') {
			if (form.getAll(key).length > 1 || (form.has(key) && form.get(key) !== 'on'))
				throw new Error('Invalid storage switch.');
			values[key] = form.has(key);
		} else if (key === 'fullBackupHours') {
			const value = field(form, key).trim();
			if (!/^\d+(?:\s*,\s*\d+)*$/.test(value))
				throw new Error('Enter comma-separated UTC hours from 0 to 23.');
			values[key] = value.split(',').map((hour) => Number(hour.trim()));
		} else if (typeof defaultValue === 'number') {
			if (
				['databaseIntervalHours', 'fileBackupHour', 'syncIntervalMinutes'].includes(key) &&
				!form.has(key)
			)
				continue;
			const value = field(form, key);
			if (!/^\d+$/.test(value))
				throw new Error('Enter whole numbers for timeouts, schedules and retention.');
			values[key] = Number(value);
		} else values[key] = field(form, key).trim();
	}
	return normalizeStorageSettings(values);
}

export function load({ locals, url }) {
	requireAdmin(locals);
	const requestedTab = url?.searchParams.get('tab');
	const tab = ['overview', 'settings', 'restore', 'maintenance'].includes(requestedTab)
		? requestedTab
		: 'overview';
	const db = getDb();
	let keyConfigured = false;
	try {
		assertStorageKey();
		keyConfigured = true;
	} catch {
		/* Only expose whether a valid key exists. */
	}
	return {
		tab,
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
					'Invalid storage settings. Complete the connection, SHA256 fingerprint, timeout and schedule fields with valid values. Synchronization intervals must be whole minutes from 1 to 1440. Inactivity timeouts must be whole seconds from 1 to 600; full backup hours must be 1–24 unique comma-separated UTC hours from 0 to 23, and integrity audit days must be from 1 to 365.'
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
				message: `Storage reset job ${id} queued; schedules are paused. The worker first recovers and hash-verifies all archived audio locally, then removes only audio/, files/ and backups/ under the saved remote root. The live database is not restored or deleted. Schedules remain paused after completion. Refresh status to monitor progress.`
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
					? 'Recovery points loaded. Select a point to prepare a verified copy in Restore, or select points for permanent deletion in Maintenance.'
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
					'Unable to prepare restore. Select a valid completed recovery point, confirm preparation and check the saved connection. Wait for existing restore preparation or backup deletion to finish.'
			});
		}
	},
	audit: async ({ locals, request }) => {
		requireAdmin(locals);
		try {
			const form = await request.formData();
			if (field(form, 'confirmation') !== 'audit') throw new Error();
			const db = getDb();
			const connection = getStorageConnection(db);
			normalizeStorageSettings({ ...getStorageSettings(db), enabled: true });
			if (!connection.password) throw new Error();
			const id = queueStorageMaintenance(db, 'audit', { retryNow: true });
			return {
				message: `Checksum audit job ${id} queued. All tracked encrypted file copies are checked, including recently verified ones. See progress, elapsed time and cancellation in Overview & jobs.`
			};
		} catch {
			return fail(400, {
				error:
					'Unable to queue checksum audit. Check the saved connection and encryption key, and wait for any storage reset or maintenance cancellation to finish.'
			});
		}
	},
	deleteBackups: async ({ locals, request }) => {
		requireAdmin(locals);
		try {
			const form = await request.formData();
			if (field(form, 'confirmation') !== 'DELETE BACKUPS' || field(form, 'acknowledge') !== 'on')
				throw new Error();
			const backupIds = form.getAll('backupIds');
			const db = getDb();
			const connection = getStorageConnection(db);
			normalizeStorageSettings({ ...getStorageSettings(db), enabled: true });
			if (!connection.password) throw new Error();
			const id = queueStorageMaintenance(db, 'delete', { backupIds, retryNow: true });
			return {
				recoveryPoints: [],
				message: `Backup deletion job ${id} queued. Selected recovery points, including the newest if selected, will be permanently removed. Shared encrypted objects and live data are kept. Monitor or cancel in Overview & jobs; reload the recovery-point list afterward.`
			};
		} catch {
			return fail(400, {
				error:
					'Unable to queue backup deletion. Select 1–100 distinct recovery points, type DELETE BACKUPS and acknowledge permanent deletion. Check the saved connection; wait for restore preparation, storage reset or a different deletion job to finish.'
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
