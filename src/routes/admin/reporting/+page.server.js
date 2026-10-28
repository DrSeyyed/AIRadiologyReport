import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { DEFAULT_REPORT_GENERATION_SETTINGS, REPORT_GENERATION_MODES, normalizeReportGenerationSettings } from '$lib/report-generation-models.js';
import { getReportGenerationSettings, setReportGenerationSettings } from '$lib/server/report-generation-settings.js';
import { DEFAULT_GPT_AUDIO_SETTINGS, normalizeGptAudioSettings } from '$lib/gpt-audio-settings.js';
import { getGptAudioSettings, setGptAudioSettings } from '$lib/server/gpt-audio-settings.js';

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
	let gptAudioSettings;
	let gptAudioRecoveryWarning = null;
	try {
		gptAudioSettings = getGptAudioSettings(db);
	} catch (caught) {
		if (caught.message !== 'Saved GPT Audio settings are invalid. Ask an administrator to save them again.') throw caught;
		gptAudioSettings = { ...DEFAULT_GPT_AUDIO_SETTINGS };
		gptAudioRecoveryWarning = 'Saved GPT Audio settings are invalid. Defaults are shown for recovery only. Save GPT Audio settings to repair them; nothing has been overwritten.';
	}
	return {
		settings,
		recoveryWarning,
		gptAudioSettings,
		gptAudioRecoveryWarning,
		configured: { openai: Boolean(process.env.OPENAI_API_KEY), elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY) }
	};
}

export const actions = {
	default: async (event) => {
		requireAdmin(event.locals);
		const form = await event.request.formData();
		if (form.get('section') === 'gpt_audio') {
			let gptAudioSettings;
			try {
				const limit = form.get('limitSeconds');
				const substitute = form.get('substitute');
				if (form.getAll('limitSeconds').length !== 1 || form.getAll('substitute').length !== 1 ||
					typeof limit !== 'string' || !/^\d+$/.test(limit) || typeof substitute !== 'string') throw new Error();
				const pair = substitute.split(':');
				if (substitute !== '' && pair.length !== 2) throw new Error();
				gptAudioSettings = normalizeGptAudioSettings({
					limitSeconds: Number(limit),
					substitute: substitute === '' ? null : { provider: pair[0], model: pair[1] }
				});
			} catch {
				return fail(400, { section: 'gpt_audio', error: 'Select a valid GPT Audio duration limit and dedicated transcription substitute.' });
			}
			try {
				setGptAudioSettings(getDb(), gptAudioSettings);
			} catch {
				return fail(500, { section: 'gpt_audio', error: 'Unable to save GPT Audio settings. Try again.' });
			}
			return { section: 'gpt_audio', success: true, gptAudioSettings };
		}
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
