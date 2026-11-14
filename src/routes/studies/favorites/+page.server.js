import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';

export function load() {
	throw redirect(308, resolve('/favorites'));
}
