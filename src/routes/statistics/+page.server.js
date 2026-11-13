import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getStudyStatistics } from '$lib/server/study-statistics.js';

export function load(event) {
	const { locals } = event;
	if (!locals.user) throw redirect(302, '/login');
	if (!['admin', 'resident', 'attending', 'typist'].includes(locals.user.role)) throw error(403, 'Forbidden');
	const { url } = event;
	const filters = {
		date_range: url.searchParams.get('date_range') || '7-days',
		date_from: url.searchParams.get('date_from') ?? '',
		date_to: url.searchParams.get('date_to') ?? ''
	};
	try {
		return { statistics: getStudyStatistics(getDb(), locals.user, url.searchParams), filters, validationError: null };
	} catch (caught) {
		if (caught.status === 400) {
			return { statistics: null, filters, validationError: 'Select a valid date range. Custom dates must be valid Jalali dates in YYYY-MM-DD format, with From on or before To.' };
		}
		if (caught.status === 401 || caught.status === 403) throw error(caught.status, 'Forbidden');
		throw caught;
	}
}
