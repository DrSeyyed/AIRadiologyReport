import { getStudyDetail, insertStudy } from '$lib/server/studies.js';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { sendStudyMessage } from '$lib/server/telegram.js';

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
		patient_firstname: url.searchParams.get('patient_firstname')?.trim() || '',
		patient_lastname: url.searchParams.get('patient_lastname')?.trim() || '',
		modality_id: url.searchParams.get('modality_id')?.trim() || '',
		exam_type_id: url.searchParams.get('exam_type_id')?.trim() || '',
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
	if (q.patient_firstname) {
		baseSql += ` AND s.patient_firstname LIKE ?`;
		params.push(`%${q.patient_firstname}%`);
	}
	if (q.patient_lastname) {
		baseSql += ` AND s.patient_lastname LIKE ?`;
		params.push(`%${q.patient_lastname}%`);
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

	// Date range
	if (q.date_from) {
		baseSql += ` AND s.exam_date_jalali >= ?`;
		params.push(q.date_from);
	}
	if (q.date_to) {
		baseSql += ` AND s.exam_date_jalali <= ?`;
		params.push(q.date_to);
	}

	// --- Total count query ---
	const countSql = `SELECT COUNT(*) AS total ${baseSql}`;
	const { total } = db.prepare(countSql).get(...params);

	// --- Data query ---
	const allowedColumns = [
		's.patient_code',
		's.patient_firstname',
		's.patient_lastname',
		's.modality_id',
		's.patient_age',
		's.exam_type_id',
		's.exam_date_jalali'
	];
	const legacySortColumns = {
		'p.patient_code': 's.patient_code',
		'p.firstname': 's.patient_firstname',
		'p.lastname': 's.patient_lastname'
	};
	const requestedColumn = legacySortColumns[q.orderedby] || q.orderedby;
	const orderCol = allowedColumns.includes(requestedColumn)
		? requestedColumn
		: 's.exam_date_jalali';

	let dataSql = `
    SELECT
      s.*,
      (SELECT COUNT(*) FROM study_recordings r WHERE r.study_id = s.id) AS recording_count,
      (SELECT COUNT(*) FROM study_recordings r WHERE r.study_id = s.id AND r.text_report_path IS NOT NULL) AS report_count,
      (SELECT COUNT(*) FROM study_recordings r WHERE r.study_id = s.id AND r.resident_checked = 1) AS resident_checked_count,
      (SELECT COUNT(*) FROM study_recordings r WHERE r.study_id = s.id AND r.attending_checked = 1) AS attending_checked_count,
      m.code         AS modality_code,
      e.code         AS exam_type_code,
      ur.full_name   AS resident_fullname,
      ua.full_name   AS attending_fullname
    ${baseSql}
    ORDER BY ${orderCol} ${q.orderdir}, s.exam_date_jalali DESC, s.exam_time DESC, s.id DESC
    LIMIT ? OFFSET ?
  `;
	const rows = db.prepare(dataSql).all(...params, q.rowcount, (q.page - 1) * q.rowcount);

	return json({
		total,
		page: q.page,
		rowcount: q.rowcount,
		rows
	});
}

export async function POST({ request, locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	try {
		const db = getDb();
		const input = await request.json();
		if (!input?.corresponding_attending_id)
			return json({ error: 'Select an attending for the study.' }, { status: 400 });
		const studyId = insertStudy(db, { ...input, corresponding_resident_id: null });
		const detail = getStudyDetail(db, studyId);
		let notification_warning = null;
		if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
			try {
				const result = await sendStudyMessage(detail);
				db.prepare('UPDATE studies SET telegram_message_id = ? WHERE id = ?').run(
					String(result.message_id),
					studyId
				);
				detail.telegram_message_id = String(result.message_id);
			} catch {
				notification_warning = 'Study saved, but Telegram notification failed.';
			}
		}
		return json({ ...detail, notification_warning }, { status: 201 });
	} catch (error) {
		return json({ error: error.message || 'Could not create study' }, { status: 400 });
	}
}
