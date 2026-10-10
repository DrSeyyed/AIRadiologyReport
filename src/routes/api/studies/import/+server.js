import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { parseStudyWorkbook } from '$lib/server/excel-studies.js';
import { previewStudyImport, commitStudyImport } from '$lib/server/study-import.js';

const MAX_BYTES = 10 * 1024 * 1024;

export async function POST({ request, locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.user.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
	if (Number(request.headers.get('content-length')) > MAX_BYTES + 1024 * 1024)
		return json({ error: 'Upload exceeds 10 MB.' }, { status: 413 });
	try {
		const form = await request.formData();
		const file = form.get('file');
		if (!(file instanceof File) || !/\.(xls|xlsx)$/i.test(file.name))
			return json({ error: 'Select an XLS or XLSX file.' }, { status: 400 });
		if (!file.size || file.size > MAX_BYTES)
			return json({ error: 'File must be between 1 byte and 10 MB.' }, { status: 413 });
		const action = form.get('action');
		if (!['preview', 'import'].includes(action))
			return json({ error: 'Invalid action' }, { status: 400 });
		const db = getDb();
		const assignments = {};
		for (const [field, role] of [
			['corresponding_resident_id', 'resident'],
			['corresponding_attending_id', 'attending']
		]) {
			const value = form.get(field);
			assignments[field] = value === null || value === '' ? null : Number(value);
			if (
				assignments[field] !== null &&
				(!Number.isSafeInteger(assignments[field]) ||
					!db
						.prepare('SELECT id FROM users WHERE id = ? AND role = ?')
						.get(assignments[field], role))
			)
				return json({ error: `Invalid ${role} assignment` }, { status: 400 });
		}
		const parsed = parseStudyWorkbook(Buffer.from(await file.arrayBuffer()));
		const telegramConfigured = Boolean(
			process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
		);
		if (action === 'preview') {
			const preview = previewStudyImport(db, parsed);
			return json({ ...preview, telegramConfigured });
		}
		if (!assignments.corresponding_attending_id)
			return json({ error: 'Select an attending before importing studies.' }, { status: 400 });
		assignments.corresponding_resident_id = null;
		const selected = JSON.parse(String(form.get('selected_rows') || '[]'));
		const result = db.transaction(() => {
			const preview = previewStudyImport(db, parsed);
			if (form.get('token') !== preview.token) return null;
			return commitStudyImport(db, preview, selected, assignments, {
				queueTelegram: telegramConfigured && form.get('notify_telegram') === 'true'
			});
		})();
		if (!result)
			return json(
				{
					error: 'Source data or existing studies changed. Preview again before importing.'
				},
				{ status: 409 }
			);
		return json(result, { status: 201 });
	} catch (error) {
		return json({ error: error.message || 'Could not import workbook' }, { status: 400 });
	}
}
