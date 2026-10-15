import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { canManageTemplates } from '$lib/template-permissions.js';
import { listTemplates } from '$lib/server/report-templates.js';

export async function load({ locals }) {
	if (!locals.user) throw redirect(302, '/login');
	if (!canManageTemplates(locals.user)) throw error(403, 'Forbidden');
	const db = getDb();
	const modalities = db.prepare('SELECT id, code, name FROM modalities ORDER BY code').all();
	const exam_types = db.prepare('SELECT id, code, name FROM exam_types ORDER BY name').all();
	return { user: locals.user, modalities, exam_types, templates: listTemplates(db) };
}
