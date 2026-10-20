export const studyRowStatuses = [
	{ key: 'attention', label: 'Needs attention' },
	{ key: 'no-recording', label: 'No recording' },
	{ key: 'unsigned', label: 'Awaiting signatures' },
	{ key: 'signed', label: 'All signed (R/A/T)' },
	{ key: 'disabled', label: 'Disabled' }
];

export function studyStatusHref(search, status) {
	const params = new URLSearchParams(search);
	if (studyRowStatuses.some(({ key }) => key === status)) params.set('status', status);
	else params.delete('status');
	params.set('page', '1');
	return `/studies?${params}`;
}

export function studyRowStatus(study) {
	if (study.disabled) return 'disabled';
	if (study.needs_attention) return 'attention';
	const count = study.recording_count ?? 0;
	if (count === 0) return 'no-recording';
	return ['resident_checked_count', 'attending_checked_count', 'typist_checked_count'].every(
		(key) => (study[key] ?? 0) === count
	)
		? 'signed'
		: 'unsigned';
}
