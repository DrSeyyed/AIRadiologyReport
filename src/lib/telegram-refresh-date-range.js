import jalaali from 'jalaali-js';
import { examinationDateRange, studyDatePresets } from './study-date-ranges.js';

export const telegramRefreshDatePresets = [
	{ value: 'all', label: 'All examination dates' },
	...studyDatePresets,
	{ value: 'custom', label: 'Custom range' }
];

export function telegramRefreshDateRange(filters = {}, now = new Date()) {
	const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
	if (!filters || typeof filters !== 'object' || Array.isArray(filters)) fail('Select a valid examination date range.');
	const preset = filters.date_range ?? 'all';
	const selected = telegramRefreshDatePresets.find(({ value }) => value === preset);
	if (!selected) fail('Select a valid examination date range.');
	if (preset === 'all') return { preset, label: selected.label, date_from: null, date_to: null };
	let bounds;
	if (preset === 'custom') {
		bounds = { date_from: filters.date_from, date_to: filters.date_to };
		for (const date of Object.values(bounds)) {
			const parts = typeof date === 'string' && date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
			if (!parts || !jalaali.isValidJalaaliDate(Number(parts[1]), Number(parts[2]), Number(parts[3])))
				fail('Enter valid Jalali dates in YYYY-MM-DD format.');
		}
		if (bounds.date_from > bounds.date_to) fail('The start date must not be after the end date.');
	} else {
		bounds = examinationDateRange(preset, now);
	}
	return { preset, label: selected.label, ...bounds };
}
