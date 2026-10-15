import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { canManageTemplates } from '$lib/template-permissions.js';
import { generateTemplateDraft } from '$lib/server/report-templates.js';

export async function POST({ locals, request }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (!canManageTemplates(locals.user)) return json({ error: 'Forbidden' }, { status: 403 });
	try {
		const body = await request.json().catch(() => null);
		return json(await generateTemplateDraft(getDb(), body));
	} catch (error) {
		return json({ error: error.status ? error.message : 'Unable to generate template.' }, { status: error.status || 500 });
	}
}
