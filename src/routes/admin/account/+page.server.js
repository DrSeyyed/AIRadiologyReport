import { error, redirect } from '@sveltejs/kit';
import { load as loadAccount } from '../../account/+page.server.js';

export function load(event) {
	if (!event.locals.user) throw redirect(302, '/login');
	if (event.locals.user.role !== 'admin') throw error(403, 'Forbidden');
	return loadAccount(event);
}
