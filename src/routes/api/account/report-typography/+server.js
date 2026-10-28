import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { normalizeReportTypography } from '$lib/report-copy.js';
import { getUserReportTypography, setUserReportTypography } from '$lib/server/report-typography.js';

async function respond(locals, operation) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	try {
		const db = getDb();
		if (!db.prepare('SELECT id FROM users WHERE id=?').get(locals.user.id)) {
			return json({ error: 'Unauthorized' }, { status: 401 });
		}
		return await operation(db, locals.user.id);
	} catch (error) {
		if (error.status === 401) return json({ error: 'Unauthorized' }, { status: 401 });
		return json({ error: 'Unable to manage report typography' }, { status: 500 });
	}
}

export function GET({ locals }) {
	return respond(locals, (db, userId) => json(getUserReportTypography(db, userId)));
}

export function PATCH({ locals, request }) {
	return respond(locals, async (db, userId) => {
		let typography;
		try {
			typography = normalizeReportTypography(await request.json());
		} catch {
			return json(
				{ error: 'Provide only a supported report font and numeric size from 6 to 72.' },
				{ status: 400 }
			);
		}
		return json(setUserReportTypography(db, userId, typography));
	});
}
