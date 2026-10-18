export const studyDatePresets = [
	{ value: 'today', label: 'Today', days: 1 },
	{ value: 'yesterday', label: 'Yesterday', days: 1, offset: 1 },
	{ value: '3-days', label: 'Within 3 days', days: 3 },
	{ value: '7-days', label: 'Within 1 week', days: 7 },
	{ value: '30-days', label: 'Within 1 month (30 days)', days: 30 },
	{ value: '365-days', label: 'Within 1 year (365 days)', days: 365 }
];

export function examinationDateRange(value, now = new Date()) {
	if (!value) return null;
	const preset = studyDatePresets.find((preset) => preset.value === value);
	if (!preset) throw new Error('Invalid examination date range');
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit'
	}).formatToParts(now);
	const part = (type) => Number(parts.find((part) => part.type === type).value);
	// Shift civil days, not elapsed local hours, so midnight and DST cannot change the range.
	const today = Date.UTC(part('year'), part('month') - 1, part('day'), 12);
	const format = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
		timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
	});
	function date(daysAgo) {
		const parts = format.formatToParts(new Date(today - daysAgo * 86400000));
		return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type).value).join('-');
	}
	const offset = preset.offset || 0;
	return { date_from: date(offset + preset.days - 1), date_to: date(offset) };
}
