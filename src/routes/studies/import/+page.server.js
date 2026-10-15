import { error, redirect } from '@sveltejs/kit';
import { canImportStudies } from '$lib/study-permissions.js';

export async function load({ locals, fetch }) {
	if (!locals.user) throw redirect(302, '/login');
	if (!canImportStudies(locals.user)) throw error(403, 'Administrator, attending or resident access required');
	const response = await fetch('/api/users?role=attending');
	if (!response.ok) throw error(response.status, 'Unable to load approved attendings');
	return { users: await response.json() };
}
