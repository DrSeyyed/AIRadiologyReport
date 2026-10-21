import { DEFAULT_TRANSCRIPTION_SETTINGS, normalizeTranscriptionSettings } from '../transcription-models.js';

export function getTranscriptionSettings(db) {
	const row = db.prepare("SELECT value FROM application_settings WHERE key = 'transcription_settings'").get();
	if (!row) return { ...DEFAULT_TRANSCRIPTION_SETTINGS };
	try {
		return normalizeTranscriptionSettings(JSON.parse(row.value));
	} catch {
		throw new Error('Saved transcription settings are invalid. Ask an administrator to save them again.');
	}
}

export function setTranscriptionSettings(db, value) {
	const settings = normalizeTranscriptionSettings(value);
	db.prepare(`INSERT INTO application_settings(key, value) VALUES ('transcription_settings', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(settings));
	return settings;
}
