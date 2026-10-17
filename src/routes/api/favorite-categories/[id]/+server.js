import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { favoriteId, renameFavoriteCategory, deleteFavoriteCategory } from '$lib/server/study-favorites.js';

export async function PATCH({ locals, params, request }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	try {
		const id = favoriteId(params.id);
		const body = await request.json();
		return json(renameFavoriteCategory(getDb(), locals.user.id, id, body?.name));
	} catch (error) {
		return json({ error: error.status ? error.message : 'Unable to rename favorite category.' }, { status: error.status || 400 });
	}
}

export async function DELETE({ locals, params }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	try {
		const id = favoriteId(params.id);
		deleteFavoriteCategory(getDb(), locals.user.id, id);
		return json({ deleted: true });
	} catch (error) {
		return json({ error: error.status ? error.message : 'Unable to delete favorite category.' }, { status: error.status || 400 });
	}
}
