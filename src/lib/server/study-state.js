export function assertStudyActive(db, studyId) {
	const study = db.prepare('SELECT disabled FROM studies WHERE id = ?').get(studyId);
	if (!study) throw Object.assign(new Error('Study not found'), { status: 404 });
	if (study.disabled)
		throw Object.assign(new Error('This study is disabled. Audio replies and changes are not accepted.'), { status: 409 });
}

export function telegramVoiceCount(db, studyId) {
	return db.prepare(`SELECT count(*) AS count FROM (
		SELECT chat_id, reply_message_id FROM pending_voice WHERE study_id = ?
		UNION SELECT chat_id, message_id FROM study_telegram_voices WHERE study_id = ?
	) v WHERE NOT EXISTS (SELECT 1 FROM study_telegram_voices d
		WHERE d.chat_id = v.chat_id AND d.message_id = v.reply_message_id AND d.deleted = 1)`)
		.get(studyId, studyId).count;
}
