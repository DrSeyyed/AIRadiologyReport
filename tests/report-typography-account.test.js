import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { DEFAULT_REPORT_TYPOGRAPHY, reportFonts } from '../src/lib/report-copy.js';
import {
	getUserReportTypography,
	setUserReportTypography
} from '../src/lib/server/report-typography.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8').replace(
	/\r\n/g,
	'\n'
);
const actors = ['admin', 'attending', 'resident', 'typist'].map((role, index) => ({
	id: index + 1,
	role,
	full_name: `Synthetic ${role}`
}));
const endpoint = 'http://localhost/api/account/report-typography';
const routeSource = readFileSync(
	new URL('../src/routes/api/account/report-typography/+server.js', import.meta.url),
	'utf8'
)
	.replace(
		"import { getDb } from '$lib/server/db.js';",
		'const getDb = () => globalThis.__reportTypographyAccountTestDb;'
	)
	.replace("'@sveltejs/kit'", JSON.stringify(import.meta.resolve('@sveltejs/kit')))
	.replace(
		"'$lib/report-copy.js'",
		JSON.stringify(new URL('../src/lib/report-copy.js', import.meta.url).href)
	)
	.replace(
		"'$lib/server/report-typography.js'",
		JSON.stringify(new URL('../src/lib/server/report-typography.js', import.meta.url).href)
	);
const { GET, PATCH } = await import(
	`data:text/javascript;base64,${Buffer.from(routeSource).toString('base64')}`
);

function addUsers(db) {
	for (const actor of actors) {
		db.prepare('INSERT INTO users(id,full_name,role) VALUES(?,?,?)').run(
			actor.id,
			actor.full_name,
			actor.role
		);
	}
}

function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys=ON');
	initializeSchema(db, schema);
	addUsers(db);
	globalThis.__reportTypographyAccountTestDb = db;
	t.after(() => {
		delete globalThis.__reportTypographyAccountTestDb;
		db.close();
	});
	return db;
}

function get(actor) {
	return GET({ locals: { user: actor } });
}

function patch(actor, input) {
	return PATCH({
		locals: { user: actor },
		request: new Request(endpoint, { method: 'PATCH', body: input })
	});
}

const invalidValues = [
	null,
	[],
	true,
	42,
	'Arial',
	{},
	{ font: 'Arial' },
	{ size: 11 },
	...[
		'',
		'Helvetica',
		'arial',
		'Arial ',
		'Arial; color:red',
		'url(https://example.invalid/font)',
		'Arial, sans-serif'
	].map((font) => ({ font, size: 11 })),
	...[null, true, [], {}, 0, 5.99, 72.01, -1, '11', '', '11pt'].map((size) => ({
		font: 'Arial',
		size
	})),
	...[null, true, [], {}, 42].map((font) => ({ font, size: 11 })),
	...['user_id', 'id', 'role', 'font_size', 'english_variant', 'constructor', '__proto__'].map(
		(key) => ({ font: 'Arial', size: 11, [key]: 2 })
	)
];

test('unauthenticated requests do not access the database or read PATCH bodies', async () => {
	globalThis.__reportTypographyAccountTestDb = {
		prepare: () => assert.fail('Unexpected database access')
	};
	try {
		assert.equal((await GET({ locals: {} })).status, 401);
		assert.equal(
			(
				await PATCH({
					locals: {},
					request: { json: () => assert.fail('Unexpected body read') }
				})
			).status,
			401
		);
	} finally {
		delete globalThis.__reportTypographyAccountTestDb;
	}
});

test('every fresh account role can get and save its own typography independently', async (t) => {
	const db = fixture(t);
	for (const [index, actor] of actors.entries()) {
		const response = await get({ ...actor, role: 'stale-role' });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { font: 'Times New Roman', size: 11 });
		assert.equal(db.prepare('SELECT count(*) AS n FROM user_report_typography').get().n, index);
		const value = { font: reportFonts[index].name, size: 10.5 + index };
		const saved = await patch(actor, JSON.stringify(value));
		assert.equal(saved.status, 200);
		assert.deepEqual(await saved.json(), value);
		assert.deepEqual(await (await get(actor)).json(), value);
	}
	assert.equal(db.prepare('SELECT count(*) AS n FROM user_report_typography').get().n, 4);
	const first = getUserReportTypography(db, actors[0].id);
	await patch(actors[1], JSON.stringify({ font: 'Verdana', size: 17.25 }));
	assert.deepEqual(getUserReportTypography(db, actors[0].id), first);
	assert.equal(db.prepare('SELECT count(*) AS n FROM user_report_typography').get().n, 4);
});

