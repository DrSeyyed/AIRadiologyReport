import { createHash } from 'node:crypto';
function normalizeDescription(value = '') {
	return value.trim().replace(/\s+/g, ' ').toUpperCase();
}
import { insertStudy, normalizeStudyInput } from './studies.js';

function fingerprint(row) {
	return JSON.stringify([
		row.patient_code,
		row.patient_firstname,
		row.patient_lastname,
		row.patient_gender,
		row.patient_age,
		row.patient_age_unit,
		row.modality_code,
		normalizeDescription(row.source_description),
		row.exam_date_jalali,
		row.exam_time
	]);
}

export function previewStudyImport(db, rows) {
	const modalities = db.prepare('SELECT id, code FROM modalities').all();
	const existingByUid = db.prepare('SELECT * FROM studies WHERE source_study_uid = ?');
	const sourceFingerprints = new Map();
	for (const row of rows) {
		if (!row.source_study_uid) continue;
		if (!sourceFingerprints.has(row.source_study_uid))
			sourceFingerprints.set(row.source_study_uid, new Set());
		sourceFingerprints.get(row.source_study_uid).add(fingerprint(row));
	}
	const seen = new Set();
	const preview = rows.map((row) => {
		const result = { ...row, errors: [...row.errors], status: 'invalid' };
		const modality = modalities.find((item) => item.code.toUpperCase() === row.modality_code);
		result.modality_id = modality?.id ?? null;
		if (row.source_description.length > 500)
			result.errors.push('Description exceeds 500 characters.');
		if (result.errors.length) return result;
		const existing = existingByUid.all(row.source_study_uid);
		if (
			sourceFingerprints.get(row.source_study_uid)?.size > 1 ||
			existing.some(
				(item) =>
					fingerprint({
						...item,
						modality_code:
							item.source_modality ||
							modalities.find((entry) => entry.id === item.modality_id)?.code
					}) !== fingerprint(row)
			)
		) {
			result.errors.push(
				'This study UID has conflicting demographics or examination details. Review the source data; no rows with this UID will be imported.'
			);
			result.status = 'conflict';
			return result;
		}
		try {
			normalizeStudyInput(db, {
				...row,
				modality_id: modality?.id ?? null,
				exam_type_id: null,
				description: row.source_description
			});
		} catch (error) {
			result.errors.push(error.message);
			return result;
		}
		result.status = existing.length || seen.has(row.source_study_uid) ? 'duplicate' : 'ready';
		seen.add(row.source_study_uid);
		return result;
	});
	const token = createHash('sha256').update(JSON.stringify(preview)).digest('hex');
	return { rows: preview, token };
}

export function commitStudyImport(
	db,
	preview,
	selectedRows,
	assignments = {},
	{ queueTelegram = false } = {}
) {
	if (
		!Array.isArray(selectedRows) ||
		!selectedRows.length ||
		selectedRows.length > 5000 ||
		selectedRows.some((row) => !Number.isSafeInteger(row))
	)
		throw new Error('Select valid rows to import');
	const selected = new Set(selectedRows);
	const rows = preview.rows.filter((row) => selected.has(row.row));
	if (
		rows.length !== selected.size ||
		rows.some((row) => !['ready', 'duplicate'].includes(row.status))
	)
		throw new Error(
			'Selected rows contain unresolved errors. Preview and review them before importing.'
		);
	return db.transaction(() => {
		let inserted = 0,
			skipped = 0;
		for (const row of rows) {
			if (
				db.prepare('SELECT id FROM studies WHERE source_study_uid = ?').get(row.source_study_uid)
			) {
				skipped++;
				continue;
			}
			const id = insertStudy(
				db,
				{
					...row,
					...assignments,
					exam_type_id: null,
					exam_details: '',
					description: row.source_description
				},
				{
					source_study_uid: row.source_study_uid,
					source_description: row.source_description,
					source_modality: row.modality_code
				}
			);
			if (queueTelegram) db.prepare('INSERT INTO pending_telegram (study_id) VALUES (?)').run(id);
			inserted++;
		}
		return { inserted, skipped };
	})();
}
