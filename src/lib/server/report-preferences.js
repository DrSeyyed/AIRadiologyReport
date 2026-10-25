function invalid(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

export function reportEnglishInstruction(variant = 'british') {
	if (variant === 'british') return 'Use British radiology terminology and UK English spelling and phrasing.';
	if (variant === 'american') return 'Use American radiology terminology and US English spelling and phrasing.';
	throw invalid('Select British or American English.');
}

export function getAttendingReportPreferences(db, userId) {
	const row = db.prepare('SELECT english_variant FROM attending_report_preferences WHERE user_id=?').get(userId);
	return { english_variant: row?.english_variant ?? 'british' };
}

export function setAttendingReportPreferences(db, userId, value) {
	if (!value || typeof value !== 'object' || Array.isArray(value) ||
		Object.keys(value).length !== 1 || !Object.hasOwn(value, 'english_variant'))
		throw invalid('Provide only the report English variant.');
	if (!['british', 'american'].includes(value.english_variant))
		throw invalid('Select British or American English.');
	return db.transaction(() => {
		const user = db.prepare('SELECT role FROM users WHERE id=?').get(userId);
		if (user?.role !== 'attending') throw invalid('Only attendings can change report preferences.', 403);
		db.prepare(`INSERT INTO attending_report_preferences(user_id,english_variant) VALUES(?,?)
			ON CONFLICT(user_id) DO UPDATE SET english_variant=excluded.english_variant`).run(userId, value.english_variant);
		return getAttendingReportPreferences(db, userId);
	})();
}
