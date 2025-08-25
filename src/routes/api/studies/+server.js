import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { sendStudyMessage } from '$lib/server/telegram.js';


export async function GET({ url }) {
  const db = getDb();

  const q = {
    page: Number(url.searchParams.get('page')?.trim() || '1'),
    rowcount: Number(url.searchParams.get('rowcount')?.trim() || '20'),
    orderedby: url.searchParams.get('orderedby')?.trim() || '',
    orderdir: (url.searchParams.get('orderdir')?.trim().toUpperCase() === 'ASC' ? 'ASC' : 'DESC'),
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
    JOIN patients  p ON p.id = s.patient_id
    JOIN modalities m ON m.id = s.modality_id
    JOIN exam_types e ON e.id = s.exam_type_id
    JOIN users ur ON ur.id = s.corresponding_resident_id
    JOIN users ua ON ua.id = s.corresponding_attending_id
    WHERE 1=1
  `;

  const params = [];

  // Patient filters
  if (q.patient_code) {
    baseSql += ` AND p.patient_code = ?`;
    params.push(q.patient_code);
  }
  if (q.patient_firstname) {
    baseSql += ` AND p.firstname LIKE ?`;
    params.push(`%${q.patient_firstname}%`);
  }
  if (q.patient_lastname) {
    baseSql += ` AND p.lastname LIKE ?`;
    params.push(`%${q.patient_lastname}%`);
  }

  // Modality filter
  if (q.modality_id) {
    baseSql += ` AND s.modality_id = ?`;
    params.push(Number(q.modality_id));
  }

  // Exam type filter
  if (q.exam_type_id) {
    baseSql += ` AND s.exam_type_id = ?`;
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
    "p.patient_code",
    "p.firstname",
    "p.lastname",
    "s.modality_id",
    "s.patient_age",
    "s.exam_type_id",
    "s.exam_date_jalali",
  ];
  const orderCol = allowedColumns.includes(q.orderedby) ? q.orderedby : "s.exam_date_jalali";

  let dataSql = `
    SELECT
      s.*,
      p.patient_code AS patient_code,
      p.firstname    AS patient_firstname,
      p.lastname     AS patient_lastname,
      p.birth_year   AS patient_birthyear,
      p.gender       AS patient_gender,
      s.patient_age  AS patient_age,
      m.code         AS modality_code,
      e.code         AS exam_type_code,
      ur.full_name   AS resident_fullname,
      ua.full_name   AS attending_fullname
    ${baseSql}
    ORDER BY ${orderCol} ${q.orderdir}, s.exam_date_jalali DESC, s.exam_time DESC
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



export async function POST({ request }) {
  const db = getDb();
  const body = await request.json();

  const {
    patient_id,
    modality_id,
    exam_type_id,
    exam_details,
    exam_date_jalali,
    exam_time,
    corresponding_resident_id,
    corresponding_attending_id,
    audio_report_path,
    text_report_path,
    resident_checked = 0,
    attending_checked = 0,
    dicom_url,
    description,
  } = body;

  // Basic validation
  for (const field of ['patient_id', 'modality_id', 'exam_type_id', 'exam_date_jalali', 'exam_time']) {
    if (!body[field]) {
      return new Response(JSON.stringify({ error: `${field} is required` }), { status: 400 });
    }
  }

  const insert = db.prepare(`
    INSERT INTO studies (
      patient_id, modality_id, exam_type_id, exam_details, exam_date_jalali, exam_time,
      corresponding_resident_id, corresponding_attending_id,
      audio_report_path, text_report_path,
      resident_checked, attending_checked,
      dicom_url, description
    ) VALUES (
      @patient_id, @modality_id, @exam_type_id, @exam_details, @exam_date_jalali, @exam_time,
      @corresponding_resident_id, @corresponding_attending_id,
      @audio_report_path, @text_report_path,
      @resident_checked, @attending_checked,
      @dicom_url, @description
    )
  `);

  const tx = db.transaction((payload) => {
    const info = insert.run(payload);
    const studyId = info.lastInsertRowid;
    return studyId;
  });

  const studyId = tx({
    patient_id, modality_id, exam_type_id, exam_details, exam_date_jalali, exam_time,
    corresponding_resident_id, corresponding_attending_id,
    audio_report_path, text_report_path,
    resident_checked, attending_checked,
    dicom_url, description
  });

  const detail = db
				.prepare(
					`
        SELECT
          s.id AS study_id,
          s.exam_date_jalali,
          s.exam_time,
          s.modality_id,
          s.exam_type_id,
          p.firstname  AS patient_first,
          p.lastname AS patient_last,
          p.patient_code AS patient_code,
          r.full_name AS resident_name,
          a.full_name AS attending_name,
          m.code AS modality_code,
          m.name AS modality_name,
          e.code AS exam_type_code,
          e.name AS exam_type_name,
          s.exam_details AS exam_details
        FROM studies s
        JOIN patients p ON p.id = s.patient_id
        LEFT JOIN users r ON r.id = s.corresponding_resident_id
        LEFT JOIN users a ON a.id = s.corresponding_attending_id
        LEFT JOIN modalities m ON m.id = s.modality_id
        LEFT JOIN exam_types e ON e.id = s.exam_type_id
        WHERE s.id = ?
      `
				)
				.get(studyId);

  sendStudyMessage(detail);      
  return json(detail, { status: 201 });
}