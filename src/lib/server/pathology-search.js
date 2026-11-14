import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import jalaali from 'jalaali-js';
import { examinationDateRange } from '../study-date-ranges.js';
import { pathologyQuery, matchPathologyReport } from '../pathology-search.js';

const pageSize = 20;
const maxReportBytes = 1024 * 1024;
const sourceModality = "upper(trim(COALESCE(NULLIF(trim(s.source_modality), ''), m.code, '')))";

export function pathologyModalities(db) {
	return db.prepare(`SELECT DISTINCT ${sourceModality} AS modality
		FROM studies s LEFT JOIN modalities m ON m.id = s.modality_id
		WHERE ${sourceModality} != '' ORDER BY modality`).all().map((row) => row.modality);
}
function failure(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

export function pathologyFilters(params, now = new Date()) {
	for (const key of ['q', 'modality', 'date_range', 'date_from', 'date_to', 'page']) {
		if (params.getAll(key).length > 1) throw failure('Select each search filter only once.');
	}
	const filters = {
		q: (params.get('q') || '').trim(),
		modality: (params.get('modality') || '').trim().toUpperCase(),
		date_range: params.get('date_range') || 'all',
		date_from: params.get('date_from') || '', date_to: params.get('date_to') || ''
	};
	if (filters.modality.length > 64 || /[\p{Cc}\p{Cf}]/u.test(filters.modality)) throw failure('Select a valid examination modality.');
	if (filters.date_range === 'all') {
		filters.date_from = '';
		filters.date_to = '';
	} else if (filters.date_range === 'custom') {
		for (const date of [filters.date_from, filters.date_to]) {
			const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
			if (!match || !jalaali.isValidJalaaliDate(Number(match[1]), Number(match[2]), Number(match[3]))) throw failure('Enter valid Jalali dates in YYYY-MM-DD format.');
		}
		if (filters.date_from > filters.date_to) throw failure('The start date must not be after the end date.');
	} else {
		try { Object.assign(filters, examinationDateRange(filters.date_range, now)); }
		catch { throw failure('Select a valid examination date range.'); }
	}
	const page = params.get('page') || '1';
	if (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page)) || Number(page) > 1000000) throw failure('Select a valid results page.');
	return { filters, page: Number(page) };
}

export async function readPathologyReport(path, root = 'uploads') {
	const [directory, file] = await Promise.all([realpath(root), realpath(resolve(path))]);
	const within = relative(directory, file);
	if (!within || within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(within)) throw new Error('Report is outside the upload directory.');
	const handle = await open(file, 'r');
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > maxReportBytes) throw new Error('Report is unavailable or exceeds the searchable size.');
		const buffer = Buffer.alloc(Math.min(stat.size + 1, maxReportBytes + 1));
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
			if (!bytesRead) break;
			size += bytesRead;
		}
		if (size > maxReportBytes || size > stat.size) throw new Error('Report changed or exceeds the searchable size.');
		return buffer.toString('utf8', 0, size);
	} finally { await handle.close(); }
}

export async function searchPathologyReports(db, user, params, { now = new Date(), readReport = readPathologyReport, signal } = {}) {
	if (!user) throw failure('Sign in to search reports.', 401);
	if (!['admin', 'resident', 'attending', 'typist'].includes(user.role) || !Number.isSafeInteger(user.id) || user.id <= 0) throw failure('Forbidden', 403);
	const { filters, page } = pathologyFilters(params, now);
	const result = { filters, page, pageSize, total: 0, totalPages: 1, scanned: 0, unavailable: 0, rows: [], expansions: [], searched: Boolean(filters.q) };
	if (!filters.q) return result;
	let query;
	try { query = pathologyQuery(filters.q); }
	catch (caught) { throw failure(caught.message); }
	result.expansions = query.expansions;
	// The existing worklist and report endpoints allow these signed-in roles to read all studies.
	// Keyset batches avoid holding a database iterator open across asynchronous file reads.
	const values = [];
	let conditions = '';
	if (filters.date_from) { conditions += ' AND s.exam_date_jalali >= ?'; values.push(filters.date_from); }
	if (filters.date_to) { conditions += ' AND s.exam_date_jalali <= ?'; values.push(filters.date_to); }
	if (filters.modality) { conditions += ` AND ${sourceModality} = ?`; values.push(filters.modality); }
	const statement = db.prepare(`SELECT r.id AS recording_id, r.text_report_path, r.attending_checked,
		r.resident_checked, r.typist_checked, s.id AS study_id, s.patient_code,
		COALESCE(NULLIF(trim(s.patient_fullname), ''), trim(s.patient_firstname || ' ' || s.patient_lastname)) AS patient_fullname,
		s.exam_date_jalali, s.exam_time, ${sourceModality} AS source_modality, s.disabled
		FROM study_recordings r JOIN studies s ON s.id = r.study_id
		LEFT JOIN modalities m ON m.id = s.modality_id
		WHERE r.id < ? AND trim(COALESCE(r.text_report_path, '')) != ''${conditions}
		ORDER BY r.id DESC LIMIT 20`);
	let cursor = Number.MAX_SAFE_INTEGER;
	while (true) {
		signal?.throwIfAborted();
		const batch = statement.all(cursor, ...values);
		if (!batch.length) break;
		const reports = await Promise.all(batch.map(async (row) => {
			try { return await readReport(row.text_report_path); }
			catch { return null; }
		}));
		for (let i = 0; i < batch.length; i++) {
			signal?.throwIfAborted();
			const row = batch[i];
			result.scanned++;
			if (reports[i] === null || !reports[i].trim()) { result.unavailable++; continue; }
			const mentions = matchPathologyReport(reports[i], query);
			if (!mentions.length) continue;
			result.total++;
			if (result.total > (page - 1) * pageSize && result.rows.length < pageSize) {
				const publicRow = { ...row };
				delete publicRow.text_report_path;
				result.rows.push({ ...publicRow, mentions: mentions.slice(0, 3), mentionCount: mentions.length });
			}
		}
		cursor = batch[batch.length - 1].recording_id;
	}
	result.totalPages = Math.max(1, Math.ceil(result.total / pageSize));
	return result;
}
