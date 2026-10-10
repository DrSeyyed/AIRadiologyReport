import { error, redirect } from '@sveltejs/kit';

export async function load({ locals, fetch }) {
	if (!locals.user) throw redirect(302, '/login');
	if (locals.user.role !== 'admin') throw error(403, 'Administrator access required');
	const response = await fetch('/api/users?role=attending');
	if (!response.ok) throw error(response.status, 'Unable to load approved attendings');
	return { users: await response.json() };
}
