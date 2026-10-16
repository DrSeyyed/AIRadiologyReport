import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { canUpdateStudyAttention } from '../src/lib/study-permissions.js';
import { getStudyDetail } from '../src/lib/server/studies.js';
import { buildStudyMessage } from '../src/lib/server/telegram.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');

async function loadRoute(relativePath, key) {
	const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8').replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
		const resolved = specifier === '$lib/server/db'
			? `data:text/javascript,${encodeURIComponent(`export function getDb(){return globalThis[${JSON.stringify(key)}]}`)}`
			: specifier.startsWith('$lib/') ? new URL(`../src/lib/${specifier.slice(5)}.js`.replace(/\.js\.js$/, '.js'), import.meta.url).href
				: import.meta.resolve(specifier);
		return `from ${JSON.stringify(resolved)}`;
	});
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function seed(db) {
	db.exec(`INSERT INTO users(id,full_name,role) VALUES(1,'Admin','admin'),(2,'Unassigned resident','resident'),(3,'Unassigned attending','attending'),(4,'Assigned attending','attending');
		INSERT INTO studies(id,patient_code,patient_firstname,exam_date_jalali,exam_time,corresponding_attending_id) VALUES(1,'SYNTHETIC','Patient','1405-07-24','10:00:00',4),(2,'OTHER','Patient','1405-07-24','10:00:00',4);
		INSERT INTO study_recordings(study_id,resident_checked,attending_checked,typist_checked,processing,text_report_path) VALUES(1,1,1,1,1,'uploads/unchanged.txt');`);
}

test('fresh and existing databases get safe attention defaults and retain data on repeated migration', () => {
	for (const existing of [false, true]) {
		const db = new Database(':memory:');
		try {
			db.exec(existing ? schema.replace(/^.*(?:needs_attention|attention_note).*\r?\n/gm, '') : schema);
			seed(db);
			initializeSchema(db, schema);
			assert.deepEqual(db.prepare('SELECT needs_attention,attention_note FROM studies WHERE id=1').get(), { needs_attention: 0, attention_note: '' });
			db.exec("UPDATE studies SET needs_attention=1,attention_note='More history needed' WHERE id=1");
			initializeSchema(db, schema);
			assert.deepEqual(db.prepare('SELECT needs_attention,attention_note FROM studies WHERE id=1').get(), { needs_attention: 1, attention_note: 'More history needed' });
			assert.equal(db.prepare('SELECT count(*) AS n FROM study_recordings').get().n, 1);
			assert.equal(db.prepare('SELECT patient_code FROM studies WHERE id=1').get().patient_code, 'SYNTHETIC');
			assert.deepEqual(db.pragma('foreign_key_check'), []);
		} finally { db.close(); }
	}
});

test('attention API blocks guests, typists and unknown roles before body or database access', async () => {
	const { PATCH } = await loadRoute('../src/routes/api/studies/[id]/attention/+server.js');
	for (const [user, status] of [[null, 401], [{ role: 'typist' }, 403], [{ role: 'unknown' }, 403]]) {
		assert.equal(canUpdateStudyAttention(user), false);
		const response = await PATCH({ locals: { user }, params: { id: '1' }, request: { json() { throw new Error('Body consumed'); } } });
		assert.equal(response.status, status);
	}
});

test('all clinicians can update any study independently of assignments, processing or signatures; clearing retains notes', async (t) => {
	const db = new Database(':memory:'); db.exec(schema); seed(db);
	const key = `studyAttention_${randomUUID()}`; globalThis[key] = db;
	t.after(() => { delete globalThis[key]; db.close(); });
	const { PATCH } = await loadRoute('../src/routes/api/studies/[id]/attention/+server.js', key);
	const before = db.prepare('SELECT * FROM study_recordings').all();
	for (const [id, role] of [[1, 'admin'], [2, 'resident'], [3, 'attending']]) {
		assert.equal(canUpdateStudyAttention({ role }), true);
		for (const checked of [true, false]) {
			const response = await PATCH({ locals: { user: { id, role } }, params: { id: '1' }, request: { json: async () => ({ needs_attention: checked, attention_note: '  Repeat imaging; <more history> & details  ' }) } });
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { needs_attention: Number(checked), attention_note: 'Repeat imaging; <more history> & details', notification_warning: null });
			const detail = getStudyDetail(db, 1);
			assert.equal(detail.needs_attention, Number(checked));
			assert.equal(detail.attention_note, 'Repeat imaging; <more history> & details');
		}
	}
	assert.deepEqual(db.prepare('SELECT * FROM study_recordings').all(), before);
	assert.equal(getStudyDetail(db, 2).attention_note, '');
	const { GET } = await loadRoute('../src/routes/api/studies/+server.js', key);
	const listing = await GET({ locals: { user: { role: 'typist' } }, url: new URL('http://localhost/api/studies') });
	const row = (await listing.json()).rows.find(study => study.id === 1);
	assert.equal(row.needs_attention, 0);
	assert.equal(row.attention_note, 'Repeat imaging; <more history> & details');
});

