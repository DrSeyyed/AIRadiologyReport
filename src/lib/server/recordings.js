export function recordingError(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

function clearExpiredProcessing(db) {
	db.prepare(
		'UPDATE study_recordings SET processing = 0 WHERE processing = 1 AND processing_started_at < ?'
	).run(Math.floor(Date.now() / 1000) - 600);
}

export function listRecordings(db, studyId) {
	clearExpiredProcessing(db);
	return db
		.prepare(
			`SELECT r.*, m.code AS modality_code, m.name AS modality_name,
		e.code AS exam_type_code, e.name AS exam_type_name,
		resident.full_name AS resident_fullname, sender.full_name AS sender_fullname,
		resident_signer.full_name AS resident_signer_fullname, attending_signer.full_name AS attending_signer_fullname,
		(r.source = 'telegram' AND r.sender_role = 'resident' AND sender.id IS NOT NULL) AS resident_assignment_locked
		FROM study_recordings r LEFT JOIN modalities m ON m.id = r.modality_id
		LEFT JOIN exam_types e ON e.id = r.exam_type_id
		LEFT JOIN users resident ON resident.id = r.corresponding_resident_id
		LEFT JOIN users sender ON sender.id = r.sender_user_id
		LEFT JOIN users resident_signer ON resident_signer.id = r.resident_signed_by_user_id
		LEFT JOIN users attending_signer ON attending_signer.id = r.attending_signed_by_user_id
		WHERE r.study_id = ? ORDER BY r.id`
		)
		.all(studyId);
}

export function getRecording(db, studyId, recordingId) {
	return listRecordings(db, studyId).find((recording) => recording.id === recordingId);
}

export function appendRecording(
	db,
	studyId,
	audioPath,
	{ telegramVoiceJobId = null, senderUserId = null, source = 'browser' } = {}
) {
	if (!db.prepare('SELECT id FROM studies WHERE id = ?').get(studyId))
		throw recordingError('Study not found', 404);
	if (telegramVoiceJobId !== null) {
		const existing = db
			.prepare('SELECT id FROM study_recordings WHERE telegram_voice_job_id = ?')
			.get(telegramVoiceJobId);
		if (existing) return getRecording(db, studyId, existing.id);
	}
	if (!['browser', 'telegram', 'legacy'].includes(source))
		throw recordingError('Invalid recording source');
	const sender =
		senderUserId === null
			? null
			: db.prepare('SELECT id, role FROM users WHERE id = ?').get(senderUserId);
	if (
		(senderUserId !== null && !sender) ||
		(source === 'telegram' && !['resident', 'attending'].includes(sender?.role))
	)
		throw recordingError('Recording sender is no longer available.', 409);
	const result = db
		.prepare(
			'INSERT INTO study_recordings (study_id, audio_report_path, telegram_voice_job_id, sender_user_id, sender_role, source, corresponding_resident_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
		)
		.run(
			studyId,
			audioPath,
			telegramVoiceJobId,
			sender?.id ?? null,
			sender?.role ?? null,
			source,
			sender?.role === 'resident' ? sender.id : null
		);
	return getRecording(db, studyId, Number(result.lastInsertRowid));
}

export function assertRecordingMutable(recording) {
	if (!recording) throw recordingError('Recording not found', 404);
	if (recording.processing)
		throw recordingError('Recording is being processed. Try again later.', 409);
	if (recording.resident_checked || recording.attending_checked)
		throw recordingError('Unsign this report before changing it.', 409);
}

export function configureRecording(db, studyId, recordingId, input) {
	const current = getRecording(db, studyId, recordingId);
	assertRecordingMutable(current);
	const output = {};
	for (const [field, table] of [
		['modality_id', 'modalities'],
		['exam_type_id', 'exam_types']
	]) {
		const value = field in input ? input[field] : current[field];
		output[field] = value == null || value === '' ? null : Number(value);
		if (
			output[field] !== null &&
			(!Number.isSafeInteger(output[field]) ||
				!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(output[field]))
		)
			throw recordingError(`Select a valid ${field.replace('_id', '')}`);
	}
	const resident =
		'corresponding_resident_id' in input
			? input.corresponding_resident_id
			: current.corresponding_resident_id;
	output.corresponding_resident_id = resident == null || resident === '' ? null : Number(resident);
	if (
		current.resident_assignment_locked &&
		output.corresponding_resident_id !== current.sender_user_id
	)
		throw recordingError('Telegram resident recordings must remain assigned to their sender.', 403);
	if (
		output.corresponding_resident_id !== null &&
		(!Number.isSafeInteger(output.corresponding_resident_id) ||
			!db
				.prepare("SELECT id FROM users WHERE id = ? AND role = 'resident'")
				.get(output.corresponding_resident_id))
	)
		throw recordingError('Select a valid resident');
	const details = 'exam_details' in input ? input.exam_details : current.exam_details;
	if (typeof details !== 'string' || details.trim().length > 200)
		throw recordingError('Invalid examination details');
	output.exam_details = details.trim();
	const changed = Object.keys(output).some((field) => output[field] !== current[field]);
	if (changed)
		db.prepare(
			`UPDATE study_recordings SET modality_id = @modality_id, exam_type_id = @exam_type_id,
		exam_details = @exam_details, corresponding_resident_id = @corresponding_resident_id,
		text_report_path = NULL, resident_checked = 0, attending_checked = 0,
		resident_signed_by_user_id = NULL, attending_signed_by_user_id = NULL,
		resident_signed_at = NULL, attending_signed_at = NULL WHERE id = @id`
		).run({ ...output, id: recordingId });
	return getRecording(db, studyId, recordingId);
}

export function assertRecordingReviewers(db, studyId, recording) {
	if (
		!recording.corresponding_resident_id ||
		!db
			.prepare("SELECT id FROM users WHERE id = ? AND role = 'resident'")
			.get(recording.corresponding_resident_id)
	)
		throw recordingError(
			'Select and save a resident for this recording before generating or saving a report.'
		);
	const study = db
		.prepare('SELECT corresponding_attending_id FROM studies WHERE id = ?')
		.get(studyId);
	if (
		!study?.corresponding_attending_id ||
		!db
			.prepare("SELECT id FROM users WHERE id = ? AND role = 'attending'")
			.get(study.corresponding_attending_id)
	)
		throw recordingError('Select and save the corresponding attending for this study.');
}

export function signRecording(db, studyId, recordingId, user, role, checked) {
	const recording = getRecording(db, studyId, recordingId);
	if (!recording) throw recordingError('Recording not found', 404);
	if (recording.processing) throw recordingError('Recording is being processed.', 409);
	if (!['resident', 'attending'].includes(role) || typeof checked !== 'boolean')
		throw recordingError('Invalid signature payload');
	const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(studyId);
	const admin = user.role === 'admin';
	const attending = user.role === 'attending' && user.id === study.corresponding_attending_id;
	const resident = user.role === 'resident' && user.id === recording.corresponding_resident_id;
	if (!admin && !attending && !(role === 'resident' && resident))
		throw recordingError(
			'Only the assigned resident, corresponding study attending or administrator may sign.',
			403
		);
	if (checked) assertRecordingReviewers(db, studyId, recording);
	if (checked && !recording.text_report_path)
		throw recordingError('Generate or save a report before signing.', 409);
	if (role === 'resident' && !checked && recording.attending_checked && !admin)
		throw recordingError('Cannot unsign resident after attending has signed.', 409);
	if (role === 'attending' && checked && !recording.resident_checked)
		throw recordingError('Resident must sign first.', 409);
	if (checked && recording[`${role}_checked`]) return recording;
	if (role === 'resident' && !checked && admin)
		db.prepare(
			'UPDATE study_recordings SET resident_checked = 0, attending_checked = 0, resident_signed_by_user_id = NULL, attending_signed_by_user_id = NULL, resident_signed_at = NULL, attending_signed_at = NULL WHERE id = ?'
		).run(recordingId);
	else
		db.prepare(
			`UPDATE study_recordings SET ${role}_checked = ?, ${role}_signed_by_user_id = ?, ${role}_signed_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END WHERE id = ?`
		).run(checked ? 1 : 0, checked ? user.id : null, checked ? 1 : 0, recordingId);
	return getRecording(db, studyId, recordingId);
}
