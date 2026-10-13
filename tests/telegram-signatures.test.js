import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { insertStudy } from '../src/lib/server/studies.js';
import { appendRecording, configureRecording } from '../src/lib/server/recordings.js';
import { saveRecordingReport } from '../src/lib/server/recording-processing.js';

async function fixture(t, messageId = '77') {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	initializeSchema(db, readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
	db.exec("INSERT INTO modalities VALUES(1,'CT','CT'); INSERT INTO exam_types VALUES(1,'BRAIN_WO','Brain'); INSERT INTO users(id,full_name,role) VALUES(1,'Admin','admin'),(2,'Resident','resident'),(3,'Attending','attending'),(4,'Typist','typist');");
	const directory = mkdtempSync(join(tmpdir(), 'telegram-signatures-'));
	const key = `telegramSignatureDb_${randomUUID()}`;
	globalThis[key] = db;
	t.after(() => {
		delete globalThis[key];
		db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	const studyId = insertStudy(db, {
		patient_code: '00020',
		patient_firstname: 'Synthetic',
		exam_date_jalali: '1405-07-21',
		exam_time: '10:00',
		corresponding_attending_id: 3
	});
	db.prepare('UPDATE studies SET telegram_message_id = ? WHERE id = ?').run(messageId, studyId);
	const recording = appendRecording(db, studyId, null);
	configureRecording(db, studyId, recording.id, {
		modality_id: 1,
		exam_type_id: 1,
		corresponding_resident_id: 2
	});
	saveRecordingReport(db, recording.id, 'Synthetic report text', directory);
	const url = new URL('../src/lib/server/recording-http.js', import.meta.url);
	const source = readFileSync(url, 'utf8').replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
		const resolved = specifier === '$lib/server/db'
			? `data:text/javascript,${encodeURIComponent(`export function getDb(){return globalThis[${JSON.stringify(key)}]}`)}`
			: specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier);
		return `from ${JSON.stringify(resolved)}`;
	});
	const { sign } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
	const requests = [];
	const previous = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
	process.env.TELEGRAM_BOT_TOKEN = 'synthetic-test-token';
	process.env.TELEGRAM_CHAT_ID = '-10020';
	t.after(() => {
		for (const [name, value] of [['TELEGRAM_BOT_TOKEN', previous.token], ['TELEGRAM_CHAT_ID', previous.chat]]) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		requests.push({ url, body: JSON.parse(options.body) });
		return { json: async () => ({ ok: true, result: { message_id: Number(messageId) } }) };
	});
	const change = async (role, checked = true, user = { id: { resident: 2, attending: 3, typist: 4 }[role], role }) => {
		const response = await sign({
			params: { id: String(studyId), recordingId: String(recording.id) },
			locals: { user },
			request: new Request('http://localhost/sign', { method: 'POST', body: JSON.stringify({ role, checked }) })
		});
		assert.equal(response.status, 200);
		return response.json();
	};
	return { change, requests };
}

test('all signatures and attending re-signs edit the original Telegram study message without posting reports', async (t) => {
	const { change, requests } = await fixture(t);
	await change('resident');
	await change('attending');
	await change('attending');
	await change('typist');
	const unsigned = await change('attending', false);
	assert.equal(unsigned.typist_checked, 0);
	await change('attending');
	await change('resident', false, { id: 1, role: 'admin' });
	await change('resident');
	await change('attending');
	assert.equal(requests.length, 9);
	for (const request of requests) {
		assert.equal(request.url, 'https://api.telegram.org/botsynthetic-test-token/editMessageText');
		assert.equal(request.body.message_id, '77');
		assert.equal(request.body.chat_id, '-10020');
		assert.match(request.body.text, /Study 00020/);
		assert.doesNotMatch(request.body.text, /Register privately|Reply to this study|Synthetic report text|Final report signed/);
	}
	assert.match(requests[1].body.text, /Attending ✅/);
	assert.match(requests[3].body.text, /Typist \/ printed ✅/);
	assert.match(requests[4].body.text, /Attending ⬜.*Typist \/ printed ⬜/);
});

test('signing a study without a Telegram message does not create a new group message', async (t) => {
	const { change, requests } = await fixture(t, null);
	await change('resident');
	await change('attending');
	assert.equal(requests.length, 0);
});
