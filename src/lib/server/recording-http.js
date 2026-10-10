import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getStudyDetail } from './studies.js';
import {
	appendRecording,
	getRecording,
	listRecordings,
	configureRecording,
	signRecording,
	assertRecordingMutable,
	assertRecordingReviewers,
	recordingError
} from './recordings.js';
import { processRecording, saveRecordingReport } from './recording-processing.js';
import { syncStudyMessage, buildFinalReportMessage } from './telegram.js';
import { sendTelegramMessage } from './notify.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

function handler(action, requireRecording = true) {
	return async (event) => {
		if (!event.locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
		try {
			const studyId = Number(event.params.id),
				recordingId = Number(event.params.recordingId);
			if (
				!Number.isSafeInteger(studyId) ||
				studyId <= 0 ||
				(requireRecording && (!Number.isSafeInteger(recordingId) || recordingId <= 0))
			)
				throw recordingError('Invalid study or recording ID');
			const db = getDb();
			const study = getStudyDetail(db, studyId);
			if (!study) throw recordingError('Study not found', 404);
			const recording = requireRecording ? getRecording(db, studyId, recordingId) : null;
			if (requireRecording && !recording) throw recordingError('Recording not found', 404);
			return await action({ ...event, db, studyId, recordingId, study, recording });
		} catch (error) {
			return json(
				{ error: error.message || 'Recording operation failed' },
				{ status: error.status || 500 }
			);
		}
	};
}

export const list = handler(
	({ db, studyId }) => json({ recordings: listRecordings(db, studyId) }),
	false
);

export const upload = handler(async ({ db, studyId, request, locals }) => {
	const form = await request.formData();
	const file = form.get('file');
	if (!(file instanceof File) || !file.size) throw recordingError('Select a nonempty audio file.');
	if (file.size > 50 * 1024 * 1024) throw recordingError('Audio exceeds 50 MB.', 413);
	const extension = extname(file.name).toLowerCase();
	if (
		![
			'.mp3',
			'.mp4',
			'.m4a',
			'.wav',
			'.ogg',
			'.oga',
			'.webm',
			'.mpeg',
			'.opus',
			'.flac',
			'.aac'
		].includes(extension)
	)
		throw recordingError('Unsupported audio file extension.');
	mkdirSync('uploads/audio', { recursive: true });
	const path = join('uploads/audio', `study_${studyId}_${randomUUID()}${extension}`);
	writeFileSync(path, Buffer.from(await file.arrayBuffer()));
	let recording;
	try {
		recording = appendRecording(db, studyId, path, {
			senderUserId: locals.user.id,
			source: 'browser'
		});
	} catch (error) {
		unlinkSync(path);
		throw error;
	}
	await syncStudyMessage(getStudyDetail(db, studyId));
	return json({ ok: true, recording }, { status: 201 });
}, false);

export const configure = handler(async ({ db, studyId, recordingId, request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object' || Array.isArray(body))
		throw recordingError('Invalid recording configuration');
	const recording = configureRecording(db, studyId, recordingId, body);
	await syncStudyMessage(getStudyDetail(db, studyId));
	return json({ ok: true, recording });
});

export const remove = handler(async ({ db, studyId, recordingId, recording }) => {
	assertRecordingMutable(recording);
	db.prepare('DELETE FROM study_recordings WHERE id = ?').run(recordingId);
	await syncStudyMessage(getStudyDetail(db, studyId));
	return json({ ok: true });
});

export const audio = handler(({ recording, request }) => {
	if (!recording.audio_report_path || !existsSync(recording.audio_report_path))
		throw recordingError('Audio file not found', 404);
	const buffer = readFileSync(recording.audio_report_path);
	const extension = extname(recording.audio_report_path).toLowerCase();
	const type =
		{
			'.ogg': 'audio/ogg',
			'.oga': 'audio/ogg',
			'.opus': 'audio/ogg',
			'.webm': 'audio/webm',
			'.mp3': 'audio/mpeg',
			'.mpeg': 'audio/mpeg',
			'.wav': 'audio/wav',
			'.m4a': 'audio/mp4',
			'.mp4': 'audio/mp4',
			'.flac': 'audio/flac',
			'.aac': 'audio/aac'
		}[extension] || 'application/octet-stream';
	const headers = {
		'Content-Type': type,
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'private, no-store'
	};
	const range = request.headers.get('range');
	if (range) {
		const match = range.match(/^bytes=(\d*)-(\d*)$/);
		let start = match?.[1]
			? Number(match[1])
			: match?.[2]
				? Math.max(0, buffer.length - Number(match[2]))
				: NaN;
		let end =
			match?.[1] && match?.[2] ? Math.min(buffer.length - 1, Number(match[2])) : buffer.length - 1;
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start < 0 ||
			start > end ||
			start >= buffer.length
		)
			return new Response(null, {
				status: 416,
				headers: { ...headers, 'Content-Range': `bytes */${buffer.length}` }
			});
		return new Response(buffer.subarray(start, end + 1), {
			status: 206,
			headers: {
				...headers,
				'Content-Range': `bytes ${start}-${end}/${buffer.length}`,
				'Content-Length': String(end - start + 1)
			}
		});
	}
	return new Response(buffer, { headers: { ...headers, 'Content-Length': String(buffer.length) } });
});

export const generate = handler(async ({ db, studyId, recordingId }) => {
	const result = await processRecording(db, studyId, recordingId);
	await syncStudyMessage(getStudyDetail(db, studyId));
	return json(result);
});

export const readReport = handler(({ recording }) => {
	if (recording.text_report_path && !existsSync(recording.text_report_path))
		throw recordingError('Report file not found', 404);
	return json({
		text: recording.text_report_path ? readFileSync(recording.text_report_path, 'utf8') : ''
	});
});

export const writeReport = handler(async ({ db, studyId, recordingId, recording, request }) => {
	assertRecordingMutable(recording);
	assertRecordingReviewers(db, studyId, recording);
	if (!recording.modality_id || !recording.exam_type_id)
		throw recordingError('Save examination details before saving a report.');
	const body = await request.json().catch(() => null);
	if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 200000)
		throw recordingError('Enter a nonempty report (up to 200,000 characters).');
	const path = saveRecordingReport(db, recordingId, body.text);
	await syncStudyMessage(getStudyDetail(db, studyId));
	return json({ ok: true, path });
});

export const sign = handler(async ({ db, studyId, recordingId, recording, locals, request }) => {
	const body = await request.json().catch(() => null);
	if (!body) throw recordingError('Invalid signature payload');
	if (body.checked && (!recording.text_report_path || !existsSync(recording.text_report_path)))
		throw recordingError('Report file not found', 404);
	const updated = signRecording(db, studyId, recordingId, locals.user, body.role, body.checked);
	const study = getStudyDetail(db, studyId);
	if (body.role === 'attending' && body.checked && !recording.attending_checked) {
		await sendTelegramMessage(
			buildFinalReportMessage(study, updated, readFileSync(updated.text_report_path, 'utf8'))
		);
	}
	await syncStudyMessage(study);
	return json({
		ok: true,
		resident_checked: updated.resident_checked,
		attending_checked: updated.attending_checked,
		recording: updated
	});
});
