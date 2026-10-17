import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getFavoriteSummary, createFavoriteCategory } from '$lib/server/study-favorites.js';

export function GET({ locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	return json(getFavoriteSummary(getDb(), locals.user.id));
}

export async function POST({ locals, request }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	try {
		const body = await request.json();
		if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Provide a category name or a blank name.' }, { status: 400 });
		return json(createFavoriteCategory(getDb(), locals.user.id, body.name ?? ''), { status: 201 });
	} catch (error) {
		return json({ error: error.status ? error.message : 'Unable to create favorite category.' }, { status: error.status || 400 });
	}
}
