import { error, redirect } from '@sveltejs/kit';

export async function load({ locals, fetch }) {
	if (!locals.user) throw redirect(302, '/login');
	const response = await fetch('/api/account');
	if (!response.ok) throw error(response.status, 'Unable to load account');
	return { account: await response.json() };
}
