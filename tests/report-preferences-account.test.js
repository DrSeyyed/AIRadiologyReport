import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { load } from '../src/routes/account/+page.server.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const attending = { id: 1, role: 'attending', full_name: 'Synthetic Attending' };
const otherAttending = { id: 2, role: 'attending', full_name: 'Synthetic Other' };
const admin = { id: 3, role: 'admin', full_name: 'Synthetic Admin' };
const resident = { id: 4, role: 'resident', full_name: 'Synthetic Resident' };
const typist = { id: 5, role: 'typist', full_name: 'Synthetic Typist' };
const actors = [attending, otherAttending, admin, resident, typist];
const endpoint = 'http://localhost/api/account/report-preferences';

const routeSource = readFileSync(
	new URL('../src/routes/api/account/report-preferences/+server.js', import.meta.url),
	'utf8'
)
	.replace(
		"import { getDb } from '$lib/server/db.js';",
		'const getDb = () => globalThis.__reportPreferencesAccountTestDb;'
	)
	.replace("'@sveltejs/kit'", JSON.stringify(import.meta.resolve('@sveltejs/kit')))
	.replace(
		"'$lib/server/report-preferences.js'",
		JSON.stringify(new URL('../src/lib/server/report-preferences.js', import.meta.url).href)
	);
const { GET, PATCH } = await import(
	`data:text/javascript;base64,${Buffer.from(routeSource).toString('base64')}`
);

function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys=ON');
	initializeSchema(db, schema);
	for (const actor of actors) {
		db.prepare('INSERT INTO users(id,full_name,role) VALUES(?,?,?)').run(
			actor.id,
			actor.full_name,
			actor.role
		);
	}
	globalThis.__reportPreferencesAccountTestDb = db;
	t.after(() => {
		delete globalThis.__reportPreferencesAccountTestDb;
		db.close();
	});
	return db;
}

function patch(actor, input) {
	return PATCH({
		locals: { user: actor },
		request: new Request(endpoint, { method: 'PATCH', body: input })
	});
}

async function get(actor) {
	return GET({ locals: { user: actor } });
}

test('report preference endpoint requires authentication before reading bodies or the database', async () => {
	assert.equal((await GET({ locals: {} })).status, 401);
	assert.equal((await patch(null, '{')).status, 401);
	assert.equal((await patch(undefined, '{"english_variant":"american"}')).status, 401);
});

test('only fresh database attending roles can read and save preferences', async (t) => {
	const db = fixture(t);
	for (const actor of [admin, resident, typist]) {
		for (const sessionRole of [actor.role, 'attending']) {
			const staleActor = { ...actor, role: sessionRole };
			assert.equal((await get(staleActor)).status, 403);
			assert.equal((await patch(staleActor, '{"english_variant":"american"}')).status, 403);
			assert.equal((await patch(staleActor, '{')).status, 403);
		}
	}
	db.prepare("UPDATE users SET role='resident' WHERE id=?").run(attending.id);
	assert.equal((await get(attending)).status, 403);
	assert.equal((await patch(attending, '{"english_variant":"american"}')).status, 403);
	db.prepare("UPDATE users SET role='attending' WHERE id=?").run(resident.id);
	assert.equal((await get(resident)).status, 200);
	assert.equal((await patch(resident, '{"english_variant":"american"}')).status, 200);
	db.prepare('DELETE FROM users WHERE id=?').run(otherAttending.id);
	assert.equal((await get(otherAttending)).status, 401);
	assert.equal((await patch(otherAttending, '{"english_variant":"british"}')).status, 401);
});

test('preferences default to British and PATCH persists only the signed-in attending choice', async (t) => {
	const db = fixture(t);
	assert.deepEqual(await (await get(attending)).json(), { english_variant: 'british' });
	const response = await patch(attending, '{"english_variant":"american"}');
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { english_variant: 'american' });
	assert.deepEqual(await (await get(attending)).json(), { english_variant: 'american' });
	assert.deepEqual(await (await get(otherAttending)).json(), { english_variant: 'british' });
	assert.deepEqual(
		db.prepare('SELECT user_id,english_variant FROM attending_report_preferences').all(),
		[{ user_id: attending.id, english_variant: 'american' }]
	);
	assert.equal((await patch(attending, '{"english_variant":"british"}')).status, 200);
	assert.deepEqual(await (await get(attending)).json(), { english_variant: 'british' });
	assert.equal(db.prepare('SELECT count(*) AS n FROM attending_report_preferences').get().n, 1);
});

