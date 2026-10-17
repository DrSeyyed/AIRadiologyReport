import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getPacsViewerUrl, setPacsViewerUrl } from '$lib/server/pacs-settings.js';

function requireAdmin(locals) {
	if (!locals.user) throw redirect(302, '/login');
	if (locals.user.role !== 'admin') throw error(403, 'Forbidden');
}

export function load({ locals }) {
	requireAdmin(locals);
	return { viewerUrl: getPacsViewerUrl(getDb()) };
}

export const actions = {
	default: async ({ locals, request }) => {
		requireAdmin(locals);
		const form = await request.formData();
		const value = form.get('viewerUrl');
		try {
			const viewerUrl = setPacsViewerUrl(getDb(), value);
			return { success: true, viewerUrl };
		} catch (caught) {
			return fail(400, { error: caught.message, viewerUrl: typeof value === 'string' ? value : '' });
		}
	}
};
