import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import {
	getAccount,
	createAdminAccount,
	updateAccount,
	removeAccount
} from '../src/lib/server/user-accounts.js';
const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys=ON');
	initializeSchema(db, schema);
	t.after(() => db.close());
	const add = (name, role, username) => {
		const id = Number(
			db.prepare('INSERT INTO users(full_name,role) VALUES(?,?)').run(name, role).lastInsertRowid
		);
		if (username)
			db.prepare('INSERT INTO auth_credentials(user_id,username,password_hash) VALUES(?,?,?)').run(
				id,
				username,
				bcrypt.hashSync('Synthetic-password-42', 4)
			);
		return { id, role };
	};
	const admin = add('Synthetic Admin', 'admin', 'admin_test'),
		resident = add('Synthetic Resident', 'resident', 'resident_test'),
		typist = add('Synthetic Typist', 'typist', 'typist_test');
	return { db, add, admin, resident, typist };
}
test('users can edit only their name, username and password and safe responses exclude credentials/contact data', async (t) => {
	const { db, resident, typist } = fixture(t);
	db.prepare(
		"INSERT INTO sessions(id,user_id,expires_at) VALUES('current',?,'2099-01-01'),('other',?,'2099-01-01')"
	).run(resident.id, resident.id);
	const updated = await updateAccount(
		db,
		resident,
		resident.id,
		{
			full_name: ' Updated Reviewer ',
			username: 'updated_resident',
			password: 'New-synthetic-password-42'
		},
		{ selfOnly: true, sessionId: 'current' }
	);
	assert.equal(updated.full_name, 'Updated Reviewer');
	assert.equal(updated.username, 'updated_resident');
	assert.equal(updated.role, 'resident');
	assert.equal(updated.password_hash, undefined);
	assert.equal(updated.email, undefined);
	assert.ok(
		bcrypt.compareSync(
			'New-synthetic-password-42',
			db.prepare('SELECT password_hash FROM auth_credentials WHERE user_id=?').get(resident.id)
				.password_hash
		)
	);
	assert.deepEqual(db.prepare('SELECT id FROM sessions').all(), [{ id: 'current' }]);
	await assert.rejects(
		updateAccount(db, resident, resident.id, { role: 'admin' }, { selfOnly: true }),
		{ status: 403 }
	);
	await assert.rejects(updateAccount(db, resident, typist.id, { full_name: 'Other' }), {
		status: 403
	});
	assert.throws(() => removeAccount(db, resident, resident.id), { status: 403 });
	await assert.rejects(
		updateAccount(db, resident, resident.id, { email: 'not-stored' }, { selfOnly: true }),
		{ status: 400 }
	);
});
test('admin creates only admins and edits other users with validation and session revocation', async (t) => {
	const { db, admin, typist } = fixture(t);
	const user = await createAdminAccount(db, admin, {
		full_name: 'Second Admin',
		role: 'admin',
		username: 'second_admin',
		password: 'Synthetic-password-42'
	});
	assert.equal(user.role, 'admin');
	for (const role of ['typist', 'resident', 'attending'])
		await assert.rejects(
			createAdminAccount(db, admin, {
				full_name: 'Test',
				role,
				username: 'new_staff',
				password: 'Synthetic-password-42'
			}),
			{ status: 400 }
		);
	db.prepare("INSERT INTO sessions(id,user_id,expires_at) VALUES('staff',?,'2099-01-01')").run(
		typist.id
	);
	const updated = await updateAccount(db, admin, typist.id, {
		full_name: 'Edited Typist',
		username: 'edited_typist',
		password: 'New-synthetic-password-42',
		role: 'resident'
	});
	assert.equal(updated.role, 'resident');
	assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
	for (const data of [
		{ full_name: '' },
		{ username: 'UPPER' },
		{ password: 'short' },
		{ password: 'é'.repeat(40) },
		{ role: 'invalid' },
		{ phone: '123' }
	])
		await assert.rejects(updateAccount(db, admin, typist.id, data), { status: 400 });
	await assert.rejects(updateAccount(db, admin, 999, { full_name: 'Missing' }), { status: 404 });
	await assert.rejects(updateAccount(db, null, typist.id, {}), { status: 401 });
});
test('username uniqueness includes case-insensitive existing credentials and pending Telegram reservations', async (t) => {
	const { db, admin, resident, typist } = fixture(t);
	db.prepare("UPDATE auth_credentials SET username='MixedUser' WHERE user_id=?").run(typist.id);
	await assert.rejects(updateAccount(db, admin, resident.id, { username: 'mixeduser' }), {
		status: 409
	});
	db.prepare(
		"INSERT INTO telegram_registrations(telegram_user_id,username,step) VALUES('123','reserved_user','pending')"
	).run();
	await assert.rejects(updateAccount(db, admin, resident.id, { username: 'reserved_user' }), {
		status: 409
	});
	assert.equal(getAccount(db, resident.id).username, 'resident_test');
});
test('last admin cannot be demoted and users cannot delete themselves; other users can be removed', async (t) => {
	const { db, admin, typist, add } = fixture(t);
	await assert.rejects(updateAccount(db, admin, admin.id, { role: 'typist' }), { status: 409 });
	assert.throws(() => removeAccount(db, admin, admin.id), { status: 403 });
	const other = add('Second Admin', 'admin', 'second_admin');
	assert.deepEqual(removeAccount(db, admin, other.id), { ok: true });
	assert.deepEqual(removeAccount(db, admin, typist.id), { ok: true });
	assert.equal(getAccount(db, typist.id), undefined);
	assert.equal(
		db.prepare('SELECT 1 FROM auth_credentials WHERE user_id=?').get(typist.id),
		undefined
	);
});
test('deletion preserves studies/recordings, clears assignments and revokes linked Telegram approval and sessions', async (t) => {
	const { db, admin, resident } = fixture(t);
	db.prepare("UPDATE users SET telegram_user_id='200' WHERE id=?").run(resident.id);
	db.prepare(
		"INSERT INTO telegram_registrations(telegram_user_id,role,username,user_id,step) VALUES('200','resident','resident_test',?,'approved')"
	).run(resident.id);
	db.prepare("INSERT INTO sessions(id,user_id,expires_at) VALUES('resident',?,'2099-01-01')").run(
		resident.id
	);
	const study = Number(
		db
			.prepare(
				"INSERT INTO studies(patient_code,exam_date_jalali,exam_time,corresponding_resident_id) VALUES('SYNTHETIC','1405-07-18','12:00:00',?)"
			)
			.run(resident.id).lastInsertRowid
	);
	db.prepare(
		"INSERT INTO study_recordings(study_id,corresponding_resident_id,sender_user_id,source,sender_role,audio_report_path) VALUES(?,?,?,'telegram','resident','synthetic/audio.webm')"
	).run(study, resident.id, resident.id);
	assert.deepEqual(removeAccount(db, admin, resident.id), { ok: true });
	const recording = db.prepare('SELECT * FROM study_recordings').get();
	assert.equal(recording.corresponding_resident_id, null);
	assert.equal(recording.sender_user_id, null);
	assert.equal(recording.audio_report_path, 'synthetic/audio.webm');
	assert.equal(db.prepare('SELECT count(*) AS n FROM studies').get().n, 1);
	assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
	const registration = db.prepare('SELECT * FROM telegram_registrations').get();
	assert.equal(registration.step, 'rejected');
	assert.equal(registration.username, null);
	assert.equal(registration.user_id, null);
	assert.deepEqual(db.pragma('foreign_key_check'), []);
});
test('signed/processing users are protected and assigned reviewers cannot be changed to incompatible roles', async (t) => {
	const { db, admin, resident } = fixture(t);
	const study = Number(
		db
			.prepare(
				"INSERT INTO studies(patient_code,exam_date_jalali,exam_time) VALUES('SYNTHETIC','1405-07-18','12:00:00')"
			)
			.run().lastInsertRowid
	);
	db.prepare(
		'INSERT INTO study_recordings(study_id,corresponding_resident_id,resident_signed_by_user_id,resident_checked) VALUES(?,?,?,1)'
	).run(study, resident.id, admin.id);
	assert.throws(() => removeAccount(db, admin, resident.id), { status: 409 });
	await assert.rejects(updateAccount(db, admin, resident.id, { role: 'typist' }), { status: 409 });
	await updateAccount(
		db,
		resident,
		resident.id,
		{ full_name: 'Allowed name edit' },
		{ selfOnly: true }
	);
	db.prepare(
		'UPDATE study_recordings SET resident_checked=0,resident_signed_by_user_id=NULL,processing=1'
	).run();
	assert.throws(() => removeAccount(db, admin, resident.id), { status: 409 });
	db.prepare('UPDATE study_recordings SET processing=0').run();
	await assert.rejects(updateAccount(db, admin, resident.id, { role: 'typist' }), { status: 409 });
});
test('legacy users without credentials require both username and password, while name-only edits work', async (t) => {
	const { db, admin, add } = fixture(t);
	const legacy = add('Legacy Resident', 'resident');
	await updateAccount(db, admin, legacy.id, { full_name: 'Updated Legacy' });
	await assert.rejects(updateAccount(db, admin, legacy.id, { username: 'legacy_user' }), {
		status: 400
	});
	await assert.rejects(updateAccount(db, admin, legacy.id, { password: 'Synthetic-password-42' }), {
		status: 400
	});
	await updateAccount(db, admin, legacy.id, {
		username: 'legacy_user',
		password: 'Synthetic-password-42'
	});
	assert.equal(getAccount(db, legacy.id).username, 'legacy_user');
});
test('startup seed retains renamed administrator credentials and never recreates default login', (t) => {
	const cwd = mkdtempSync(path.join(tmpdir(), 'radiology-seed-test-'));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	mkdirSync(path.join(cwd, 'db'));
	const db = new Database(path.join(cwd, 'db', 'pacs.db'));
	try {
		initializeSchema(db, schema);
		db.prepare("INSERT INTO users(id,full_name,role) VALUES(1,'Renamed Admin','admin')").run();
		db.prepare("INSERT INTO auth_credentials VALUES(1,'renamed_admin','retained-hash')").run();
		const script = fileURLToPath(new URL('../scripts/seed.mjs', import.meta.url));
		for (let run = 0; run < 2; run++) {
			const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
			assert.equal(result.status, 0, result.stderr);
		}
		assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
		assert.deepEqual(db.prepare('SELECT username,password_hash FROM auth_credentials').get(), {
			username: 'renamed_admin',
			password_hash: 'retained-hash'
		});
	} finally {
		db.close();
	}
});

