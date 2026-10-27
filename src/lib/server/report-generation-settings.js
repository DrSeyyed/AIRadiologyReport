import {
	DEFAULT_REPORT_GENERATION_SETTINGS,
	normalizeReportGenerationSettings
} from '../report-generation-models.js';

export function getReportGenerationSettings(db) {
	const row = db
		.prepare("SELECT value FROM application_settings WHERE key='report_generation_settings'")
		.get();
	if (!row) return { ...DEFAULT_REPORT_GENERATION_SETTINGS };
	try {
		return normalizeReportGenerationSettings(JSON.parse(row.value));
	} catch {
		throw new Error(
			'Saved reporting settings are invalid. Ask an administrator to save them again.'
		);
	}
}

export function setReportGenerationSettings(db, value) {
	const settings = normalizeReportGenerationSettings(value);
	db.prepare(
		`INSERT INTO application_settings(key,value) VALUES('report_generation_settings',?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`
	).run(JSON.stringify(settings));
	return settings;
}
