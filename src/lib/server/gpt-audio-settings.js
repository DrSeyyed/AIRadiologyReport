import { DEFAULT_GPT_AUDIO_SETTINGS, normalizeGptAudioSettings } from '../gpt-audio-settings.js';

export function getGptAudioSettings(db) {
	const row = db
		.prepare("SELECT value FROM application_settings WHERE key = 'gpt_audio_settings'")
		.get();
	if (!row) return { ...DEFAULT_GPT_AUDIO_SETTINGS };
	try {
		return normalizeGptAudioSettings(JSON.parse(row.value));
	} catch {
		throw new Error(
			'Saved GPT Audio settings are invalid. Ask an administrator to save them again.'
		);
	}
}

export function setGptAudioSettings(db, value) {
	const settings = normalizeGptAudioSettings(value);
	db.prepare(
		`INSERT INTO application_settings(key, value) VALUES ('gpt_audio_settings', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`
	).run(JSON.stringify(settings));
	return settings;
}
