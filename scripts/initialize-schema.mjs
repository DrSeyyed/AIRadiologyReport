export function initializeSchema(db, schema, { resetTestStudies = false } = {}) {
	const legacy = db
		.prepare('PRAGMA table_info(studies)')
		.all()
		.some((column) => column.name === 'patient_id');
	if (legacy && !resetTestStudies) {
		throw new Error(
			'Legacy patient-linked test data detected. Back up the database, then set RESET_TEST_STUDIES=1 when running db:init to replace test patients and studies. Users and templates are retained.'
		);
	}

	db.transaction(() => {
		if (legacy) {
			db.exec(`
				DROP TRIGGER IF EXISTS trg_studies_ai_set_age;
				DROP TRIGGER IF EXISTS trg_studies_au_set_age;
				DROP TRIGGER IF EXISTS trg_patients_au_propagate_age;
			`);
			db.exec(
				'DROP TABLE IF EXISTS pending_voice; DROP TABLE IF EXISTS pending_telegram; DROP TABLE studies; DROP TABLE patients;'
			);
		}
		db.exec(schema);
	})();
	return { reset: legacy };
}
