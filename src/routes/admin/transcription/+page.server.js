import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { DEFAULT_TRANSCRIPTION_SETTINGS, normalizeTranscriptionSettings } from '$lib/transcription-models.js';
import { getTranscriptionSettings, setTranscriptionSettings } from '$lib/server/transcription-settings.js';
import { reasoningEffortFromForm } from '$lib/reasoning-effort.js';

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
		settings = getTranscriptionSettings(db);
	} catch (caught) {
		if (caught.message !== 'Saved transcription settings are invalid. Ask an administrator to save them again.') throw caught;
		settings = { ...DEFAULT_TRANSCRIPTION_SETTINGS };
		recoveryWarning = 'Saved transcription settings are invalid. The default is shown for recovery only. Select settings and Save to repair them; nothing has been overwritten.';
	}
	return {
		settings,
		recoveryWarning,
		configured: {
			openai: Boolean(process.env.OPENAI_API_KEY),
			elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
			gemini: Boolean(process.env.GEMINI_API_KEY)
		}
	};
}

export const actions = {
	default: async ({ locals, request }) => {
		requireAdmin(locals);
		const form = await request.formData();
		let settings;
		try {
			if (form.getAll('provider').length !== 1 || form.getAll('model').length !== 1) throw new Error();
			settings = normalizeTranscriptionSettings({ provider: form.get('provider'), model: form.get('model'), reasoningEffort: reasoningEffortFromForm(form) });
		} catch {
			return fail(400, { error: 'Select a supported transcription provider, model and reasoning effort.' });
		}
		try {
			setTranscriptionSettings(getDb(), settings);
		} catch {
			return fail(500, { error: 'Unable to save transcription settings. Try again.' });
		}
		return { success: true, settings };
	}
};
