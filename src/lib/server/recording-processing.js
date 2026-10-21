import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
	getRecording,
	assertRecordingMutable,
	assertRecordingReviewers,
	recordingError
} from './recordings.js';
import { getStudyDetail } from './studies.js';
import { assertStudyActive } from './study-state.js';
import { generateRecordingReport } from './recording-generation.js';
import { recordingTemplate } from './recording-templates.js';
import { getTranscriptionSettings } from './transcription-settings.js';

export function saveRecordingReport(db, recordingId, text, directory = 'uploads/reports') {
	const recording = db.prepare('SELECT study_id FROM study_recordings WHERE id = ?').get(recordingId);
	if (!recording) throw recordingError('Recording no longer exists', 404);
	assertStudyActive(db, recording.study_id);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, `recording_${recordingId}_${randomUUID()}.txt`);
	const temporary = `${path}.tmp`;
	try {
		writeFileSync(temporary, text, 'utf8');
		renameSync(temporary, path);
		const result = db
			.prepare(
				'UPDATE study_recordings SET text_report_path = ?, resident_checked = 0, attending_checked = 0, typist_checked = 0, resident_signed_by_user_id = NULL, attending_signed_by_user_id = NULL, typist_signed_by_user_id = NULL, resident_signed_at = NULL, attending_signed_at = NULL, typist_signed_at = NULL WHERE id = ?'
			)
			.run(path, recordingId);
		if (!result.changes) throw recordingError('Recording no longer exists', 404);
	} catch (error) {
		if (existsSync(temporary)) unlinkSync(temporary);
		if (existsSync(path)) unlinkSync(path);
		throw error;
	}
	return path;
}

export async function processRecording(
	db,
	studyId,
	recordingId,
	generate = generateRecordingReport,
	directory = 'uploads/reports'
) {
	const recording = getRecording(db, studyId, recordingId);
	assertRecordingMutable(recording);
	assertRecordingReviewers(db, studyId, recording);
	if (!recording.modality_id || !recording.exam_type_id)
		throw recordingError(
			'Select and save modality and examination (body part/contrast) before Transcribe & Generate.'
		);
	if (!recording.audio_parts.length || recording.audio_parts.some((part) => !existsSync(part.audio_report_path)))
		throw recordingError('Audio file not found on server', 404);
	const template = recordingTemplate(db, recording);
	let transcriptionSettings;
	if (generate === generateRecordingReport) {
		transcriptionSettings = getTranscriptionSettings(db);
		if (!process.env.OPENAI_API_KEY)
			throw recordingError('Set OPENAI_API_KEY to enable report generation (and OpenAI transcription).', 501);
		if (transcriptionSettings.provider === 'elevenlabs' && !process.env.ELEVENLABS_API_KEY)
			throw recordingError('Set ELEVENLABS_API_KEY to use ElevenLabs transcription.', 501);
	}
	const started = Math.floor(Date.now() / 1000);
	const claimed = db
		.prepare(
			'UPDATE study_recordings SET processing = 1, processing_started_at = ? WHERE id = ? AND processing = 0'
		)
		.run(started, recordingId);
	if (!claimed.changes) throw recordingError('Recording is already being processed.', 409);
	try {
		const text = await generate({ ...getStudyDetail(db, studyId), ...recording }, template, transcriptionSettings);
		if (typeof text !== 'string' || !text.trim())
			throw recordingError('Report generation returned no text.', 502);
		const path = saveRecordingReport(db, recordingId, text, directory);
		return { ok: true, path, text };
	} finally {
		db.prepare(
			'UPDATE study_recordings SET processing = 0, processing_started_at = NULL WHERE id = ? AND processing_started_at = ?'
		).run(recordingId, started);
	}
}
