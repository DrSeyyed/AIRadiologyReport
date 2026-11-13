import { error, redirect } from '@sveltejs/kit';

export function load({ locals }) {
	if (!locals.user) throw redirect(302, '/login');
	if (locals.user.role !== 'admin') throw error(403, 'Administrator access required');
	return {};
}
