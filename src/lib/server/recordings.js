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
		e.code AS exam_type_code, e.name AS exam_type_name
		FROM study_recordings r LEFT JOIN modalities m ON m.id = r.modality_id
		LEFT JOIN exam_types e ON e.id = r.exam_type_id WHERE r.study_id = ? ORDER BY r.id`
		)
		.all(studyId);
}

export function getRecording(db, studyId, recordingId) {
	return listRecordings(db, studyId).find((recording) => recording.id === recordingId);
}

export function appendRecording(db, studyId, audioPath, { telegramVoiceJobId = null } = {}) {
	if (!db.prepare('SELECT id FROM studies WHERE id = ?').get(studyId))
		throw recordingError('Study not found', 404);
	if (telegramVoiceJobId !== null) {
		const existing = db
			.prepare('SELECT id FROM study_recordings WHERE telegram_voice_job_id = ?')
			.get(telegramVoiceJobId);
		if (existing) return getRecording(db, studyId, existing.id);
	}
	const result = db
		.prepare(
			'INSERT INTO study_recordings (study_id, audio_report_path, telegram_voice_job_id) VALUES (?, ?, ?)'
		)
		.run(studyId, audioPath, telegramVoiceJobId);
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
	const details = 'exam_details' in input ? input.exam_details : current.exam_details;
	if (typeof details !== 'string' || details.trim().length > 200)
		throw recordingError('Invalid examination details');
	output.exam_details = details.trim();
	const changed = Object.keys(output).some((field) => output[field] !== current[field]);
	if (changed)
		db.prepare(
			`UPDATE study_recordings SET modality_id = @modality_id, exam_type_id = @exam_type_id,
		exam_details = @exam_details, text_report_path = NULL, resident_checked = 0, attending_checked = 0 WHERE id = @id`
		).run({ ...output, id: recordingId });
	return getRecording(db, studyId, recordingId);
}

export function signRecording(db, studyId, recordingId, user, role, checked) {
	const recording = getRecording(db, studyId, recordingId);
	if (!recording) throw recordingError('Recording not found', 404);
	if (recording.processing) throw recordingError('Recording is being processed.', 409);
	if (!['resident', 'attending'].includes(role) || typeof checked !== 'boolean')
		throw recordingError('Invalid signature payload');
	const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(studyId);
	const admin = user.role === 'admin';
	if (!admin && (user.role !== role || user.id !== study[`corresponding_${role}_id`]))
		throw recordingError('Only the corresponding reviewer or administrator may sign.', 403);
	if (checked && !recording.text_report_path)
		throw recordingError('Generate or save a report before signing.', 409);
	if (role === 'resident' && !checked && recording.attending_checked && !admin)
		throw recordingError('Cannot unsign resident after attending has signed.', 409);
	if (role === 'attending' && checked && !recording.resident_checked && !admin)
		throw recordingError('Resident must sign first.', 409);
	if (role === 'resident' && !checked && admin)
		db.prepare(
			'UPDATE study_recordings SET resident_checked = 0, attending_checked = 0 WHERE id = ?'
		).run(recordingId);
	else
		db.prepare(`UPDATE study_recordings SET ${role}_checked = ? WHERE id = ?`).run(
			checked ? 1 : 0,
			recordingId
		);
	return getRecording(db, studyId, recordingId);
}