test('PATCH strictly rejects malformed JSON, non-objects, invalid choices and every extra field', async (t) => {
	fixture(t);
	await patch(attending, '{"english_variant":"american"}');
	const invalidInputs = [
		'',
		'{',
		'null',
		'[]',
		'[{"english_variant":"british"}]',
		'true',
		'42',
		'"british"',
		'{}',
		'{"english_variant":null}',
		'{"english_variant":true}',
		'{"english_variant":1}',
		'{"english_variant":[]}',
		'{"english_variant":{}}',
		'{"english_variant":""}',
		'{"english_variant":"British"}',
		'{"english_variant":"british "}',
		'{"english_variant":"french"}',
		'{"english_variant":"british","user_id":2}',
		'{"english_variant":"british","attending_id":2}',
		'{"english_variant":"british","instructions":"Synthetic custom text"}',
		'{"english_variant":"british","role":"attending"}',
		'{"english_variant":"british","__proto__":{}}',
		'{"english_variant":"british","constructor":{}}'
	];
	for (const input of invalidInputs) {
		const response = await patch(attending, input);
		assert.equal(response.status, 400, input);
		assert.equal(typeof (await response.json()).error, 'string');
		assert.deepEqual(await (await get(attending)).json(), { english_variant: 'american' });
		assert.deepEqual(await (await get(otherAttending)).json(), { english_variant: 'british' });
	}
});

test('database failures have generic error responses without leaking internal details', async (t) => {
	const db = fixture(t);
	db.exec('DROP TABLE attending_report_preferences');
	for (const response of [
		await get(attending),
		await patch(attending, '{"english_variant":"american"}')
	]) {
		assert.equal(response.status, 500);
		assert.deepEqual(await response.json(), { error: 'Unable to manage report preferences' });
	}
	db.exec('DROP TABLE users');
	assert.equal((await get(attending)).status, 500);
});

test('Account load fetches report preferences and delegates only for the current attending account', async () => {
	for (const actor of actors) {
		const requests = [];
		const preferences = { english_variant: 'american' };
		const delegates = { residents: [], resident_ids: [] };
		const data = await load({
			locals: { user: { ...actor, role: actor.role === 'attending' ? 'resident' : 'attending' } },
			fetch: async (url) => {
				requests.push(url);
				return new Response(
					JSON.stringify(
						url === '/api/account'
							? actor
							: url === '/api/account/signing-delegates'
								? delegates
								: preferences
					)
				);
			}
		});
		assert.deepEqual(
			requests,
			actor.role === 'attending'
				? ['/api/account', '/api/account/signing-delegates', '/api/account/report-preferences']
				: ['/api/account']
		);
		assert.deepEqual(data.account, actor);
		assert.deepEqual(data.reportPreferences, actor.role === 'attending' ? preferences : null);
		assert.deepEqual(data.signingDelegates, actor.role === 'attending' ? delegates : null);
	}
});

test('Account load rejects visitors and reports preference load failures', async () => {
	await assert.rejects(load({ locals: {}, fetch: () => assert.fail('Unexpected fetch') }), {
		status: 302
	});
	await assert.rejects(
		load({
			locals: { user: attending },
			fetch: async (url) =>
				new Response(JSON.stringify(url === '/api/account' ? attending : {}), {
					status: url === '/api/account/report-preferences' ? 500 : 200
				})
		}),
		{ status: 500, body: { message: 'Unable to load report preferences' } }
	);
});

test('Account UI compiles, renders attending-only English choices and preserves account and delegate fields', async () => {
	const source = readFileSync(
		new URL('../src/routes/account/+page.svelte', import.meta.url),
		'utf8'
	);
	const compiled = compile(source, { filename: 'Account.svelte', generate: 'server' });
	assert.deepEqual(
		compiled.warnings.filter((warning) => warning.code.startsWith('a11y')),
		[]
	);
	const serverSource = compiled.js.code
		.replace(
			/import \{ invalidateAll \} from ['"]\$app\/navigation['"];?/,
			'const invalidateAll = async () => {};'
		)
		.replace(/(['"])(svelte\/[^'"]+)\1/g, (_, quote, specifier) =>
			JSON.stringify(import.meta.resolve(specifier))
		);
	const { default: Account } = await import(
		`data:text/javascript;base64,${Buffer.from(serverSource).toString('base64')}`
	);
	for (const actor of actors) {
		const html = render(Account, {
			props: {
				data: {
					account: actor,
					signingDelegates: { residents: [], resident_ids: [] },
					reportPreferences: null
				}
			}
		}).body;
		assert.ok(html.includes('Full name'));
		assert.ok(html.includes('Username'));
		assert.ok(html.includes('New password (optional)'));
		assert.equal(html.includes('Report English'), actor.role === 'attending');
		assert.equal(html.includes('Residents who may sign for me'), actor.role === 'attending');
		if (actor.role === 'attending') {
			assert.ok(html.includes('British English'));
			assert.ok(html.includes('American English'));
			assert.match(html, /value="british"[^>]*checked/);
			assert.ok(html.includes('Existing reports are unchanged.'));
			assert.ok(html.includes('future generated reports for studies assigned to you'));
			assert.ok(html.includes('role="status"'));
			assert.ok(html.includes('aria-describedby="report-english-description"'));
		}
	}
	const html = render(Account, {
		props: {
			data: {
				account: attending,
				signingDelegates: null,
				reportPreferences: { english_variant: 'american' }
			}
		}
	}).body;
	assert.match(html, /value="american"[^>]*checked/);
});
