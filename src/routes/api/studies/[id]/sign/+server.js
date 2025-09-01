import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { sendTelegramMessage } from '$lib/server/notify';
import { editStudyMessage } from '$lib/server/telegram.js';

export async function POST(event) {
	const { params, request, locals, fetch } = event;
	if (!locals.user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

	const id = Number(params.id);
	const { role: roleToSign, checked } = await request.json(); // 'resident' | 'attending'
	if (!['resident', 'attending'].includes(roleToSign)) {
		return new Response(JSON.stringify({ error: 'Invalid role' }), { status: 400 });
	}

	const db = getDb();
	const s = db
		.prepare(
			`
    SELECT
      resident_checked,
      attending_checked,
      corresponding_resident_id,
      corresponding_attending_id
    FROM studies
    WHERE id = ?
  `
		)
		.get(id);
	if (!s) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });

	const user = locals.user;
	const isAdmin = user.role === 'admin';
	const isCorrespondingResident =
		user.role === 'resident' && user.id === s.corresponding_resident_id;
	const isCorrespondingAttending =
		user.role === 'attending' && user.id === s.corresponding_attending_id;

	/* ---------------- Permissions ---------------- */
	if (roleToSign === 'resident') {
		// Only corresponding resident or admin
		if (!isAdmin && !isCorrespondingResident) {
			return new Response(
				JSON.stringify({ error: 'Forbidden (resident only for corresponding resident)' }),
				{ status: 403 }
			);
		}
		// If attending already signed, resident cannot uncheck (unless admin)
		if (!checked && s.attending_checked === 1 && !isAdmin) {
			return new Response(
				JSON.stringify({ error: 'Cannot uncheck resident after attending has signed' }),
				{ status: 409 }
			);
		}

		// Cascade un-sign if admin unchecks resident while attending=1
		if (!checked && s.attending_checked === 1 && isAdmin) {
			const txn = db.transaction(() => {
				db.prepare(
					`UPDATE studies SET resident_checked = 0, attending_checked = 0 WHERE id = ?`
				).run(id);
			});
			txn();
			return json({ ok: true, resident_checked: 0, attending_checked: 0 });
		}

		db.prepare(`UPDATE studies SET resident_checked = ? WHERE id = ?`).run(checked ? 1 : 0, id);
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
		return json({
			ok: true,
			resident_checked: checked ? 1 : 0,
			attending_checked: s.attending_checked
		});
	}

	// roleToSign === 'attending'
	// Only corresponding attending or admin
	if (!isAdmin && !isCorrespondingAttending) {
		return new Response(
			JSON.stringify({ error: 'Forbidden (attending only for corresponding attending)' }),
			{ status: 403 }
		);
	}
	// Attending can only sign if resident is already checked (unless admin)
	if (checked && s.resident_checked !== 1 && !isAdmin) {
		return new Response(JSON.stringify({ error: 'Resident must sign first' }), { status: 409 });
	}

	const wasChecked = s.attending_checked === 1;
	db.prepare(`UPDATE studies SET attending_checked = ? WHERE id = ?`).run(checked ? 1 : 0, id);

	// If we just transitioned 0 -> 1, fire Telegram notification (best-effort)
	if (checked && !wasChecked) {
		try {
			// Gather display data safely (supports either name/family OR firstname/lastname)
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

			const modalityLabel = detail?.modality_code || detail?.modality_name || 'Imaging';
			const examTypeLabel = detail?.exam_type_code || detail?.exam_type_name || '';
			const examDetailsLabel = s.exam_detail ? ` (${detail?.exam_details})` : '';
			const title = `${examTypeLabel}${examDetailsLabel}, ${modalityLabel}`;

			let reportText = '';
			try {
				const res = await fetch(`/api/studies/${id}/report`);
				if (res.ok) {
					const data = await res.json();
					reportText = data?.text ?? '';
				}
			} catch (err) {
				console.error('Error fetching report:', err);
			}

			function markdownToHtml(text) {
				// Replace **something** with <b>something</b>
				let regex = /\*\*([^*]+)\*\*/g;
				return text.replace(regex, '<strong>$1</strong>');
			}

			// Build an HTML message (Telegram parse_mode=HTML)
			const msg = [
				`<b>Final report signed</b>`,
				`<b>Study #${id}</b> — ${title}`,
				`Patient: <b>${detail?.patient_first || '-'} ${detail?.patient_last || ''}, code: ${detail?.patient_code || ''}</b>`,
				`Resident: <b>${detail?.resident_name || '-'}</b>`,
				`Attending: <b>${detail?.attending_name || '-'}</b>`,
				`Date/Time: ${detail?.exam_date_jalali || '-'} ${detail?.exam_time || ''}`,
				`<pre>${markdownToHtml(reportText)}</pre>`
			]
				.filter(Boolean)
				.join('\n');

			await sendTelegramMessage(msg);
		} catch (e) {
			console.warn('Telegram notify failed (non-fatal):', e?.message || e);
			// do not throw; signing must succeed even if notify fails
		}
	}

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
	return json({
		ok: true,
		resident_checked: s.resident_checked,
		attending_checked: checked ? 1 : 0
	});
}
