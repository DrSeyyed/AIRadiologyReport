import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getFavoriteSummary } from '$lib/server/study-favorites.js';

export function load({ locals, setHeaders }) {
	if (!locals.user) throw redirect(302, '/login');
	setHeaders({ 'cache-control': 'private, no-store' });
	return { favorites: getFavoriteSummary(getDb(), locals.user.id) };
}
