export function initializeSchema(db, schema, { resetTestStudies = false } = {}) {
	const columns = db
		.prepare('PRAGMA table_info(studies)')
		.all()
		.map((column) => column.name);
	const legacy = columns.includes('patient_id');
	if (legacy && !resetTestStudies) {
		throw new Error(
			'Legacy patient-linked test data detected. Back up the database, then set RESET_TEST_STUDIES=1 when running db:init to replace test patients and studies. Users and templates are retained.'
		);
	}
	const migrateRecordings = !legacy && columns.includes('audio_report_path');
	const foreignKeys = db.pragma('foreign_keys', { simple: true });
	// Rebuild the parent table without rewriting or cascading existing child references.
	db.pragma('foreign_keys = OFF');
	try {
		db.transaction(() => {
			const previousRecordingColumns = db
				.prepare('PRAGMA table_info(study_recordings)')
				.all()
				.map((column) => column.name);
			if (legacy) {
				db.exec(`
					DROP TRIGGER IF EXISTS trg_studies_ai_set_age;
					DROP TRIGGER IF EXISTS trg_studies_au_set_age;
					DROP TRIGGER IF EXISTS trg_patients_au_propagate_age;
					DROP TABLE IF EXISTS study_recordings;
					DROP TABLE IF EXISTS pending_voice;
					DROP TABLE IF EXISTS pending_telegram;
					DROP TABLE studies;
					DROP TABLE patients;
				`);
			}
			if (migrateRecordings) {
				const definition = schema.match(
					/CREATE TABLE\s+IF NOT EXISTS studies\s*\([\s\S]*?\n {2}\);/
				);
				if (!definition) throw new Error('Missing studies schema');
				db.exec(definition[0].replace('IF NOT EXISTS studies', 'IF NOT EXISTS studies_new'));
				const targetColumns = db
					.prepare('PRAGMA table_info(studies_new)')
					.all()
					.map((c) => c.name);
				const shared = targetColumns.filter((column) => columns.includes(column));
				db.exec(
					`INSERT INTO studies_new (${shared.join(',')}) SELECT ${shared.join(',')} FROM studies`
				);
				db.exec(
					`UPDATE studies_new SET source_modality = (SELECT code FROM modalities WHERE id = studies_new.modality_id)`
				);
				const saved = db.prepare('SELECT * FROM studies').all();
				db.exec('DROP TABLE studies; ALTER TABLE studies_new RENAME TO studies;');
				db.exec(schema);
				const insert = db.prepare(`INSERT INTO study_recordings
					(study_id, modality_id, exam_type_id, exam_details, audio_report_path, text_report_path, resident_checked, attending_checked)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
				for (const study of saved) {
					if (
						study.audio_report_path ||
						study.text_report_path ||
						study.resident_checked ||
						study.attending_checked
					)
						insert.run(
							study.id,
							study.modality_id,
							study.exam_type_id,
							study.exam_details || '',
							study.audio_report_path,
							study.text_report_path,
							study.resident_checked,
							study.attending_checked
						);
				}
			} else {
				db.exec(schema);
			}
			function addColumn(table, name, definition) {
				if (
					!db
						.prepare(`PRAGMA table_info(${table})`)
						.all()
						.some((column) => column.name === name)
				)
					db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
			}
			addColumn('users', 'telegram_user_id', 'TEXT');
			db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_user_id)');
			for (const [name, definition] of [
				['corresponding_resident_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
				['sender_user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
				['sender_role', "TEXT CHECK (sender_role IN ('resident','attending','admin','typist'))"],
				[
					'source',
					"TEXT NOT NULL DEFAULT 'legacy' CHECK (source IN ('browser','telegram','legacy'))"
				],
				['resident_signed_by_user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
				['attending_signed_by_user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
				['resident_signed_at', 'TEXT'],
				['attending_signed_at', 'TEXT']
			])
				addColumn('study_recordings', name, definition);
			if (
				!previousRecordingColumns.includes('corresponding_resident_id') &&
				(previousRecordingColumns.length || migrateRecordings)
			)
				db.exec(
					"UPDATE study_recordings SET corresponding_resident_id = (SELECT corresponding_resident_id FROM studies WHERE studies.id = study_recordings.study_id), source = 'legacy'"
				);
			addColumn(
				'pending_voice',
				'sender_user_id',
				'INTEGER REFERENCES users(id) ON DELETE SET NULL'
			);
			addColumn(
				'pending_voice',
				'sender_role',
				"TEXT CHECK (sender_role IN ('resident','attending'))"
			);
			db.exec(
				'DROP TABLE IF EXISTS study_import_components; DROP TABLE IF EXISTS study_import_mappings;'
			);
			if (db.pragma('foreign_key_check').length)
				throw new Error('Schema migration failed foreign key validation');
		})();
	} finally {
		db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
	}
	return { reset: legacy };
}
