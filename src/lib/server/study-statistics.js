import jalaali from 'jalaali-js';
import { examinationDateRange } from '../study-date-ranges.js';
import { statisticsPresets } from '../study-statistics-options.js';

function failure(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

export function statisticsDateRange(params = new URLSearchParams(), now = new Date()) {
	for (const key of ['date_range', 'date_from', 'date_to']) {
		if (params.getAll(key).length > 1) throw failure('Select each date filter only once.');
	}
	const preset = params.get('date_range') || '7-days';
	const selected = statisticsPresets.find(({ value }) => value === preset);
	if (!selected) throw failure('Select a valid statistics date range.');
	let bounds;
	if (preset === 'custom') {
		bounds = { date_from: params.get('date_from'), date_to: params.get('date_to') };
		for (const date of Object.values(bounds)) {
			const parts = typeof date === 'string' && date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
			if (!parts || !jalaali.isValidJalaaliDate(Number(parts[1]), Number(parts[2]), Number(parts[3]))) {
				throw failure('Enter valid Jalali dates in YYYY-MM-DD format.');
			}
		}
		if (bounds.date_from > bounds.date_to) throw failure('The start date must not be after the end date.');
	} else {
		bounds = examinationDateRange(preset, now);
	}
	return { preset, ...bounds, label: selected.label, timeZone: 'Asia/Tehran' };
}

export function getStudyStatistics(db, user, params = new URLSearchParams(), { now = new Date() } = {}) {
	if (!user) throw failure('Sign in to view statistics.', 401);
	if (!['admin', 'resident', 'attending', 'typist'].includes(user.role) || !Number.isSafeInteger(user.id) || user.id <= 0) {
		throw failure('Forbidden', 403);
	}
	const range = statisticsDateRange(params, now);
	let scope = 'all';
	let condition = '';
	const values = [range.date_from, range.date_to];
	if (user.role === 'resident') {
		scope = 'assigned';
		condition = ` AND (s.corresponding_resident_id = ? OR EXISTS (
			SELECT 1 FROM study_recordings assigned WHERE assigned.study_id = s.id AND assigned.corresponding_resident_id = ?))`;
		values.push(user.id, user.id);
	} else if (user.role === 'attending') {
		scope = 'assigned';
		condition = ' AND s.corresponding_attending_id = ?';
		values.push(user.id);
	} else if (user.role === 'typist') {
		scope = 'signed';
		condition = ` AND EXISTS (SELECT 1 FROM study_recordings signed WHERE signed.study_id = s.id
			AND signed.typist_checked = 1 AND signed.typist_signed_by_user_id = ?)`;
		values.push(user.id);
	}
	const totals = db.prepare(`
		WITH scoped AS (
			SELECT s.id, COALESCE(s.disabled, 0) AS disabled, COALESCE(s.needs_attention, 0) AS needs_attention
			FROM studies s WHERE s.exam_date_jalali >= ? AND s.exam_date_jalali <= ?${condition}
		), recordings AS (
			SELECT s.id, s.disabled, s.needs_attention, COUNT(r.id) AS recording_count,
				SUM(CASE WHEN TRIM(COALESCE(r.text_report_path, ''), char(9) || char(10) || char(11) || char(12) || char(13) || ' ') != '' THEN 1 ELSE 0 END) AS reported_count,
				SUM(CASE WHEN r.resident_checked = 1 THEN 1 ELSE 0 END) AS resident_count,
				SUM(CASE WHEN r.attending_checked = 1 THEN 1 ELSE 0 END) AS attending_count,
				SUM(CASE WHEN r.typist_checked = 1 THEN 1 ELSE 0 END) AS typist_count,
				SUM(CASE WHEN r.resident_checked = 1 AND r.attending_checked = 1 AND r.typist_checked = 1 THEN 1 ELSE 0 END) AS signed_count
			FROM scoped s LEFT JOIN study_recordings r ON r.study_id = s.id GROUP BY s.id
		)
		SELECT COUNT(*) AS total,
			COALESCE(SUM(disabled = 0), 0) AS active,
			COALESCE(SUM(disabled = 1), 0) AS disabled,
			COALESCE(SUM(disabled = 0 AND needs_attention = 1), 0) AS needsAttention,
			COALESCE(SUM(disabled = 0 AND recording_count = 0), 0) AS noRecording,
			COALESCE(SUM(disabled = 0 AND recording_count > 0 AND reported_count = recording_count), 0) AS reported,
			COALESCE(SUM(disabled = 0 AND (recording_count = 0 OR reported_count < recording_count)), 0) AS unreported,
			COALESCE(SUM(disabled = 0 AND recording_count > 0 AND signed_count = recording_count), 0) AS fullySigned,
			COALESCE(SUM(disabled = 0 AND recording_count > 0 AND signed_count < recording_count), 0) AS awaitingSignatures,
			COALESCE(SUM(disabled = 0 AND recording_count > 0 AND resident_count = recording_count), 0) AS residentSigned,
			COALESCE(SUM(disabled = 0 AND recording_count > 0 AND attending_count = recording_count), 0) AS attendingSigned,
			COALESCE(SUM(disabled = 0 AND recording_count > 0 AND typist_count = recording_count), 0) AS typistSigned
		FROM recordings
	`).get(...values);
	return { scope, range, totals };
}
