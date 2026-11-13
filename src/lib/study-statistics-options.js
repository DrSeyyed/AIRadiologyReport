import { studyDatePresets } from './study-date-ranges.js';

export const statisticsPresets = [
	...studyDatePresets.filter(({ value }) => value !== 'yesterday').map(({ value, label }) => ({ value, label })),
	{ value: 'custom', label: 'Custom range' }
];

export const statisticsMetrics = [
	{ key: 'total', label: 'Total studies' },
	{ key: 'active', label: 'Active studies' },
	{ key: 'disabled', label: 'Disabled studies' },
	{ key: 'reported', label: 'Fully reported' },
	{ key: 'unreported', label: 'Reports incomplete or missing' },
	{ key: 'fullySigned', label: 'All signed (R/A/T)' },
	{ key: 'awaitingSignatures', label: 'Awaiting signatures' },
	{ key: 'noRecording', label: 'No recording' },
	{ key: 'needsAttention', label: 'Needs attention' },
	{ key: 'residentSigned', label: 'All resident signatures' },
	{ key: 'attendingSigned', label: 'All attending signatures' },
	{ key: 'typistSigned', label: 'All typist signatures' }
];
