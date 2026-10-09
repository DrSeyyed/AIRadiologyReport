import { createHash } from 'node:crypto';
import { listImportMappings, normalizeDescription } from './import-mappings.js';
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

export function previewStudyImport(db, rows, { registerDescriptions = false } = {}) {
	const modalities = db.prepare('SELECT id, code FROM modalities').all();
	if (registerDescriptions) {
		const register = db.prepare(
			'INSERT INTO study_import_mappings (modality_id, source_description, description_key) VALUES (?, ?, ?) ON CONFLICT(modality_id, description_key) DO NOTHING'
		);
		db.transaction(() => {
			for (const row of rows) {
				const modality = modalities.find((item) => item.code.toUpperCase() === row.modality_code);
				if (modality && row.source_description && row.source_description.length <= 500)
					register.run(
						modality.id,
						row.source_description,
						normalizeDescription(row.source_description)
					);
			}
		})();
	}
	const mappings = listImportMappings(db);
	const exams = db.prepare('SELECT id, code FROM exam_types').all();
	const existingByUid = db.prepare('SELECT * FROM studies WHERE source_study_uid = ?');
	const sourceFingerprints = new Map();
	for (const row of rows) {
		if (!row.source_study_uid) continue;
		if (!sourceFingerprints.has(row.source_study_uid))
			sourceFingerprints.set(row.source_study_uid, new Set());
		sourceFingerprints.get(row.source_study_uid).add(fingerprint(row));
	}
	const seen = new Set();
	let expandedCount = 0;
	const preview = rows.map((row) => {
		const result = { ...row, errors: [...row.errors], components: [], status: 'invalid' };
		const modality = modalities.find((item) => item.code.toUpperCase() === row.modality_code);
		if (!modality)
			result.errors.push('Unknown modality; add it to reference data before importing.');
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
						modality_code: modalities.find((entry) => entry.id === item.modality_id)?.code
					}) !== fingerprint(row)
			)
		) {
			result.errors.push(
				'This study UID has conflicting demographics or examination details. Review the source data; no rows with this UID will be imported.'
			);
			result.status = 'conflict';
			return result;
		}
		const mapping = mappings.find(
			(item) =>
				item.modality_id === modality.id &&
				item.description_key === normalizeDescription(row.source_description)
		);
		if (!mapping?.components.length) {
			result.errors.push(
				'Configure this description in Admin > Import descriptions, then preview again.'
			);
			result.status = 'unmapped';
			return result;
		}
		for (const component of mapping.components) {
			const exam = exams.find((item) => item.id === component.exam_type_id);
			if (!exam) {
				result.errors.push('A mapped exam type is unavailable.');
				continue;
			}
			try {
				normalizeStudyInput(db, {
					...row,
					modality_id: modality.id,
					exam_type_id: exam.id,
					exam_details: component.exam_details,
					description: row.source_description
				});
			} catch (error) {
				result.errors.push(error.message);
				continue;
			}
			const source_component = `${exam.id}:${normalizeDescription(component.exam_details)}`;
			const key = `${row.source_study_uid}\u0000${source_component}`;
			const duplicate =
				seen.has(key) || existing.some((item) => item.source_component === source_component);
			seen.add(key);
			result.components.push({
				exam_type_id: exam.id,
				exam_type_code: exam.code,
				exam_details: component.exam_details,
				source_component,
				duplicate
			});
		}
		expandedCount += result.components.length;
		result.status = result.errors.length
			? 'invalid'
			: result.components.every((item) => item.duplicate)
				? 'duplicate'
				: 'ready';
		return result;
	});
	if (expandedCount > 10000)
		throw new Error('This file expands to more than 10,000 studies. Import a smaller export.');
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
			for (const component of row.components) {
				if (component.duplicate) {
					skipped++;
					continue;
				}
				const id = insertStudy(
					db,
					{
						...row,
						...assignments,
						exam_type_id: component.exam_type_id,
						exam_details: component.exam_details,
						description: row.source_description
					},
					{
						source_study_uid: row.source_study_uid,
						source_component: component.source_component,
						source_description: row.source_description
					}
				);
				if (queueTelegram) db.prepare('INSERT INTO pending_telegram (study_id) VALUES (?)').run(id);
				inserted++;
			}
		}
		return { inserted, skipped };
	})();
}
