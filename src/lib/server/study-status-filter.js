import { studyRowStatuses } from '../study-row-status.js';

export function studyStatusFilter(status) {
	if (!status) return '';
	if (!studyRowStatuses.some(({ key }) => key === status)) throw new Error('Invalid study status filter');
	if (status === 'disabled') return ' AND s.disabled = 1';
	const active = ' AND COALESCE(s.disabled, 0) = 0';
	if (status === 'attention') return `${active} AND s.needs_attention = 1`;
	const normal = `${active} AND COALESCE(s.needs_attention, 0) = 0`;
	const recordings = 'SELECT 1 FROM study_recordings r WHERE r.study_id = s.id';
	if (status === 'no-recording') return `${normal} AND NOT EXISTS (${recordings})`;
	const incomplete = `${recordings} AND (COALESCE(r.resident_checked, 0) != 1 OR COALESCE(r.attending_checked, 0) != 1 OR COALESCE(r.typist_checked, 0) != 1)`;
	return `${normal} AND EXISTS (${recordings}) AND ${status === 'signed' ? 'NOT ' : ''}EXISTS (${incomplete})`;
}
