import { getStudyDetail, normalizeStudyInput, studyFields } from '$lib/server/studies.js';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { editStudyMessage } from '$lib/server/telegram.js';
import { deleteStudy } from '$lib/server/study-deletion.js';

// Optionally fetch one study
export async function GET({ params, locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const db = getDb();
	const id = Number(params.id);
	const row = getStudyDetail(db, id);
	if (!row) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });

	return json(row);
}

export async function PATCH({ params, request, locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.user.role === 'typist') return json({ error: 'Forbidden' }, { status: 403 });
	const db = getDb();
	const id = Number(params.id);
	try {
		const body = await request.json();
		const current = getStudyDetail(db, id);
		if (!current) return json({ error: 'Study not found' }, { status: 404 });
		if (current.disabled) return json({ error: 'This study is disabled.' }, { status: 409 });
		if (current.recordings.some((recording) => recording.processing))
			return json({ error: 'A recording is being processed. Try again later.' }, { status: 409 });
		const changes = Object.fromEntries(
			studyFields.filter((field) => field in body).map((field) => [field, body[field]])
		);
		if (!Object.keys(changes).length) return json({ error: 'Nothing to update' }, { status: 400 });
		const payload = normalizeStudyInput(db, { ...current, ...changes });
		if (
			payload.corresponding_attending_id !== current.corresponding_attending_id &&
			current.recordings.some(
				(recording) => recording.resident_checked || recording.attending_checked
			)
		)
			return json(
				{ error: 'Unsign all reports before changing the study attending.' },
				{ status: 409 }
			);
		if ('corresponding_attending_id' in changes && !payload.corresponding_attending_id)
			return json({ error: 'Select an attending for the study.' }, { status: 400 });
		db.prepare(
			'UPDATE studies SET ' +
				studyFields.map((field) => field + ' = @' + field).join(', ') +
				' WHERE id = @id'
		).run({ ...payload, id });
		const detail = getStudyDetail(db, id);
		let notification_warning = null;
		if (detail.telegram_message_id) {
			try {
				await editStudyMessage(detail);
			} catch {
				notification_warning = 'Study saved, but Telegram update failed.';
			}
		}
		return json({ ...detail, notification_warning });
	} catch (error) {
		return json({ error: error.message || 'Update failed' }, { status: 400 });
	}
}

export async function DELETE({ params, request, locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.user.role === 'typist') return json({ error: 'Forbidden' }, { status: 403 });
	if (!/^[1-9]\d*$/.test(params.id) || !Number.isSafeInteger(Number(params.id)))
		return json({ error: 'Invalid study ID' }, { status: 400 });
	const confirmation = await request.json().catch(() => ({}));
	try {
		return json(await deleteStudy(getDb(), Number(params.id), confirmation || {}));
	} catch (error) {
		return json({ error: error.message || 'Delete failed' }, { status: error.status || 500 });
	}
}
