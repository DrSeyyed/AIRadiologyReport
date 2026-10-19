export const studyRowStatuses = [
	{ key: 'attention', label: 'Needs attention' },
	{ key: 'no-recording', label: 'No recording' },
	{ key: 'unsigned', label: 'Awaiting signatures' },
	{ key: 'signed', label: 'All signed (R/A/T)' }
];

export function studyRowStatus(study) {
	if (study.needs_attention) return 'attention';
	const count = study.recording_count ?? 0;
	if (count === 0) return 'no-recording';
	return ['resident_checked_count', 'attending_checked_count', 'typist_checked_count'].every(
		(key) => (study[key] ?? 0) === count
	)
		? 'signed'
		: 'unsigned';
}
