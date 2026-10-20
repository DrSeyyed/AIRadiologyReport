import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { getSigningDelegates, updateSigningDelegates, getAttendingDelegateIds } from '../src/lib/server/attending-delegates.js';
import { updateAccount, removeAccount } from '../src/lib/server/user-accounts.js';
import { load as loadAccount } from '../src/routes/account/+page.server.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const admin = { id: 1, role: 'admin' };
const attending = { id: 2, role: 'attending' };
const otherAttending = { id: 3, role: 'attending' };
const resident = { id: 4, role: 'resident' };
const otherResident = { id: 5, role: 'resident' };
const typist = { id: 6, role: 'typist' };
function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys=ON');
	initializeSchema(db, schema);
	for (const user of [admin, attending, otherAttending, resident, otherResident, typist])
		db.prepare('INSERT INTO users(id,full_name,role) VALUES(?,?,?)').run(user.id, `Synthetic ${user.id}`, user.role);
	t.after(() => db.close());
	return db;
}

test('each attending owns an independent persistent list with current residents only', t => {
	const db = fixture(t);
	assert.deepEqual(getSigningDelegates(db, attending).resident_ids, []);
	assert.deepEqual(getSigningDelegates(db, attending).residents.map(user => user.id), [4, 5]);
	updateSigningDelegates(db, attending, { resident_ids: [resident.id] });
	assert.deepEqual(getSigningDelegates(db, otherAttending).resident_ids, []);
	updateSigningDelegates(db, otherAttending, { resident_ids: [otherResident.id, resident.id] });
	assert.deepEqual(getAttendingDelegateIds(db, resident.id), [attending.id, otherAttending.id]);
	updateSigningDelegates(db, attending, { resident_ids: [] });
	assert.deepEqual(getAttendingDelegateIds(db, resident.id), [otherAttending.id]);
	assert.deepEqual(getSigningDelegates(db, otherAttending).resident_ids, [resident.id, otherResident.id]);
});

test('only live attending accounts can read or update their own list', t => {
	const db = fixture(t);
	for (const actor of [admin, resident, typist, { ...resident, role: 'attending' }]) {
		assert.throws(() => getSigningDelegates(db, actor), { status: 403 });
		assert.throws(() => updateSigningDelegates(db, actor, { resident_ids: [] }), { status: 403 });
	}
	for (const actor of [null, { id: 999, role: 'attending' }])
		assert.throws(() => updateSigningDelegates(db, actor, { resident_ids: [] }), { status: 401 });
	assert.throws(() => updateSigningDelegates(db, attending, { attending_id: otherAttending.id, resident_ids: [resident.id] }), { status: 400 });
	assert.deepEqual(getSigningDelegates(db, otherAttending).resident_ids, []);
});

test('invalid updates are atomic and cannot grant permission to non-residents', t => {
	const db = fixture(t);
	updateSigningDelegates(db, attending, { resident_ids: [resident.id] });
	for (const input of [null, [], {}, { resident_ids: null }, { resident_ids: '4' },
		{ resident_ids: [4, 4] }, { resident_ids: ['4'] }, { resident_ids: [-1] },
		{ resident_ids: [1.5] }, { resident_ids: [999] }, { resident_ids: [4, admin.id] },
		{ resident_ids: [typist.id] }, { resident_ids: [otherAttending.id] }, { resident_ids: [attending.id] }]) {
		assert.throws(() => updateSigningDelegates(db, attending, input), { status: 400 });
		assert.deepEqual(getSigningDelegates(db, attending).resident_ids, [resident.id]);
	}
});

test('role changes clear delegation links and changing back does not restore them', async t => {
	const db = fixture(t);
	updateSigningDelegates(db, attending, { resident_ids: [resident.id, otherResident.id] });
	await updateAccount(db, resident, resident.id, { full_name: 'Renamed Resident' }, { selfOnly: true });
	assert.deepEqual(getAttendingDelegateIds(db, resident.id), [attending.id]);
	await updateAccount(db, admin, resident.id, { role: 'typist' });
	assert.deepEqual(getSigningDelegates(db, attending).resident_ids, [otherResident.id]);
	await updateAccount(db, admin, resident.id, { role: 'resident' });
	assert.deepEqual(getAttendingDelegateIds(db, resident.id), []);
	await updateAccount(db, admin, attending.id, { role: 'resident' });
	assert.deepEqual(getAttendingDelegateIds(db, otherResident.id), []);
	await updateAccount(db, admin, attending.id, { role: 'attending' });
	assert.deepEqual(getSigningDelegates(db, attending).resident_ids, []);
});

