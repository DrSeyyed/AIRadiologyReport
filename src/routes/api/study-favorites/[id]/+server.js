import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { favoriteId, saveStudyFavorite, removeStudyFavorite } from '$lib/server/study-favorites.js';

export async function PUT({ locals, params, request }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	try {
		const id = favoriteId(params.id);
		const body = await request.json();
		return json(saveStudyFavorite(getDb(), locals.user.id, id, body?.category_ids));
	} catch (error) {
		return json({ error: error.status ? error.message : 'Unable to save study favorite.' }, { status: error.status || 400 });
	}
}

export async function DELETE({ locals, params }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	try {
		const id = favoriteId(params.id);
		removeStudyFavorite(getDb(), locals.user.id, id);
		return json({ is_favorite: false, favorite_category_ids: [] });
	} catch (error) {
		return json({ error: error.status ? error.message : 'Unable to remove study favorite.' }, { status: error.status || 400 });
	}
}
