import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import {
	getAttendingReportPreferences,
	setAttendingReportPreferences
} from '$lib/server/report-preferences.js';

async function respond(locals, operation) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	try {
		const db = getDb();
		const user = db.prepare('SELECT role FROM users WHERE id=?').get(locals.user.id);
		if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
		if (user.role !== 'attending') {
			return json({ error: 'Only attendings can manage report preferences' }, { status: 403 });
		}
		return await operation(db, locals.user.id);
	} catch {
		return json({ error: 'Unable to manage report preferences' }, { status: 500 });
	}
}

export function GET({ locals }) {
	return respond(locals, (db, userId) => json(getAttendingReportPreferences(db, userId)));
}

export function PATCH({ locals, request }) {
	return respond(locals, async (db, userId) => {
		const input = await request.json().catch(() => null);
		if (
			!input ||
			typeof input !== 'object' ||
			Array.isArray(input) ||
			Object.keys(input).length !== 1 ||
			!Object.hasOwn(input, 'english_variant') ||
			!['british', 'american'].includes(input.english_variant)
		) {
			return json({ error: 'Provide only english_variant: british or american' }, { status: 400 });
		}
		return json(setAttendingReportPreferences(db, userId, input));
	});
}
