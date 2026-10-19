import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { bodyPartId, listBodyParts, saveBodyPart } from '$lib/server/body-parts.js';

function requireAdmin(locals) {
	if (!locals.user) throw redirect(302, '/login');
	if (locals.user.role !== 'admin') throw error(403, 'Forbidden');
}

export function load({ locals, url }) {
	requireAdmin(locals);
	const bodyParts = listBodyParts(getDb());
	let selected = null;
	if (url.searchParams.has('edit')) {
		let id;
		try {
			id = bodyPartId(url.searchParams.get('edit'));
		} catch (caught) {
			throw error(caught.status, caught.message);
		}
		selected = bodyParts.find((row) => row.id === id);
		if (!selected) throw error(404, 'Body part not found.');
	}
	return { bodyParts, selected };
}

async function save({ locals, request }, editing) {
	requireAdmin(locals);
	const form = await request.formData();
	const values = Object.fromEntries(['code', 'name', ...(editing ? ['id'] : [])].map((field) => [
		field, typeof form.get(field) === 'string' ? form.get(field) : ''
	]));
	try {
		saveBodyPart(getDb(), values);
		return { success: true, message: editing ? 'Body part updated.' : 'Body part added.' };
	} catch (caught) {
		if (!caught.status) throw caught;
		return fail(caught.status, { error: caught.message, values });
	}
}

export const actions = {
	create: (event) => save(event, false),
	update: (event) => save(event, true)
};
