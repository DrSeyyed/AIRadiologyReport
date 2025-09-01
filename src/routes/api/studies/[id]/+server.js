import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { editStudyMessage, deleteMessage } from '$lib/server/telegram.js';

// Optionally fetch one study
export async function GET({ params }) {
	const db = getDb();
	const id = Number(params.id);
	const row = db
		.prepare(
			`
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
    FROM studies s
    JOIN patients p ON p.id = s.patient_id
    JOIN modalities m ON m.id = s.modality_id
    JOIN exam_types e ON e.id = s.exam_type_id
    JOIN users ur ON ur.id = s.corresponding_resident_id
    JOIN users ua ON ua.id = s.corresponding_attending_id
    WHERE s.id = ?
  `
		)
		.get(id);
	if (!row) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });

	return json(row);
}

export async function PATCH({ params, request, locals }) {
	if (!locals.user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

	const db = getDb();
	const id = Number(params.id);
	const body = await request.json();

	// Whitelist updatable fields
	const allowed = [
		'modality_id',
		'exam_date_jalali',
		'exam_time',
		'corresponding_resident_id',
		'corresponding_attending_id',
		'exam_type_id',
		'exam_details',
		'dicom_url',
		'description',
		'resident_checked',
		'attending_checked'
	];

	const sets = [];
	const vals = [];
	for (const k of allowed) {
		if (k in body) {
			sets.push(`${k} = ?`);
			vals.push(body[k]);
		}
	}
	if (!sets.length) {
		return new Response(JSON.stringify({ error: 'Nothing to update' }), { status: 400 });
	}

	const tx = db.transaction(() => {
		if (sets.length) {
			const sql = `UPDATE studies SET ${sets.join(', ')} WHERE id = ?`;
			const info = db.prepare(sql).run(...vals, id);
			if (info.changes === 0) throw new Error('Study not found');
		}
	});

	try {
		tx();
		const detail = db
			.prepare(
				`
          SELECT
            s.id AS study_id,
            s.exam_date_jalali,
            s.exam_time,
            s.modality_id,
            s.exam_type_id,
            p.firstname  AS patient_firstname,
            p.lastname AS patient_lastname,
            p.patient_code AS patient_code,
            r.full_name AS resident_fullname,
            a.full_name AS attending_fullname,
            m.code AS modality_code,
            m.name AS modality_name,
            e.code AS exam_type_code,
            e.name AS exam_type_name,
            s.exam_details AS exam_details,
			s.resident_checked,
			s.attending_checked,
            s.telegram_message_id,
            s.audio_report_path,
            s.text_report_path
          FROM studies s
          JOIN patients p ON p.id = s.patient_id
          LEFT JOIN users r ON r.id = s.corresponding_resident_id
          LEFT JOIN users a ON a.id = s.corresponding_attending_id
          LEFT JOIN modalities m ON m.id = s.modality_id
          LEFT JOIN exam_types e ON e.id = s.exam_type_id
          WHERE s.id = ?
        `
			)
			.get(id);
		await editStudyMessage(detail);
		return json(detail);
	} catch (e) {
		const msg = e?.message || 'Update failed';
		return new Response(JSON.stringify({ error: msg }), { status: 400 });
	}
}

export async function DELETE({ params, locals }) {
	if (!locals.user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
	const db = getDb();
	const id = Number(params.id);
	const detail = db
		.prepare(
			`
          SELECT
            s.id AS study_id,
            s.exam_date_jalali,
            s.exam_time,
            s.modality_id,
            s.exam_type_id,
            p.firstname  AS patient_firstname,
            p.lastname AS patient_lastname,
            p.patient_code AS patient_code,
            r.full_name AS resident_fullname,
            a.full_name AS attending_fullname,
            m.code AS modality_code,
            m.name AS modality_name,
            e.code AS exam_type_code,
            e.name AS exam_type_name,
            s.exam_details AS exam_details,
			      s.resident_checked,
			      s.attending_checked,
            s.telegram_message_id,
            s.audio_report_path,
            s.text_report_path
          FROM studies s
          JOIN patients p ON p.id = s.patient_id
          LEFT JOIN users r ON r.id = s.corresponding_resident_id
          LEFT JOIN users a ON a.id = s.corresponding_attending_id
          LEFT JOIN modalities m ON m.id = s.modality_id
          LEFT JOIN exam_types e ON e.id = s.exam_type_id
          WHERE s.id = ?
        `
		)
		.get(id);
	const info = db.prepare(`DELETE FROM studies WHERE id = ?`).run(id);
	if (info.changes === 0) {
		return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
	}
	if (detail.telegram_message_id) deleteMessage(detail.telegram_message_id);
	return json({ ok: true });
}