test('account removal cascades only relevant permission links', t => {
	const db = fixture(t);
	updateSigningDelegates(db, attending, { resident_ids: [resident.id, otherResident.id] });
	updateSigningDelegates(db, otherAttending, { resident_ids: [otherResident.id] });
	removeAccount(db, admin, resident.id);
	assert.deepEqual(getSigningDelegates(db, attending).resident_ids, [otherResident.id]);
	removeAccount(db, admin, attending.id);
	assert.deepEqual(getAttendingDelegateIds(db, otherResident.id), [otherAttending.id]);
});

test('migration starts empty despite legacy global grants, preserves data and is repeatable', t => {
	const db = fixture(t);
	db.exec('DROP TABLE attending_signing_delegates; UPDATE users SET can_sign_as_attending=1 WHERE id=4');
	const before = db.prepare('SELECT * FROM users').all();
	initializeSchema(db, schema);
	assert.deepEqual(getSigningDelegates(db, attending).resident_ids, []);
	assert.deepEqual(getAttendingDelegateIds(db, resident.id), []);
	assert.deepEqual(db.prepare('SELECT * FROM users').all(), before);
	updateSigningDelegates(db, attending, { resident_ids: [resident.id] });
	initializeSchema(db, schema);
	assert.deepEqual(getAttendingDelegateIds(db, resident.id), [attending.id]);
	assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('account page loads signing settings only for attendings', async () => {
	for (const actor of [admin, attending, resident, typist]) {
		const requests = [];
		const data = await loadAccount({ locals: { user: actor }, fetch: async url => {
			requests.push(url);
			return new Response(JSON.stringify(url === '/api/account' ? actor : { residents: [], resident_ids: [] }));
		} });
		assert.deepEqual(requests, actor.role === 'attending' ? ['/api/account', '/api/account/signing-delegates'] : ['/api/account']);
		assert.equal(data.signingDelegates !== null, actor.role === 'attending');
	}
});

test('delegate HTTP endpoint rejects visitors, other roles, malformed JSON and owner spoofing', async t => {
	const db = fixture(t);
	globalThis.__attendingDelegatesTestDb = db;
	t.after(() => { delete globalThis.__attendingDelegatesTestDb; });
	const source = readFileSync(new URL('../src/routes/api/account/signing-delegates/+server.js', import.meta.url), 'utf8')
		.replace("import { getDb } from '$lib/server/db.js';", 'const getDb = () => globalThis.__attendingDelegatesTestDb;')
		.replace("'@sveltejs/kit'", JSON.stringify(import.meta.resolve('@sveltejs/kit')))
		.replace("'$lib/server/attending-delegates.js'", JSON.stringify(new URL('../src/lib/server/attending-delegates.js', import.meta.url).href));
	const { GET, PUT } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
	const put = (actor, input) => PUT({ locals: { user: actor }, request: new Request('http://localhost/api/account/signing-delegates', { method: 'PUT', body: input }) });
	assert.equal(GET({ locals: {} }).status, 401);
	assert.equal((await put(null, '{}')).status, 401);
	for (const actor of [admin, resident, typist]) {
		assert.equal(GET({ locals: { user: actor } }).status, 403);
		assert.equal((await put(actor, '{"resident_ids":[4]}')).status, 403);
	}
	assert.equal((await put(attending, '{')).status, 400);
	assert.equal((await put(attending, '{"attending_id":3,"resident_ids":[4]}')).status, 400);
	assert.equal((await put(attending, '{"resident_ids":[4]}')).status, 200);
	assert.deepEqual((await GET({ locals: { user: attending } }).json()).resident_ids, [4]);
	assert.deepEqual((await GET({ locals: { user: otherAttending } }).json()).resident_ids, []);
});
