function failure(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

export function bodyPartId(value) {
	if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
		throw failure('Invalid body part ID.');
	return Number(value);
}

export function listBodyParts(db) {
	return db.prepare('SELECT id, code, name FROM exam_types ORDER BY name COLLATE NOCASE, id').all();
}

export function saveBodyPart(db, { id, code, name }) {
	for (const [label, value, max] of [['Code', code, 64], ['Name', name, 200]]) {
		if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /\p{Cc}/u.test(value))
			throw failure(`${label} must be non-empty text up to ${max} characters without control characters.`);
	}
	code = code.trim();
	name = name.trim();
	if (id !== undefined) id = bodyPartId(id);
	try {
		if (id === undefined) {
			id = Number(db.prepare('INSERT INTO exam_types(code, name) VALUES (?, ?)').run(code, name).lastInsertRowid);
		} else {
			const result = db.prepare('UPDATE exam_types SET code = ?, name = ? WHERE id = ?').run(code, name, id);
			if (!result.changes) throw failure('Body part not found.', 404);
		}
	} catch (error) {
		if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw failure('This code already exists. Choose a different code.', 409);
		throw error;
	}
	return { id, code, name };
}
