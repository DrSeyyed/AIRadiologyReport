import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { transcribeRecording } from '../src/lib/server/recording-processing.js';
import { setTranscriptionSettings } from '../src/lib/server/transcription-settings.js';

function fixture(t) {
	const db = new Database(':memory:');
	db.exec(readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
	const directory = mkdtempSync(join(tmpdir(), 'transcription-preview-'));
	const audio = join(directory, 'audio.ogg'), report = join(directory, 'report.txt');
	writeFileSync(audio, 'Synthetic audio'); writeFileSync(report, 'Existing signed report');
	db.exec("INSERT INTO studies(id,patient_code,exam_date_jalali,exam_time) VALUES(1,'SYNTHETIC','1405-07-18','10:00:00')");
	db.prepare('INSERT INTO study_recordings(id,study_id,audio_report_path,text_report_path,resident_checked,attending_checked,typist_checked) VALUES(1,1,?,?,1,1,1)').run(audio, report);
	setTranscriptionSettings(db, { provider: 'openai', model: 'gpt-4o-transcribe' });
	t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
	return { db, directory, audio, report };
}

async function http(databaseKey) {
	const url = new URL('../src/lib/server/recording-http.js', import.meta.url);
	const source = readFileSync(url, 'utf8').replace(/from (['"])([^'"]+)\1/g, (_statement, _quote, specifier) => {
		const resolved = specifier === '$lib/server/db'
			? `data:text/javascript,${encodeURIComponent(`export function getDb(){return globalThis[${JSON.stringify(databaseKey)}]}`)}`
			: specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier);
		return `from ${JSON.stringify(resolved)}`;
	});
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function apiKey(t) {
	const before = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = 'synthetic-test-key';
	t.after(() => { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; });
}

test('admin preview uses transcription settings and all audio parts without report generation or persistence', async t => {
	const { db, directory, audio, report } = fixture(t); apiKey(t);
	db.prepare('INSERT INTO application_settings(key,value) VALUES(?,?)').run('report_generation_settings', JSON.stringify({ mode: 'direct_audio', provider: 'openai', model: 'gpt-audio-1.5' }));
	const second = join(directory, 'second.ogg'); writeFileSync(second, 'Second synthetic part');
	db.prepare('INSERT INTO recording_audio_parts(recording_id,audio_report_path) VALUES(1,?)').run(second);
	const before = db.prepare('SELECT * FROM study_recordings').get();
	const files = readdirSync(directory);
	let requests = 0;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
		assert.equal(options.body.get('model'), 'gpt-4o-transcribe');
		assert.equal(options.body.get('file').name, requests ? 'second.ogg' : 'audio.ogg');
		requests++;
		return Response.json({ text: requests === 1 ? 'متن فارسی T2' : 'Second part' });
	});
	const key = `transcription_${randomUUID()}`; globalThis[key] = db;
	t.after(() => { delete globalThis[key]; });
	const { transcribeOnly } = await http(key);
	const result = await transcribeOnly({ locals: { user: { id: 1, role: 'admin' } }, params: { id: '1', recordingId: '1' } });
	assert.equal(result.status, 200);
	assert.equal(result.headers.get('cache-control'), 'private, no-store');
	assert.deepEqual(await result.json(), { ok: true, text: 'متن فارسی T2\nSecond part' });
	assert.equal(requests, 2);
	assert.deepEqual(db.prepare('SELECT * FROM study_recordings').get(), before);
	assert.equal(readFileSync(report, 'utf8'), 'Existing signed report');
	assert.equal(readFileSync(audio, 'utf8'), 'Synthetic audio');
	assert.deepEqual(readdirSync(directory), files);
});

test('ElevenLabs preview does not require the OpenAI report-generation key', async t => {
	const { db } = fixture(t); apiKey(t); delete process.env.OPENAI_API_KEY;
	const before = process.env.ELEVENLABS_API_KEY;
	process.env.ELEVENLABS_API_KEY = 'synthetic-test-key';
	t.after(() => { if (before === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = before; });
	setTranscriptionSettings(db, { provider: 'elevenlabs', model: 'scribe_v2' });
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		assert.equal(url, 'https://api.elevenlabs.io/v1/speech-to-text');
		assert.equal(options.body.get('model_id'), 'scribe_v2');
		return Response.json({ text: 'Original dictation' });
	});
	assert.deepEqual(await transcribeRecording(db, 1, 1), { ok: true, text: 'Original dictation' });
});

test('preview API rejects non-admins before accessing the database and validates recording ownership', async t => {
	const unavailable = await http(`missing_${randomUUID()}`);
	for (const [user, status] of [[null, 401], ...['resident', 'attending', 'typist', 'unknown'].map(role => [{ role }, 403])]) {
		assert.equal((await unavailable.transcribeOnly({ locals: { user }, params: {} })).status, status);
	}
	const { db } = fixture(t);
	db.exec("INSERT INTO studies(id,patient_code,exam_date_jalali,exam_time) VALUES(2,'SECOND','1405-07-18','10:00:00')");
	const key = `validation_${randomUUID()}`; globalThis[key] = db; t.after(() => { delete globalThis[key]; });
	const { transcribeOnly } = await http(key);
	for (const [id, recordingId, status] of [['x', '1', 400], ['1', '0', 400], ['999', '1', 404], ['1', '999', 404], ['2', '1', 404]]) {
		assert.equal((await transcribeOnly({ locals: { user: { role: 'admin' } }, params: { id, recordingId } })).status, status);
	}
});

