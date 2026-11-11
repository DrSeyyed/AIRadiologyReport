import { error, fail, redirect } from '@sveltejs/kit';
import { siteMaintenanceStatus, setSiteMaintenance } from '$lib/server/site-maintenance.js';

const statusError =
	'Maintenance needs attention. Check Telegram permissions and retry. The website may remain closed until the operation succeeds.';

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
	return { status: currentStatus() };
}

function changeMaintenance(enabled) {
	return async ({ locals, request }) => {
		requireAdmin(locals);
		try {
			if (!Number.isSafeInteger(locals.user.id) || locals.user.id <= 0) throw new Error();
			const form = await request.formData();
			const confirmation = enabled ? 'ENABLE MAINTENANCE' : 'DISABLE MAINTENANCE';
			if (
				[...form.keys()].some((key) => !['confirmation', 'acknowledgement'].includes(key)) ||
				form.getAll('confirmation').length !== 1 ||
				form.get('confirmation') !== confirmation ||
				form.getAll('acknowledgement').length !== 1 ||
				form.get('acknowledgement') !== 'on'
			)
				throw new Error();
		} catch {
			return fail(400, {
				error:
					'Type the confirmation exactly and acknowledge the website and Telegram changes once. A valid administrator account is required.',
				status: currentStatus()
			});
		}
		try {
			const status = sanitizeStatus(await setSiteMaintenance({ enabled, userId: locals.user.id }));
			if (
				status.error ||
				status.enabled !== enabled ||
				status.phase !== (enabled ? 'enabled' : 'off')
			)
				return fail(503, { error: statusError, status });
			return {
				message: enabled
					? 'Maintenance enabled.'
					: 'Maintenance disabled. The website is open again.',
				status
			};
		} catch {
			return fail(503, { error: statusError, status: currentStatus() });
		}
	};
}

export const actions = {
	enable: changeMaintenance(true),
	disable: changeMaintenance(false)
};
