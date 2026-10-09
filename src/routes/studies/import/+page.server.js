import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';

export function load({ locals }) {
	if (!locals.user) throw redirect(302, '/login');
	if (locals.user.role !== 'admin') throw error(403, 'Administrator access required');
	return {
		users: getDb()
			.prepare(
				"SELECT id, full_name, role FROM users WHERE role IN ('resident', 'attending') ORDER BY full_name"
			)
			.all()
	};
}
