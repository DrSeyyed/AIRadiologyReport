function normalizeWhitespace(value) {
	return value.trim().replace(/\s+/gu, ' ');
}

export function normalizeDescription(value) {
	return normalizeWhitespace(value).toUpperCase();
}

function validateId(value, label) {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive integer.`);
	}
	return value;
}

function readMapping(db, id) {
	const mapping = db
		.prepare(
			`
    SELECT im.*, m.code AS modality_code, m.name AS modality_name
    FROM study_import_mappings im
    JOIN modalities m ON m.id = im.modality_id
    WHERE im.id = ?
  `
		)
		.get(id);
	if (!mapping) return null;
	mapping.components = db
		.prepare(
			`
    SELECT ic.exam_type_id, ic.exam_details,
           et.code AS exam_type_code, et.name AS exam_type_name
    FROM study_import_components ic
    JOIN exam_types et ON et.id = ic.exam_type_id
    WHERE ic.mapping_id = ? ORDER BY ic.id
  `
		)
		.all(id);
	return mapping;
}

export function listImportMappings(db) {
	return db
		.prepare(
			`
    SELECT id FROM study_import_mappings ORDER BY modality_id, description_key, id
  `
		)
		.all()
		.map(({ id }) => readMapping(db, id));
}

export function saveImportMapping(db, body) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new Error('A mapping object is required.');
	}
	const modalityId = validateId(body.modality_id, 'Modality');
	if (typeof body.source_description !== 'string' || body.source_description.length > 500) {
		throw new Error('Source description must be text of at most 500 characters.');
	}
	const description = normalizeWhitespace(body.source_description);
	if (!description) throw new Error('Source description is required.');
	if (
		!Array.isArray(body.components) ||
		body.components.length < 1 ||
		body.components.length > 30
	) {
		throw new Error('Select between 1 and 30 components explicitly.');
	}
	const seen = new Set();
	const components = body.components.map((component) => {
		if (!component || typeof component !== 'object' || Array.isArray(component)) {
			throw new Error('Each component must be an object.');
		}
		const examTypeId = validateId(component.exam_type_id, 'Exam type');
		const details = component.exam_details === undefined ? '' : component.exam_details;
		if (typeof details !== 'string' || details.length > 200) {
			throw new Error('Exam details must be text of at most 200 characters.');
		}
		const examDetails = normalizeWhitespace(details);
		const key = JSON.stringify([examTypeId, examDetails]);
		if (seen.has(key)) throw new Error('Duplicate components are not allowed.');
		seen.add(key);
		return { exam_type_id: examTypeId, exam_details: examDetails };
	});

	return db.transaction(() => {
		if (!db.prepare('SELECT id FROM modalities WHERE id = ?').get(modalityId)) {
			throw new Error('Modality does not exist.');
		}
		const findExamType = db.prepare('SELECT id FROM exam_types WHERE id = ?');
		for (const component of components) {
			if (!findExamType.get(component.exam_type_id)) throw new Error('Exam type does not exist.');
		}
		const descriptionKey = normalizeDescription(description);
		db.prepare(
			`
      INSERT INTO study_import_mappings (modality_id, source_description, description_key)
      VALUES (?, ?, ?)
      ON CONFLICT(modality_id, description_key)
      DO UPDATE SET source_description = excluded.source_description
    `
		).run(modalityId, description, descriptionKey);
		const { id } = db
			.prepare(
				`
      SELECT id FROM study_import_mappings WHERE modality_id = ? AND description_key = ?
    `
			)
			.get(modalityId, descriptionKey);
		db.prepare('DELETE FROM study_import_components WHERE mapping_id = ?').run(id);
		const insert = db.prepare(`
      INSERT INTO study_import_components (mapping_id, exam_type_id, exam_details) VALUES (?, ?, ?)
    `);
		for (const component of components)
			insert.run(id, component.exam_type_id, component.exam_details);
		return readMapping(db, id);
	})();
}

export function deleteImportMapping(db, id) {
	validateId(id, 'Mapping ID');
	db.prepare('DELETE FROM study_import_mappings WHERE id = ?').run(id);
}
