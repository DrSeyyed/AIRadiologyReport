import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
	normalizeDescription,
	listImportMappings,
	saveImportMapping,
	deleteImportMapping
} from '../src/lib/server/import-mappings.js';

function fixture(t) {
	const db = new Database(':memory:');
	t.after(() => db.close());
	db.pragma('foreign_keys = ON');
	db.exec(`
    CREATE TABLE modalities (id INTEGER PRIMARY KEY, code TEXT, name TEXT);
    CREATE TABLE exam_types (id INTEGER PRIMARY KEY, code TEXT, name TEXT);
    CREATE TABLE studies (id INTEGER PRIMARY KEY, exam_details TEXT);
    CREATE TABLE study_import_mappings (
      id INTEGER PRIMARY KEY,
      modality_id INTEGER NOT NULL REFERENCES modalities(id),
      source_description TEXT NOT NULL,
      description_key TEXT NOT NULL,
      UNIQUE(modality_id, description_key)
    );
    CREATE TABLE study_import_components (
      id INTEGER PRIMARY KEY,
      mapping_id INTEGER NOT NULL REFERENCES study_import_mappings(id) ON DELETE CASCADE,
      exam_type_id INTEGER NOT NULL REFERENCES exam_types(id),
      exam_details TEXT NOT NULL DEFAULT '',
      UNIQUE(mapping_id, exam_type_id, exam_details)
    );
    INSERT INTO modalities VALUES (1, 'CT', 'CT'), (2, 'MR', 'MRI');
    INSERT INTO exam_types VALUES (1, 'CHEST_WO', 'Chest without contrast'),
      (2, 'ABD_WC', 'Abdomen with contrast'), (3, 'LIMB_WWC', 'Limb without and with contrast');
    INSERT INTO studies VALUES (1, 'Existing study');
  `);
	return db;
}

const body = (overrides = {}) => ({
	modality_id: 1,
	source_description: 'Chest + abdomen / limbs_WWC',
	components: [{ exam_type_id: 1, exam_details: '' }],
	...overrides
});

function plainComponents(mapping) {
	return mapping.components.map(({ exam_type_id, exam_details }) => ({
		exam_type_id,
		exam_details
	}));
}

test('normalization ignores only case and extra whitespace, preserving punctuation', () => {
	assert.equal(
		normalizeDescription('  chest\t+ abdomen /\nlimbs_wwc  '),
		'CHEST + ABDOMEN / LIMBS_WWC'
	);
	assert.notEqual(normalizeDescription('CHEST+ABD'), normalizeDescription('CHEST/ABD'));
});

test('multiple explicit components retain contrast codes and separate sides', (t) => {
	const db = fixture(t);
	const components = [
		{ exam_type_id: 1, exam_details: '' },
		{ exam_type_id: 2, exam_details: '' },
		{ exam_type_id: 3, exam_details: ' Right\t leg ' },
		{ exam_type_id: 3, exam_details: 'Left leg' }
	];
	const saved = saveImportMapping(db, body({ components }));
	assert.equal(saved.components.length, 4);
	assert.equal(saved.components[2].exam_details, 'Right leg');
	assert.equal(saved.components[2].exam_type_code, 'LIMB_WWC');
	assert.deepEqual(listImportMappings(db), [saved]);
});

test('upsert preserves the ID, replaces components, and scopes identity to modality', (t) => {
	const db = fixture(t);
	const original = saveImportMapping(db, body());
	const saved = saveImportMapping(
		db,
		body({
			source_description: '  CHEST + ABDOMEN / LIMBS_wwc ',
			components: [{ exam_type_id: 2, exam_details: '  Left  ' }]
		})
	);
	assert.equal(saved.id, original.id);
	assert.deepEqual(plainComponents(saved), [{ exam_type_id: 2, exam_details: 'Left' }]);
	const other = saveImportMapping(db, body({ modality_id: 2 }));
	assert.notEqual(other.id, original.id);
	assert.equal(listImportMappings(db).length, 2);
});

test('invalid input is rejected without changing existing mappings', (t) => {
	const db = fixture(t);
	const saved = saveImportMapping(db, body());
	const invalid = [
		null,
		[],
		body({ modality_id: '1' }),
		body({ modality_id: 99 }),
		body({ source_description: '  ' }),
		body({ source_description: 'a'.repeat(501) }),
		body({ source_description: null }),
		body({ components: [] }),
		body({ components: Array.from({ length: 31 }, () => ({ exam_type_id: 1 })) }),
		body({ components: [null] }),
		body({ components: [{ exam_type_id: 99 }] }),
		body({ components: [{ exam_type_id: 0 }] }),
		body({ components: [{ exam_type_id: 1, exam_details: null }] }),
		body({ components: [{ exam_type_id: 1, exam_details: 'a'.repeat(201) }] }),
		body({
			components: [
				{ exam_type_id: 1, exam_details: ' Right  leg ' },
				{ exam_type_id: 1, exam_details: 'Right leg' }
			]
		})
	];
	for (const input of invalid) assert.throws(() => saveImportMapping(db, input), Error);
	assert.deepEqual(listImportMappings(db), [saved]);
});

test('component insertion failure rolls back the entire upsert', (t) => {
	const db = fixture(t);
	const saved = saveImportMapping(db, body());
	db.exec(`CREATE TRIGGER reject_component BEFORE INSERT ON study_import_components
    WHEN NEW.exam_type_id = 2 BEGIN SELECT RAISE(ABORT, 'test failure'); END;`);
	assert.throws(() =>
		saveImportMapping(
			db,
			body({
				source_description: 'CHEST + ABDOMEN / LIMBS_WWC',
				components: [{ exam_type_id: 2, exam_details: '' }]
			})
		)
	);
	assert.deepEqual(listImportMappings(db), [saved]);
});

test('zero-component preview registrations list as unmapped and can be configured', (t) => {
	const db = fixture(t);
	db.prepare(
		`INSERT INTO study_import_mappings
    (modality_id, source_description, description_key) VALUES (?, ?, ?)`
	).run(1, 'Unfamiliar_ABC', 'UNFAMILIAR_ABC');
	const [unmapped] = listImportMappings(db);
	assert.deepEqual(unmapped.components, []);
	const saved = saveImportMapping(db, body({ source_description: 'unfamiliar_abc' }));
	assert.equal(saved.id, unmapped.id);
	assert.equal(saved.components.length, 1);
});

test('deletion cascades only mapping components, leaving existing studies untouched', (t) => {
	const db = fixture(t);
	const saved = saveImportMapping(db, body());
	assert.throws(() => deleteImportMapping(db, '1'), Error);
	deleteImportMapping(db, saved.id);
	deleteImportMapping(db, saved.id);
	assert.deepEqual(listImportMappings(db), []);
	assert.equal(db.prepare('SELECT COUNT(*) AS count FROM study_import_components').get().count, 0);
	assert.deepEqual(db.prepare('SELECT * FROM studies').all(), [
		{ id: 1, exam_details: 'Existing study' }
	]);
});