test('attention API validates IDs, JSON, checkbox and note types and length without partial updates', async (t) => {
	const db = new Database(':memory:'); db.exec(schema); seed(db);
	const key = `studyAttentionValidation_${randomUUID()}`; globalThis[key] = db;
	t.after(() => { delete globalThis[key]; db.close(); });
	const { PATCH } = await loadRoute('../src/routes/api/studies/[id]/attention/+server.js', key);
	const call = (body, id = '1') => PATCH({ locals: { user: { role: 'resident' } }, params: { id }, request: { json: async () => body } });
	for (const body of [null, [], {}, { needs_attention: 1, attention_note: '' }, { needs_attention: 'false', attention_note: '' }, { needs_attention: true, attention_note: null }, { needs_attention: true, attention_note: 'a'.repeat(301) }])
		assert.equal((await call(body)).status, 400);
	for (const id of ['0', '-1', '1.5', 'NaN', '9007199254740992'])
		assert.equal((await call({ needs_attention: true, attention_note: '' }, id)).status, 400);
	assert.equal((await PATCH({ locals: { user: { role: 'admin' } }, params: { id: '1' }, request: { json: async () => { throw new SyntaxError('Invalid JSON'); } } })).status, 400);
	assert.equal((await call({ needs_attention: true, attention_note: '' }, '999')).status, 404);
	assert.deepEqual(db.prepare('SELECT needs_attention,attention_note FROM studies WHERE id=1').get(), { needs_attention: 0, attention_note: '' });
	assert.equal((await call({ needs_attention: true, attention_note: 'a'.repeat(300) })).status, 200);
	assert.equal((await call({ needs_attention: false, attention_note: '' })).status, 200);
});

test('Telegram messages show attention status and safely distinguish retained notes from active requests', () => {
	const active = buildStudyMessage({ needs_attention: 1, attention_note: 'Repeat <imaging> & more history\nConfirm symptoms' });
	assert.match(active, /Needs attention: ⚠️ Yes\nAttention note: Repeat &lt;imaging&gt; &amp; more history\nConfirm symptoms/);
	const cleared = buildStudyMessage({ needs_attention: 0, attention_note: 'More history' });
	assert.match(cleared, /Needs attention: No\nPrevious attention note \(reference\): More history/);
	assert.doesNotMatch(cleared, /⚠️ Yes/);
	assert.match(buildStudyMessage({}), /Needs attention: No/);
	assert.doesNotMatch(buildStudyMessage({}), /Attention note|Previous attention note/);
	assert.match(buildStudyMessage({ needs_attention: 1 }), /Needs attention: ⚠️ Yes/);
	assert.doesNotMatch(buildStudyMessage({ needs_attention: 1 }), /Attention note:/);
});

test('saving attention edits the original Telegram message; Telegram failure preserves the save with a warning', async (t) => {
	const db = new Database(':memory:'); db.exec(schema); seed(db);
	const key = `studyAttentionTelegram_${randomUUID()}`; globalThis[key] = db;
	const previous = { TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID };
	process.env.TELEGRAM_BOT_TOKEN = 'synthetic-attention-token';
	process.env.TELEGRAM_CHAT_ID = '-10020';
	t.after(() => {
		delete globalThis[key]; db.close();
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	const requests = [];
	let failure = false;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		requests.push({ url, body: JSON.parse(options.body) });
		return { json: async () => failure ? { ok: false, error_code: 403, description: 'Synthetic Telegram failure' } : { ok: true, result: { message_id: 77 } } };
	});
	const { PATCH } = await loadRoute('../src/routes/api/studies/[id]/attention/+server.js', key);
	const call = (checked, note) => PATCH({ locals: { user: { id: 2, role: 'resident' } }, params: { id: '1' }, request: { json: async () => ({ needs_attention: checked, attention_note: note }) } });
	db.exec("UPDATE studies SET telegram_message_id='77' WHERE id=1");
	for (const checked of [true, false]) {
		const response = await call(checked, 'Repeat <imaging> & more history');
		assert.equal(response.status, 200);
		assert.equal((await response.json()).notification_warning, null);
	}
	assert.equal(requests.length, 2);
	for (const request of requests) {
		assert.equal(request.url, 'https://api.telegram.org/botsynthetic-attention-token/editMessageText');
		assert.equal(request.body.message_id, '77');
		assert.equal(request.body.chat_id, '-10020');
		assert.equal(request.body.parse_mode, 'HTML');
		assert.match(request.body.text, /Repeat &lt;imaging&gt; &amp; more history/);
		assert.match(request.body.text, /Reports: 1/);
		assert.match(request.body.text, /Signed: Resident 1 • Attending 1 • Typist \(printed\) 1/);
		assert.doesNotMatch(request.body.text, /uploads\/unchanged.txt/);
	}
	assert.match(requests[0].body.text, /Needs attention: ⚠️ Yes\nAttention note:/);
	assert.match(requests[1].body.text, /Needs attention: No\nPrevious attention note \(reference\):/);
	await call(false, '');
	assert.doesNotMatch(requests[2].body.text, /Attention note:|Previous attention note/);
	failure = true;
	const failed = await call(true, 'Saved despite notification failure');
	assert.equal(failed.status, 200);
	assert.equal((await failed.json()).notification_warning, 'Attention saved, but Telegram update failed.');
	assert.deepEqual(db.prepare('SELECT needs_attention,attention_note FROM studies WHERE id=1').get(), { needs_attention: 1, attention_note: 'Saved despite notification failure' });
	db.exec('UPDATE studies SET telegram_message_id=NULL WHERE id=1');
	const withoutMessage = await call(false, 'No group message yet');
	assert.equal((await withoutMessage.json()).notification_warning, null);
	assert.equal(requests.length, 4);
});