test('deleted sessions are unauthorized before body parsing and cannot create preferences', async (t) => {
	const db = fixture(t);
	const actor = actors[0];
	setUserReportTypography(db, actor.id, { font: 'Arial', size: 12 });
	db.prepare('DELETE FROM users WHERE id=?').run(actor.id);
	assert.equal((await get(actor)).status, 401);
	assert.equal(
		(
			await PATCH({
				locals: { user: actor },
				request: { json: () => assert.fail('Deleted session body read') }
			})
		).status,
		401
	);
	assert.equal(db.prepare('SELECT count(*) AS n FROM user_report_typography').get().n, 0);
	assert.throws(() => setUserReportTypography(db, actor.id, { font: 'Arial', size: 12 }), {
		status: 401
	});
});

test('PATCH rejects malformed JSON, arbitrary fonts, invalid sizes and other-account fields without writes', async (t) => {
	const db = fixture(t);
	const saved = { font: 'Cambria', size: 11.5 };
	setUserReportTypography(db, actors[0].id, saved);
	for (const input of [
		'',
		'{',
		'NaN',
		'{"font":"Arial","size":1e999}',
		...invalidValues.map((value) => JSON.stringify(value))
	]) {
		const response = await patch(actors[0], input);
		assert.equal(response.status, 400, input);
		assert.equal(typeof (await response.json()).error, 'string');
		assert.deepEqual(getUserReportTypography(db, actors[0].id), saved);
		assert.deepEqual(getUserReportTypography(db, actors[1].id), DEFAULT_REPORT_TYPOGRAPHY);
		assert.equal(db.prepare('SELECT count(*) AS n FROM user_report_typography').get().n, 1);
	}
});

test('helper uses shared strict validation and accepts every catalog font and numeric boundary', (t) => {
	const db = fixture(t);
	for (const value of [
		...invalidValues,
		...[NaN, Infinity, -Infinity].map((size) => ({ font: 'Arial', size }))
	]) {
		assert.throws(() => setUserReportTypography(db, actors[0].id, value), { status: 400 });
	}
	for (const { name: font } of reportFonts) {
		for (const size of [6, 11, 11.125, 72]) {
			assert.deepEqual(setUserReportTypography(db, actors[0].id, { font, size }), { font, size });
		}
	}
	const defaults = getUserReportTypography(db, actors[1].id);
	defaults.font = 'changed';
	assert.deepEqual(getUserReportTypography(db, actors[1].id), DEFAULT_REPORT_TYPOGRAPHY);
});

test('database CHECK constraints match all supported fonts, reject invalid values and enforce user ownership', (t) => {
	const db = fixture(t);
	const insert = db.prepare(
		'INSERT INTO user_report_typography(user_id,font,font_size) VALUES(?,?,?)'
	);
	for (const { name: font } of reportFonts) {
		insert.run(actors[0].id, font, 11.5);
		db.prepare('DELETE FROM user_report_typography').run();
	}
	for (const [font, size] of [
		['Unknown', 11],
		['Arial; color:red', 11],
		['Arial', 5.99],
		['Arial', 72.01],
		['Arial', null],
		[null, 11],
		['Arial', '11pt'],
		['Arial', Infinity]
	]) {
		assert.throws(() => insert.run(actors[0].id, font, size), /constraint failed/i);
	}
	assert.throws(() => insert.run(999, 'Arial', 11), /FOREIGN KEY constraint failed/);
	insert.run(actors[0].id, 'Arial', 11);
	assert.throws(() => insert.run(actors[0].id, 'Arial', 11), /UNIQUE constraint failed/);
	db.prepare('DELETE FROM users WHERE id=?').run(actors[0].id);
	assert.equal(db.prepare('SELECT count(*) AS n FROM user_report_typography').get().n, 0);
});