test('preview locks concurrent operations but leaves report and signatures intact on failure or lease expiry', async t => {
	const { db } = fixture(t);
	const before = db.prepare('SELECT * FROM study_recordings').get();
	await assert.rejects(transcribeRecording(db, 1, 1, async () => {
		assert.equal(db.prepare('SELECT processing FROM study_recordings').get().processing, 1);
		await assert.rejects(transcribeRecording(db, 1, 1, async () => 'Duplicate'), error => error.status === 409);
		throw new Error('Provider failure');
	}), /Provider failure/);
	assert.deepEqual(db.prepare('SELECT * FROM study_recordings').get(), before);
	await assert.rejects(transcribeRecording(db, 1, 1, async () => ''), error => error.status === 502);
	await assert.rejects(transcribeRecording(db, 1, 1, async () => {
		db.exec('UPDATE study_recordings SET processing=0,processing_started_at=NULL'); return 'Late output';
	}), error => error.status === 409);
	assert.deepEqual(db.prepare('SELECT * FROM study_recordings').get(), before);
});

test('disabled, missing audio and missing provider credentials do not change saved data', async t => {
	const { db, audio } = fixture(t);
	const never = async () => assert.fail('Unexpected transcription');
	db.exec('UPDATE studies SET disabled=1');
	await assert.rejects(transcribeRecording(db, 1, 1, never), error => error.status === 409);
	db.exec('UPDATE studies SET disabled=0');
	rmSync(audio);
	await assert.rejects(transcribeRecording(db, 1, 1, never), error => error.status === 404);
	writeFileSync(audio, 'Synthetic');
	apiKey(t); delete process.env.OPENAI_API_KEY;
	await assert.rejects(transcribeRecording(db, 1, 1), error => error.status === 501);
	assert.equal(db.prepare('SELECT processing FROM study_recordings').get().processing, 0);
});

const componentUrl = new URL('../src/routes/studies/TranscriptionPreview.svelte', import.meta.url);
const source = readFileSync(componentUrl, 'utf8');

test('preview UI displays returned text, prevents duplicate requests and reports failures without saving', async () => {
	const script = source.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;\r?$/gm, '');
	const run = new Function('props', 'fetch', `
		const $props = () => props;
		const $state = value => value;
		const $derived = value => value;
		const onDestroy = () => {};
		${script}
		return { transcribe, snapshot: () => ({ busy, text, error }) };
	`);
	const props = { user: { role: 'admin' }, study: { id: 1 }, recording: { id: 2, audio_report_path: 'synthetic.ogg' }, busy: false };
	let resolve, calls = 0;
	const instance = run(props, (url, options) => {
		assert.equal(url, '/api/studies/1/recordings/2/transcribe-only');
		assert.equal(options.method, 'POST');
		assert.equal(options.body, undefined);
		calls++;
		return new Promise(done => { resolve = done; });
	});
	const pending = instance.transcribe();
	assert.equal(instance.snapshot().busy, true);
	await instance.transcribe(); assert.equal(calls, 1);
	resolve(Response.json({ text: '<script>not markup</script> متن T2' })); await pending;
	assert.deepEqual(instance.snapshot(), { busy: false, text: '<script>not markup</script> متن T2', error: '' });
	const failed = instance.transcribe();
	resolve(Response.json({ error: 'Provider unavailable' }, { status: 502 })); await failed;
	assert.deepEqual(instance.snapshot(), { busy: false, text: '', error: 'Provider unavailable' });
	assert.match(source, /readonly value=\{text\}/);
	assert.doesNotMatch(source, /@html/);
	const denied = run({ ...props, user: { role: 'resident' } }, () => assert.fail('Unauthorized request'));
	await denied.transcribe();
});

test('preview button is admin-only, accessible, and disabled for unavailable audio or disabled studies', async () => {
	const client = compile(source, { filename: 'TranscriptionPreview.svelte', generate: 'client' });
	assert.deepEqual(client.warnings.filter(({ code }) => code.startsWith('a11y')), []);
	const compiled = compile(source, { filename: 'TranscriptionPreview.svelte', generate: 'server' }).js.code
		.replace(/from (['"])([^'"]+)\1/g, (_statement, _quote, specifier) => `from ${JSON.stringify(import.meta.resolve(specifier))}`);
	const Component = (await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)).default;
	for (const role of ['admin', 'resident', 'attending', 'typist']) {
		const { body } = render(Component, { props: { user: { role }, study: {}, recording: { audio_report_path: 'synthetic.ogg' } } });
		assert.equal(body.includes('Transcribe only'), role === 'admin');
	}
	for (const props of [{ study: { disabled: 1 }, recording: { audio_report_path: 'synthetic.ogg' } }, { study: {}, recording: {} }, { study: {}, recording: { audio_report_path: 'synthetic.ogg', processing: 1 } }]) {
		assert.match(render(Component, { props: { ...props, user: { role: 'admin' } } }).body, /<button[^>]*disabled/);
	}
	for (const file of ['RecordingCard', 'ReportModal']) {
		assert.match(readFileSync(new URL(`../src/routes/studies/${file}.svelte`, import.meta.url), 'utf8'), /<TranscriptionPreview[^>]*bind:busy=\{transcribing\}/);
	}
});