test('contact removal and expanded registration migration preserve accounts, sessions and pending requests idempotently', (t) => {
	const db = new Database(':memory:');
	t.after(() => db.close());
	db.pragma('foreign_keys=ON');
	const old = schema
		.replace(
			'telegram_user_id TEXT UNIQUE',
			'email TEXT, telephone TEXT, telegram_user_id TEXT UNIQUE'
		)
		.replace(
			"role TEXT CHECK (role IN ('resident', 'attending', 'typist'))",
			"role TEXT CHECK (role IN ('resident', 'attending'))"
		);
	db.exec(old);
	db.prepare(
		"INSERT INTO users(id,full_name,role,email,telephone,telegram_user_id) VALUES(42,'Existing Resident','resident','synthetic@example.test','synthetic','200')"
	).run();
	db.prepare("INSERT INTO auth_credentials VALUES(42,'existing_user','retained-hash')").run();
	db.prepare(
		"INSERT INTO sessions(id,user_id,expires_at) VALUES('retained',42,'2099-01-01')"
	).run();
	db.prepare(
		"INSERT INTO telegram_registrations(telegram_user_id,role,username,password_hash,step) VALUES('201','resident','pending_user','pending-hash','pending')"
	).run();
	db.exec(
		"INSERT INTO users(id,full_name,role) VALUES(100,'Previously Deleted','typist'); DELETE FROM users WHERE id=100; INSERT INTO telegram_registrations(id,telegram_user_id) VALUES(100,'deleted'); DELETE FROM telegram_registrations WHERE id=100;"
	);
	db.exec(
		"INSERT INTO studies(id,patient_code,exam_date_jalali,exam_time,corresponding_resident_id) VALUES(1,'SYNTHETIC','1405-07-18','12:00:00',42); INSERT INTO study_recordings(study_id,corresponding_resident_id,resident_signed_by_user_id,resident_checked,audio_report_path) VALUES(1,42,42,1,'synthetic/audio.webm');"
	);
	initializeSchema(db, schema);
	initializeSchema(db, schema);
	assert.deepEqual(
		db
			.prepare('PRAGMA table_info(users)')
			.all()
			.map((c) => c.name),
		['id', 'full_name', 'role', 'telegram_user_id']
	);
	assert.equal(getAccount(db, 42).username, 'existing_user');
	assert.equal(
		db.prepare('SELECT password_hash FROM auth_credentials').get().password_hash,
		'retained-hash'
	);
	assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
	assert.equal(
		db.prepare('SELECT password_hash FROM telegram_registrations').get().password_hash,
		'pending-hash'
	);
	const request = db
		.prepare("INSERT INTO telegram_registrations(telegram_user_id,role) VALUES('202','typist')")
		.run();
	assert.ok(Number(request.lastInsertRowid) > 100);
	assert.ok(
		Number(
			db.prepare("INSERT INTO users(full_name,role) VALUES('New Typist','typist')").run()
				.lastInsertRowid
		) > 100
	);
	assert.equal(
		db.prepare('SELECT corresponding_resident_id FROM studies').get().corresponding_resident_id,
		42
	);
	const recording = db.prepare('SELECT * FROM study_recordings').get();
	assert.equal(recording.corresponding_resident_id, 42);
	assert.equal(recording.resident_signed_by_user_id, 42);
	assert.equal(recording.resident_checked, 1);
	assert.equal(recording.audio_report_path, 'synthetic/audio.webm');
	assert.deepEqual(db.pragma('foreign_key_check'), []);
});
