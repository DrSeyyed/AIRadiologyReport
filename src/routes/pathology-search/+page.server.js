import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { searchPathologyReports } from '$lib/server/pathology-search.js';

export async function load({ locals, url, request, setHeaders }) {
	if (!locals.user) throw redirect(302, '/login');
	if (!['admin', 'resident', 'attending', 'typist'].includes(locals.user.role)) throw error(403, 'Forbidden');
	setHeaders({ 'cache-control': 'private, no-store' });
	try {
		const search = await searchPathologyReports(getDb(), locals.user, url.searchParams, { signal: request.signal });
		return { search, filters: search.filters, validationError: null };
	} catch (caught) {
		if (caught.status === 400) return {
			search: null, validationError: caught.message,
			filters: Object.fromEntries(['q', 'date_range', 'date_from', 'date_to'].map((key) => [key, url.searchParams.get(key) || '']))
		};
		if (caught.status === 401 || caught.status === 403) throw error(caught.status, 'Forbidden');
		throw caught;
	}
}
