import { error, redirect } from '@sveltejs/kit';
import { load as loadStatistics } from '../../statistics/+page.server.js';

export function load(event) {
	if (!event.locals.user) throw redirect(302, '/login');
	if (event.locals.user.role !== 'admin') throw error(403, 'Forbidden');
	return loadStatistics(event);
}
