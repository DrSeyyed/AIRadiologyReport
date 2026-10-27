import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { DEFAULT_REPORT_GENERATION_SETTINGS, REPORT_GENERATION_MODES, normalizeReportGenerationSettings } from '$lib/report-generation-models.js';
import { getReportGenerationSettings, setReportGenerationSettings } from '$lib/server/report-generation-settings.js';

function requireAdmin(locals) {
	if (!locals.user) throw redirect(302, '/login');
	if (locals.user.role !== 'admin') throw error(403, 'Forbidden');
}

export function load({ locals }) {
	requireAdmin(locals);
	const db = getDb();
	let settings;
	let recoveryWarning = null;
	try {
		settings = getReportGenerationSettings(db);
	} catch (caught) {
		if (caught.message !== 'Saved reporting settings are invalid. Ask an administrator to save them again.') throw caught;
		settings = { ...DEFAULT_REPORT_GENERATION_SETTINGS };
		recoveryWarning = 'Saved reporting settings are invalid. The default is shown for recovery only. Select a mode and Save to repair them; nothing has been overwritten.';
	}
	return {
		settings,
		recoveryWarning,
		configured: { openai: Boolean(process.env.OPENAI_API_KEY) }
	};
}

export const actions = {
	default: async (event) => {
		requireAdmin(event.locals);
		const form = await event.request.formData();
		const mode = form.get('mode');
		if (!REPORT_GENERATION_MODES.some((entry) => entry.id === mode)) {
			return fail(400, { error: 'Select a supported reporting mode.' });
		}
		const settings = normalizeReportGenerationSettings({ mode });
		try {
			setReportGenerationSettings(getDb(), settings);
		} catch {
			return fail(500, { error: 'Unable to save reporting settings. Try again.' });
		}
		return { success: true, settings };
	}
};
