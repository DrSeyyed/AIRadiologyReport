import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listImportMappings } from '$lib/server/import-mappings';

export function load({ locals }) {
	if (!locals.user) redirect(303, '/login');
	if (locals.user.role !== 'admin') redirect(303, '/studies');
	const db = getDb();
	return {
		modalities: db.prepare('SELECT id, code, name FROM modalities ORDER BY code').all(),
		exam_types: db.prepare('SELECT id, code, name FROM exam_types ORDER BY code, name').all(),
		mappings: listImportMappings(db)
	};
}
