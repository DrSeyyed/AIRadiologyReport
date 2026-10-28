import { DEFAULT_REPORT_TYPOGRAPHY, normalizeReportTypography } from '../report-copy.js';

export function getUserReportTypography(db, userId) {
	const row = db
		.prepare('SELECT font, font_size AS size FROM user_report_typography WHERE user_id=?')
		.get(userId);
	return row ?? { ...DEFAULT_REPORT_TYPOGRAPHY };
}

export function setUserReportTypography(db, userId, value) {
	let typography;
	try {
		typography = normalizeReportTypography(value);
	} catch {
		throw Object.assign(
			new Error('Provide only a supported report font and numeric size from 6 to 72.'),
			{
				status: 400
			}
		);
	}
	return db.transaction(() => {
		if (!db.prepare('SELECT id FROM users WHERE id=?').get(userId)) {
			throw Object.assign(new Error('Unauthorized'), { status: 401 });
		}
		db.prepare(
			`INSERT INTO user_report_typography(user_id,font,font_size) VALUES(?,?,?)
			ON CONFLICT(user_id) DO UPDATE SET font=excluded.font,font_size=excluded.font_size`
		).run(userId, typography.font, typography.size);
		return getUserReportTypography(db, userId);
	})();
}
