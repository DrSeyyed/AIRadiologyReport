import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { createAdminAccount } from '$lib/server/user-accounts.js';

export async function GET({ url, locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const role = url.searchParams.get('role'); // optional
	const db = getDb();

	let sql = `SELECT u.id, u.full_name, u.role,
                    ac.username
             FROM users u
             LEFT JOIN auth_credentials ac ON ac.user_id = u.id`;
	const params = [];
	if (role) {
		sql += ` WHERE u.role = ?`;
		params.push(role);
	}
	sql += ` ORDER BY u.full_name`;

	const rows = db.prepare(sql).all(...params);
	return json(rows);
}

export async function POST({ request, locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.user.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });

	try {
		const body = await request.json().catch(() => null);
		return json(await createAdminAccount(getDb(), locals.user, body), { status: 201 });
	} catch (error) {
		return json(
			{ error: error.status ? error.message : 'Failed to create user' },
			{ status: error.status || 500 }
		);
	}
}
