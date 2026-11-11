import { error, fail, redirect } from '@sveltejs/kit';
import { siteMaintenanceStatus, setSiteMaintenance } from '$lib/server/site-maintenance.js';
import { pendingRestoreMetadata } from '$lib/server/integration-restore-admin.js';
import { discardPendingIntegrationRestore } from '$lib/server/integration-backup.js';
import { withIntegrationConfigurationLock } from '$lib/server/integration-coordination.js';

const statusError =
	'Maintenance needs attention. Check Telegram permissions, any selected integration restoration and webhook registration, and retry. The website remains closed until reopening succeeds.';

function requireAdmin(locals) {
	if (!locals.user) throw redirect(302, '/login');
	if (locals.user.role !== 'admin') throw error(403, 'Forbidden');
}

function sanitizeStatus(value) {
	const status = {
		enabled: typeof value?.enabled === 'boolean' ? value.enabled : true,
		phase: ['off', 'enabled', 'enabling', 'disabling', 'error'].includes(value?.phase)
			? value.phase
			: 'error',
		telegram: ['disabled', 'locked', 'pending', 'error'].includes(value?.telegram)
			? value.telegram
			: 'error'
	};
	if (typeof value?.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)))
		status.updatedAt = new Date(value.updatedAt).toISOString();
	if (value?.error || status.phase === 'error' || status.telegram === 'error')
		status.error = statusError;
	return status;
}

function currentStatus() {
	try {
		return sanitizeStatus(siteMaintenanceStatus());
	} catch {
		return sanitizeStatus(null);
	}
}

export function load({ locals }) {
	requireAdmin(locals);
	return { status: currentStatus(), pendingRestore: pendingRestoreMetadata() };
}

function validateConfirmation(form, confirmation) {
	if ([...form.keys()].some(key => !['confirmation', 'acknowledgement'].includes(key)) ||
		form.getAll('confirmation').length !== 1 || form.get('confirmation') !== confirmation ||
		form.getAll('acknowledgement').length !== 1 || form.get('acknowledgement') !== 'on') throw new Error();
}

function changeMaintenance(enabled) {
	return async ({ locals, request }) => {
		requireAdmin(locals);
		try {
			if (!Number.isSafeInteger(locals.user.id) || locals.user.id <= 0) throw new Error();
			const form = await request.formData();
			const confirmation = enabled ? 'ENABLE MAINTENANCE' : 'DISABLE MAINTENANCE';
			validateConfirmation(form, confirmation);
		} catch {
			return fail(400, {
				error:
					'Type the confirmation exactly and acknowledge the website and Telegram changes once. A valid administrator account is required.',
				status: currentStatus(),
				pendingRestore: pendingRestoreMetadata()
			});
		}
		try {
			const status = sanitizeStatus(await setSiteMaintenance({ enabled, userId: locals.user.id }));
			if (
				status.error ||
				status.enabled !== enabled ||
				status.phase !== (enabled ? 'enabled' : 'off')
			)
				return fail(503, { error: statusError, status, pendingRestore: pendingRestoreMetadata() });
			return {
				message: enabled
					? 'Maintenance enabled.'
					: 'Maintenance disabled. The website is open again.',
				status,
				pendingRestore: pendingRestoreMetadata()
			};
		} catch {
			return fail(503, { error: statusError, status: currentStatus(), pendingRestore: pendingRestoreMetadata() });
		}
	};
}

export const actions = {
	enable: changeMaintenance(true),
	disable: changeMaintenance(false),
	discardIntegrationRestore: async ({ locals, request }) => {
		requireAdmin(locals);
		try {
			if (!Number.isSafeInteger(locals.user.id) || locals.user.id <= 0) throw new Error();
			validateConfirmation(await request.formData(), 'DISCARD CREDENTIAL RESTORE');
			await withIntegrationConfigurationLock(() => {
				if (!siteMaintenanceStatus().enabled) throw new Error();
				return discardPendingIntegrationRestore({ allowApplied: true });
			});
			return {
				message: 'Pending credential restoration discarded; maintenance stays enabled. Already applied credentials were NOT rolled back. Reopen maintenance when ready, then check and repair settings or register the webhook in Admin → Integrations.',
				status: currentStatus(),
				pendingRestore: pendingRestoreMetadata()
			};
		} catch {
			return fail(400, {
				error: 'Unable to discard the pending credential restoration. Keep maintenance enabled, type DISCARD CREDENTIAL RESTORE exactly, and acknowledge that already applied credentials are retained. Check the original server encryption key and private pending file.',
				status: currentStatus(),
				pendingRestore: pendingRestoreMetadata()
			});
		}
	}
};
