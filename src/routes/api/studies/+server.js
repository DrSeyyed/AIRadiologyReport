import { getStudyDetail, insertStudy, studySignatureFilter } from '$lib/server/studies.js';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { sendStudyMessage } from '$lib/server/telegram.js';
import { patientName } from '$lib/patient-name.js';
import { attachStudyFavorites, favoriteStudyFilter } from '$lib/server/study-favorites.js';
import { examinationDateRange } from '$lib/study-date-ranges.js';
import { normalizeStudySort } from '$lib/study-sorting.js';
import { studyStatusFilter } from '$lib/server/study-status-filter.js';

const fullNameColumn = "COALESCE(NULLIF(trim(s.patient_fullname), ''), trim(s.patient_firstname || ' ' || s.patient_lastname))";

export async function GET({ url, locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const db = getDb();

	const q = {
		page: Math.min(1000000, Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1))),
		rowcount: Math.min(
			100,
			Math.max(1, Math.floor(Number(url.searchParams.get('rowcount')) || 20))
		),
		orderedby: url.searchParams.get('orderedby')?.trim() || '',
		orderdir: url.searchParams.get('orderdir')?.trim().toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
		patient_code: url.searchParams.get('patient_code')?.trim() || '',
		patient_fullname: url.searchParams.get('patient_fullname')?.trim() || '',
		patient_firstname: url.searchParams.get('patient_firstname')?.trim() || '',
		patient_lastname: url.searchParams.get('patient_lastname')?.trim() || '',
		modality_id: url.searchParams.get('modality_id')?.trim() || '',
		exam_type_id: url.searchParams.get('exam_type_id')?.trim() || '',
		corresponding_resident_id: url.searchParams.get('corresponding_resident_id')?.trim() || '',
		corresponding_attending_id: url.searchParams.get('corresponding_attending_id')?.trim() || '',
		date_from: url.searchParams.get('date_from')?.trim() || '',
		date_to: url.searchParams.get('date_to')?.trim() || ''
	};

	let baseSql = `
    FROM studies s
    LEFT JOIN modalities m ON m.id = s.modality_id
    LEFT JOIN exam_types e ON e.id = s.exam_type_id
    LEFT JOIN users ur ON ur.id = s.corresponding_resident_id
    LEFT JOIN users ua ON ua.id = s.corresponding_attending_id
    WHERE 1=1
  `;

	const params = [];

	// Patient filters
	if (q.patient_code) {
		baseSql += ` AND s.patient_code = ?`;
		params.push(q.patient_code);
	}
	for (const name of [q.patient_fullname, q.patient_firstname, q.patient_lastname]) {
		if (!name) continue;
		baseSql += ` AND ${fullNameColumn} LIKE ?`;
		params.push(`%${name}%`);
	}

	// Modality filter
	if (q.modality_id) {
		baseSql += ` AND (s.modality_id = ? OR EXISTS (SELECT 1 FROM study_recordings r WHERE r.study_id = s.id AND r.modality_id = ?))`;
		params.push(Number(q.modality_id), Number(q.modality_id));
	}

	// Exam type filter
	if (q.exam_type_id) {
		baseSql += ` AND EXISTS (SELECT 1 FROM study_recordings r WHERE r.study_id = s.id AND r.exam_type_id = ?)`;
		params.push(Number(q.exam_type_id));
	}

	// Presets are resolved for every request so saved links remain relative to today.
	try {
		const range = examinationDateRange(url.searchParams.get('date_range')?.trim() || '');
		if (range) Object.assign(q, range);
	} catch (error) {
		return json({ error: error.message }, { status: 400 });
	}
	if (q.date_from) {
		baseSql += ` AND s.exam_date_jalali >= ?`;
		params.push(q.date_from);
	}
	if (q.date_to) {
		baseSql += ` AND s.exam_date_jalali <= ?`;
		params.push(q.date_to);
	}

	try {
		baseSql += studyStatusFilter(url.searchParams.get('status')?.trim() || '');
		const favorites = favoriteStudyFilter(db, locals.user.id, url.searchParams.get('favorites')?.trim() || '');
		baseSql += favorites.sql;
		params.push(...favorites.params);
		const filters = Object.fromEntries(['resident', 'attending', 'typist'].map((role) => [
			`${role}_checked`, url.searchParams.get(`${role}_checked`)?.trim() || ''
		]));
		if (q.corresponding_attending_id) {
			if (!/^[1-9]\d*$/.test(q.corresponding_attending_id) || !Number.isSafeInteger(Number(q.corresponding_attending_id)))
				throw new Error('Invalid attending filter');
			baseSql += ' AND s.corresponding_attending_id = ?';
			params.push(Number(q.corresponding_attending_id));
		}
		const signatureFilter = studySignatureFilter({ ...filters, corresponding_resident_id: q.corresponding_resident_id });
		baseSql += signatureFilter.sql;
		params.push(...signatureFilter.params);
	} catch (error) {
		return json({ error: error.message }, { status: error.status || 400 });
	}

	// --- Total count query ---
	const countSql = `SELECT COUNT(*) AS total ${baseSql}`;
	const { total } = db.prepare(countSql).get(...params);

	// --- Data query ---
	const sortColumns = {
		's.patient_code': 's.patient_code COLLATE NOCASE',
		's.patient_fullname': `${fullNameColumn} COLLATE NOCASE`,
		's.modality_id': 's.modality_id',
		's.exam_type_id': 's.exam_type_id',
		's.patient_age': "s.patient_age * CASE s.patient_age_unit WHEN 'Y' THEN 365.25 WHEN 'M' THEN 30.4375 WHEN 'W' THEN 7 ELSE 1 END",
		's.exam_date_jalali': 's.exam_date_jalali',
		source_modality: "COALESCE(NULLIF(s.source_modality, ''), m.code, '') COLLATE NOCASE",
		source_description: "COALESCE(NULLIF(s.source_description, ''), NULLIF(s.description, ''), '') COLLATE NOCASE",
		attending_fullname: "COALESCE(ua.full_name, '') COLLATE NOCASE",
		residents: `COALESCE((SELECT group_concat(full_name, ', ') FROM (
			SELECT DISTINCT u.id, u.full_name FROM study_recordings r JOIN users u ON u.id = r.corresponding_resident_id
			WHERE r.study_id = s.id ORDER BY u.full_name COLLATE NOCASE, u.id)), '') COLLATE NOCASE`,
		recording_count: 'recording_count',
		report_count: 'report_count',
		resident_checked_count: 'resident_checked_count',
		attending_checked_count: 'attending_checked_count',
		typist_checked_count: 'typist_checked_count',
		is_favorite: 'EXISTS (SELECT 1 FROM study_favorites f WHERE f.study_id = s.id AND f.user_id = ?)'
	};
	const sortKey = normalizeStudySort(q.orderedby);
	const orderCol = sortColumns[sortKey];
	const timeOrder = sortKey === 's.exam_date_jalali' ? q.orderdir : 'DESC';
	const sortParams = sortKey === 'is_favorite' ? [locals.user.id] : [];

	let dataSql = `
    SELECT
      s.*,
      (SELECT COUNT(*) FROM study_recordings r WHERE r.study_id = s.id) AS recording_count,
      (SELECT COUNT(*) FROM study_recordings r WHERE r.study_id = s.id AND r.text_report_path IS NOT NULL) AS report_count,
      (SELECT COUNT(*) FROM study_recordings r WHERE r.study_id = s.id AND r.resident_checked = 1) AS resident_checked_count,
      (SELECT COUNT(*) FROM study_recordings r WHERE r.study_id = s.id AND r.attending_checked = 1) AS attending_checked_count,
      (SELECT COUNT(*) FROM study_recordings r WHERE r.study_id = s.id AND r.typist_checked = 1) AS typist_checked_count,
      m.code         AS modality_code,
      e.code         AS exam_type_code,
      ur.full_name   AS resident_fullname,
      ua.full_name   AS attending_fullname
    ${baseSql}
    ORDER BY ${orderCol} ${q.orderdir}, s.exam_date_jalali DESC, s.exam_time ${timeOrder}, s.id DESC
    LIMIT ? OFFSET ?
  `;
	const rows = db.prepare(dataSql).all(...params, ...sortParams, q.rowcount, (q.page - 1) * q.rowcount);
	const residentsByStudy = new Map();
	if (rows.length) {
		const residents = db.prepare(`
			SELECT DISTINCT r.study_id, u.id, u.full_name
			FROM study_recordings r JOIN users u ON u.id = r.corresponding_resident_id
			WHERE r.study_id IN (${rows.map(() => '?').join(',')})
			ORDER BY u.full_name COLLATE NOCASE, u.id
		`).all(...rows.map((row) => row.id));
		for (const { study_id, id, full_name } of residents) {
			if (!residentsByStudy.has(study_id)) residentsByStudy.set(study_id, []);
			residentsByStudy.get(study_id).push({ id, full_name });
		}
	}
	attachStudyFavorites(db, locals.user.id, rows);
	for (const row of rows) {
		row.patient_fullname = patientName(row);
		row.residents = residentsByStudy.get(row.id) ?? [];
	}

	return json({
		total,
		page: q.page,
		rowcount: q.rowcount,
		date_bounds: { date_from: q.date_from, date_to: q.date_to },
		rows
	});
}

export async function POST({ request, locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.user.role === 'typist') return json({ error: 'Forbidden' }, { status: 403 });
	try {
		const db = getDb();
		const input = await request.json();
		if (!input?.corresponding_attending_id)
			return json({ error: 'Select an attending for the study.' }, { status: 400 });
		const studyId = insertStudy(db, { ...input, corresponding_resident_id: null });
		const detail = getStudyDetail(db, studyId);
		let notification_warning = null;
		if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
			db.prepare('UPDATE studies SET telegram_send_started_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), studyId);
			try {
				const result = await sendStudyMessage(detail);
				db.prepare('UPDATE studies SET telegram_message_id = ? WHERE id = ?').run(
					String(result.message_id),
					studyId
				);
				detail.telegram_message_id = String(result.message_id);
			} catch {
				notification_warning = 'Study saved, but Telegram notification failed.';
			} finally {
				db.prepare('UPDATE studies SET telegram_send_started_at = NULL WHERE id = ?').run(studyId);
			}
		}
		return json({ ...detail, notification_warning }, { status: 201 });
	} catch (error) {
		return json({ error: error.message || 'Could not create study' }, { status: 400 });
	}
}
