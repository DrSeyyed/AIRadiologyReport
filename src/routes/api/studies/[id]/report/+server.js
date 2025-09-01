import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { editStudyMessage } from '$lib/server/telegram.js';

const REPORT_DIR = 'uploads/reports';

export async function GET({ params, locals }) {
	if (!locals.user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

	const id = Number(params.id);
	const db = getDb();
	const row = db.prepare(`SELECT text_report_path FROM studies WHERE id = ?`).get(id);
	let text = '';
	if (row?.text_report_path && existsSync(row.text_report_path)) {
		text = readFileSync(row.text_report_path, 'utf-8');
	}
	return json({ text });
}

export async function PUT({ params, request, locals }) {
	if (!locals.user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

	const id = Number(params.id);
	const { text } = await request.json();

	if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
	const path = join(REPORT_DIR, `study_${id}.txt`);
	writeFileSync(path, text ?? '', 'utf-8');

	const db = getDb();
	db.prepare(`UPDATE studies SET text_report_path = ? WHERE id = ?`).run(path, id);
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
	if (detail) await editStudyMessage(detail);
	return json({ ok: true, path });
}