test('database failures return generic errors without internal details', async (t) => {
	const db = fixture(t);
	db.exec('DROP TABLE user_report_typography');
	for (const response of [
		await get(actors[0]),
		await patch(actors[0], '{"font":"Arial","size":11}')
	]) {
		assert.equal(response.status, 500);
		assert.deepEqual(await response.json(), { error: 'Unable to manage report typography' });
	}
	db.exec('DROP TABLE users');
	const response = await get(actors[0]);
	assert.equal(response.status, 500);
	assert.deepEqual(await response.json(), { error: 'Unable to manage report typography' });
});

test('schema upgrades and repeated initialization preserve preferences, clinical data and English settings', () => {
	const db = new Database(':memory:');
	try {
		const oldSchema = schema.replace(
			/CREATE TABLE IF NOT EXISTS user_report_typography \([\s\S]*?\n\);\n/,
			''
		);
		assert.notEqual(oldSchema, schema);
		initializeSchema(db, oldSchema);
		addUsers(db);
		db.exec(`INSERT INTO attending_report_preferences(user_id,english_variant) VALUES(2,'american');
			INSERT INTO studies(id,patient_code,patient_fullname,exam_date_jalali,exam_time)
			VALUES(1,'SYNTHETIC','Synthetic Patient','1405-08-06','12:00:00');
			INSERT INTO study_recordings(study_id,audio_report_path,text_report_path,resident_checked,
				attending_checked,typist_checked,resident_signed_by_user_id,attending_signed_by_user_id,
				typist_signed_by_user_id,resident_signed_at,attending_signed_at,typist_signed_at)
			VALUES(1,'synthetic-audio.webm','synthetic-report.md',1,1,1,3,2,4,
				'2026-10-28','2026-10-28','2026-10-28');`);
		const before = {
			studies: db.prepare('SELECT * FROM studies').all(),
			recordings: db.prepare('SELECT * FROM study_recordings').all(),
			english: db.prepare('SELECT * FROM attending_report_preferences').all(),
			users: db.prepare('SELECT * FROM users').all()
		};
		initializeSchema(db, schema);
		assert.equal(db.prepare('SELECT count(*) AS n FROM user_report_typography').get().n, 0);
		assert.deepEqual(getUserReportTypography(db, actors[0].id), DEFAULT_REPORT_TYPOGRAPHY);
		const value = { font: 'Georgia', size: 13.75 };
		setUserReportTypography(db, actors[0].id, value);
		initializeSchema(db, schema);
		initializeSchema(db, schema);
		assert.deepEqual(getUserReportTypography(db, actors[0].id), value);
		assert.deepEqual(db.prepare('SELECT * FROM studies').all(), before.studies);
		assert.deepEqual(db.prepare('SELECT * FROM study_recordings').all(), before.recordings);
		assert.deepEqual(
			db.prepare('SELECT * FROM attending_report_preferences').all(),
			before.english
		);
		assert.deepEqual(db.prepare('SELECT * FROM users').all(), before.users);
		assert.deepEqual(db.pragma('foreign_key_check'), []);
	} finally {
		db.close();
	}
});

test('saved typography persists after reopening a real SQLite database', () => {
	const file = new URL(`../.report-typography-test-${randomUUID()}.sqlite`, import.meta.url);
	let db;
	try {
		db = new Database(fileURLToPath(file));
		initializeSchema(db, schema);
		addUsers(db);
		setUserReportTypography(db, actors[0].id, { font: 'Tahoma', size: 10.25 });
		db.close();
		db = new Database(fileURLToPath(file));
		assert.deepEqual(getUserReportTypography(db, actors[0].id), { font: 'Tahoma', size: 10.25 });
		assert.deepEqual(getUserReportTypography(db, actors[1].id), DEFAULT_REPORT_TYPOGRAPHY);
	} finally {
		if (db?.open) db.close();
		rmSync(file, { force: true });
	}
});
