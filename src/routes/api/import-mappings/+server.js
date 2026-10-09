import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import {
	listImportMappings,
	saveImportMapping,
	deleteImportMapping
} from '$lib/server/import-mappings';

function authorize(locals) {
	if (!locals.user) return json({ error: 'Authentication required.' }, { status: 401 });
	if (locals.user.role !== 'admin')
		return json({ error: 'Administrator access required.' }, { status: 403 });
	return null;
}

function badRequest(error) {
	const message =
		error instanceof SyntaxError
			? 'Invalid JSON body.'
			: error instanceof Error && !error.code
				? error.message
				: 'Unable to update import mapping.';
	return json({ error: message }, { status: 400 });
}

export function GET({ locals }) {
	const denied = authorize(locals);
	if (denied) return denied;
	return json(listImportMappings(getDb()));
}

export async function PUT({ locals, request }) {
	const denied = authorize(locals);
	if (denied) return denied;
	try {
		return json(saveImportMapping(getDb(), await request.json()));
	} catch (error) {
		return badRequest(error);
	}
}

export async function DELETE({ locals, request }) {
	const denied = authorize(locals);
	if (denied) return denied;
	try {
		const body = await request.json();
		deleteImportMapping(getDb(), body?.id);
		return json({ ok: true });
	} catch (error) {
		return badRequest(error);
	}
}
