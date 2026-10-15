import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const signatureColumns = ['typist_checked', 'typist_signed_by_user_id', 'typist_signed_at'];

function fixture(t, definition) {
	const db = new Database(':memory:');
	t.after(() => db.close());
	db.pragma('foreign_keys=ON');
	db.exec(definition);
	db.exec(`
		INSERT INTO users(id,full_name,role) VALUES
			(1,'Synthetic Resident','resident'),(2,'Synthetic Attending','attending'),
			(3,'Synthetic Typist','typist');
		INSERT INTO studies(id,patient_code,exam_date_jalali,exam_time,corresponding_resident_id,corresponding_attending_id)
			VALUES(1,'SYNTHETIC','1405-07-18','12:00:00',1,2);
		INSERT INTO study_recordings(id,study_id,audio_report_path,text_report_path,resident_checked,attending_checked,
			corresponding_resident_id,sender_user_id,sender_role,resident_signed_by_user_id,attending_signed_by_user_id,
			resident_signed_at,attending_signed_at)
			VALUES(1,1,'synthetic/audio.webm','synthetic/report.txt',1,1,1,1,'resident',1,2,
			'2026-10-11T10:00:00Z','2026-10-11T11:00:00Z');
	`);
	return db;
}

function assertSignatureSchema(db) {
	const columns = db.prepare('PRAGMA table_info(study_recordings)').all();
	for (const name of signatureColumns)
		assert.equal(columns.filter((column) => column.name === name).length, 1);
	const checked = columns.find((column) => column.name === 'typist_checked');
	assert.equal(checked.type, 'INTEGER');
	assert.equal(checked.notnull, 1);
	assert.equal(checked.dflt_value, '0');
	const signer = db
		.pragma('foreign_key_list(study_recordings)')
		.find((key) => key.from === 'typist_signed_by_user_id');
	assert.equal(signer.table, 'users');
	assert.equal(signer.to, 'id');
	assert.equal(signer.on_delete, 'NO ACTION');
	assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
	assert.deepEqual(db.pragma('foreign_key_check'), []);
}

test('resident attending permission defaults off and migrates existing users without data loss', (t) => {
	const old = schema.replace(/,\r?\n {4}can_sign_as_attending[^\r\n]+/, '');
	const db = fixture(t, old);
	const saved = db.prepare('SELECT * FROM users').all();
	const recordings = db.prepare('SELECT * FROM study_recordings').all();
	initializeSchema(db, schema);
	initializeSchema(db, schema);
	assert.deepEqual(db.prepare('SELECT * FROM users').all(), saved.map((user) => ({ ...user, can_sign_as_attending: 0 })));
	assert.deepEqual(db.prepare('SELECT * FROM study_recordings').all(), recordings);
	assert.throws(() => db.prepare('UPDATE users SET can_sign_as_attending=2').run(), /CHECK/);
	assert.throws(() => db.prepare('UPDATE users SET can_sign_as_attending=NULL').run(), /NOT NULL/);
	db.prepare('UPDATE users SET can_sign_as_attending=1 WHERE id=1').run();
	initializeSchema(db, schema);
	assert.equal(db.prepare('SELECT can_sign_as_attending FROM users WHERE id=1').get().can_sign_as_attending, 1);
	assertSignatureSchema(db);
});

test('fresh schema persists typist signatures and enforces signer references', (t) => {
	const db = fixture(t, schema);
	assertSignatureSchema(db);
	assert.deepEqual(
		db
			.prepare(
				'SELECT typist_checked,typist_signed_by_user_id,typist_signed_at FROM study_recordings'
			)
			.get(),
		{
			typist_checked: 0,
			typist_signed_by_user_id: null,
			typist_signed_at: null
		}
	);
	assert.throws(
		() => db.prepare('UPDATE study_recordings SET typist_checked=NULL').run(),
		/NOT NULL/
	);
	assert.throws(
		() => db.prepare('UPDATE study_recordings SET typist_signed_by_user_id=999').run(),
		/FOREIGN KEY/
	);
	db.prepare(
		'UPDATE study_recordings SET typist_checked=1,typist_signed_by_user_id=3,typist_signed_at=?'
	).run('2026-10-11T12:00:00Z');
	assert.throws(() => db.prepare('DELETE FROM users WHERE id=3').run(), /FOREIGN KEY/);
	const saved = db.prepare('SELECT * FROM study_recordings').all();
	initializeSchema(db, schema);
	initializeSchema(db, schema);
	assert.deepEqual(db.prepare('SELECT * FROM study_recordings').all(), saved);
	assertSignatureSchema(db);
});

test('installed and partially migrated databases gain typist columns without changing existing recordings', (t) => {
	for (const retained of [
		[],
		['typist_checked'],
		['typist_signed_by_user_id', 'typist_signed_at']
	]) {
		const old = schema.replace(/^ {2}typist_.*\r?\n/gm, (line) =>
			retained.some((name) => line.includes(name)) ? line : ''
		);
		const db = fixture(t, old);
		const saved = db.prepare('SELECT * FROM study_recordings').get();
		initializeSchema(db, schema);
		initializeSchema(db, schema);
		assert.deepEqual(db.prepare('SELECT * FROM study_recordings').get(), {
			...saved,
			typist_checked: 0,
			typist_signed_by_user_id: null,
			typist_signed_at: null
		});
		assertSignatureSchema(db);
	}
});

test('contact removal user rebuild preserves all signature and account references idempotently', (t) => {
	const db = fixture(
		t,
		schema.replace(
			'telegram_user_id TEXT UNIQUE',
			'email TEXT, phone TEXT, telegram_user_id TEXT UNIQUE'
		)
	);
	db.exec(`
		UPDATE users SET can_sign_as_attending=1 WHERE id=1;
		UPDATE study_recordings SET typist_checked=1,typist_signed_by_user_id=3,typist_signed_at='2026-10-11T12:00:00Z';
		INSERT INTO auth_credentials VALUES(3,'synthetic_typist','synthetic-hash');
		INSERT INTO sessions(id,user_id,expires_at) VALUES('synthetic-session',3,'2099-01-01');
		INSERT INTO telegram_registrations(telegram_user_id,role,username,user_id,step)
			VALUES('synthetic-telegram','typist','synthetic_typist',3,'approved');
		INSERT INTO pending_voice(study_id,chat_id,reply_message_id,file_id,sender_user_id,sender_role,process_at)
			VALUES(1,'synthetic-chat',1,'synthetic-file',1,'resident',1);
	`);
	const tables = [
		'studies',
		'study_recordings',
		'auth_credentials',
		'sessions',
		'telegram_registrations',
		'pending_voice'
	];
	const saved = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
	initializeSchema(db, schema);
	initializeSchema(db, schema);
	for (const [index, table] of tables.entries())
		assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), saved[index]);
	assert.deepEqual(
		db
			.prepare('PRAGMA table_info(users)')
			.all()
			.map((column) => column.name),
		['id', 'full_name', 'role', 'telegram_user_id', 'can_sign_as_attending']
	);
	assertSignatureSchema(db);
	assert.equal(db.prepare('SELECT can_sign_as_attending FROM users WHERE id=1').get().can_sign_as_attending, 1);
	assert.throws(() => db.prepare('DELETE FROM users WHERE id=3').run(), /FOREIGN KEY/);
});
