import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { canManageTemplates } from '$lib/template-permissions.js';
import { listTemplates, saveTemplate, templatePair } from '$lib/server/report-templates.js';

export async function GET({ locals, url }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	try {
		const db = getDb();
		const m = url.searchParams.get('modality_id');
		const e = url.searchParams.get('exam_type_id');
		const pair = m !== null || e !== null ? templatePair(db, m, e) : undefined;
		return json(listTemplates(db, pair));
	} catch (error) {
		return json({ error: error.status ? error.message : 'Unable to load templates.' }, { status: error.status || 500 });
	}
}

export async function POST({ request, locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (!canManageTemplates(locals.user)) return json({ error: 'Forbidden' }, { status: 403 });
	try {
		const body = await request.json().catch(() => null);
		return json(saveTemplate(getDb(), body));
	} catch (error) {
		return json({ error: error.status ? error.message : 'Unable to save template.' }, { status: error.status || 500 });
	}
}
