import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { restoreStudy, refreshRestoredStudies } from '$lib/server/study-deletion.js';
import { canRestoreStudy } from '$lib/study-permissions.js';

export async function POST({ params, locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (!canRestoreStudy(locals.user)) return json({ error: 'Forbidden' }, { status: 403 });
	if (!/^[1-9]\d*$/.test(params.id) || !Number.isSafeInteger(Number(params.id)))
		return json({ error: 'Invalid study ID' }, { status: 400 });
	try {
		const db = getDb();
		const id = Number(params.id);
		const result = restoreStudy(db, id, {
			queueTelegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
		});
		const notification_warning = result.restored ? await refreshRestoredStudies(db, [id]) : null;
		return json({ ok: true, disabled: false, restored: result.restored, notification_warning });
	} catch (error) {
		return json({ error: error.message || 'Restore failed' }, { status: error.status || 500 });
	}
}
