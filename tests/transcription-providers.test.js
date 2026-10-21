import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { TRANSCRIPTION_PROVIDERS, DEFAULT_TRANSCRIPTION_SETTINGS } from '../src/lib/transcription-models.js';
import { getTranscriptionSettings, setTranscriptionSettings } from '../src/lib/server/transcription-settings.js';
import { transcribeAudio } from '../src/lib/server/recording-generation.js';
import { processRecording, saveRecordingReport } from '../src/lib/server/recording-processing.js';
import { appendRecording, appendRecordingAudio, configureRecording, getRecording } from '../src/lib/server/recordings.js';
import { insertStudy } from '../src/lib/server/studies.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	initializeSchema(db, schema);
	db.exec(`INSERT INTO modalities VALUES(1,'MR','MRI');
		INSERT INTO exam_types VALUES(1,'BRAIN_WO','Brain without contrast');
		INSERT INTO users(id,full_name,role) VALUES(1,'Synthetic Resident','resident'),(2,'Synthetic Attending','attending');
		INSERT INTO report_templates(modality_id,exam_type_id,text) VALUES(1,1,'Findings: Synthetic template');`);
	const directory = mkdtempSync(join(tmpdir(), 'transcription-providers-'));
	const audio = join(directory, 'synthetic.ogg');
	writeFileSync(audio, 'Synthetic audio; no patient data');
	const studyId = insertStudy(db, { patient_code: 'SYNTHETIC', patient_firstname: 'Synthetic', exam_date_jalali: '1405-07-29', exam_time: '09:00', corresponding_attending_id: 2 });
	const recording = appendRecording(db, studyId, audio);
	configureRecording(db, studyId, recording.id, { modality_id: 1, exam_type_ids: [1], corresponding_resident_id: 1 });
	const prior = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY };
	process.env.OPENAI_API_KEY = 'synthetic-openai-key';
	process.env.ELEVENLABS_API_KEY = 'synthetic-elevenlabs-key';
	t.after(() => {
		for (const [name, value] of Object.entries(prior)) {
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
		db.close(); rmSync(directory, { recursive: true, force: true });
	});
	return { db, directory, audio, studyId, id: recording.id };
}

const reportResponse = () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Synthetic completed report.' }] }] }) });

test('settings preserve the existing default and persist a validated provider/model atomically across initialization', t => {
	const { db } = fixture(t);
	assert.deepEqual(getTranscriptionSettings(db), DEFAULT_TRANSCRIPTION_SETTINGS);
	const selected = { provider: 'elevenlabs', model: 'scribe_v2_medical' };
	assert.deepEqual(setTranscriptionSettings(db, selected), selected);
	for (const value of [null, {}, { provider: 'unknown', model: 'x' }, { provider: 'openai', model: 'scribe_v2' }, { provider: 'elevenlabs', model: 'gpt-transcribe' }, { provider: 'elevenlabs', model: new Blob(['x']) }]) {
		assert.throws(() => setTranscriptionSettings(db, value));
		assert.deepEqual(getTranscriptionSettings(db), selected);
	}
	initializeSchema(db, schema);
	assert.deepEqual(getTranscriptionSettings(db), selected);
	db.prepare("UPDATE application_settings SET value = 'invalid' WHERE key = 'transcription_settings'").run();
	assert.throws(() => getTranscriptionSettings(db), /Saved transcription settings are invalid/);
	setTranscriptionSettings(db, DEFAULT_TRANSCRIPTION_SETTINGS);
	assert.deepEqual(getTranscriptionSettings(db), DEFAULT_TRANSCRIPTION_SETTINGS);
});

test('every supported model uses the correct provider endpoint and credentials without translation or language forcing', async t => {
	const { audio } = fixture(t);
	let selected;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		const eleven = selected.provider === 'elevenlabs';
		assert.equal(url, eleven ? 'https://api.elevenlabs.io/v1/speech-to-text' : 'https://api.openai.com/v1/audio/transcriptions');
		assert.equal(options.method, 'POST');
		assert.ok(options.signal instanceof AbortSignal);
		assert.equal(options.body.get(eleven ? 'model_id' : 'model'), selected.model);
		assert.equal(options.body.get('file').name, 'synthetic.ogg');
		assert.equal(await options.body.get('file').text(), 'Synthetic audio; no patient data');
		assert.equal(options.body.has('language'), false);
		assert.equal(options.body.has('language_code'), false);
		assert.equal(options.body.has('transcript_edit'), false);
		assert.equal(options.body.has('keyterms'), false);
		if (eleven) {
			assert.deepEqual(options.headers, { 'xi-api-key': 'synthetic-elevenlabs-key' });
			assert.equal(options.body.has('prompt'), false);
			assert.equal(options.body.get('tag_audio_events'), 'false');
			assert.equal(options.body.get('diarize'), 'false');
		} else {
			assert.deepEqual(options.headers, { Authorization: 'Bearer synthetic-openai-key' });
			assert.match(options.body.get('prompt'), /Preserve negation/);
		}
		return { ok: true, json: async () => ({ text: '  فارسی with low T1 and high T2.  ' }) };
	});
	for (const provider of TRANSCRIPTION_PROVIDERS) for (const model of provider.models) {
		selected = { provider: provider.id, model: model.id };
		assert.equal(await transcribeAudio(audio, 'synthetic.ogg', selected), 'فارسی with low T1 and high T2.');
	}
});

test('settings snapshot applies to every part and OpenAI still generates the final report from ordered mixed-language transcripts', async t => {
	const { db, audio, directory, studyId, id } = fixture(t);
	appendRecordingAudio(db, studyId, id, audio, null, { id: 1, role: 'resident' });
	setTranscriptionSettings(db, { provider: 'elevenlabs', model: 'scribe_v2_medical' });
	const dictations = ['سمت چپ low T1؛ 1.5 mm.', 'No right-sided diffusion restriction.'];
	let transcriptions = 0, reports = 0;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		if (url === 'https://api.elevenlabs.io/v1/speech-to-text') {
			assert.equal(options.body.get('model_id'), 'scribe_v2_medical');
			setTranscriptionSettings(db, { provider: 'openai', model: 'gpt-4o-mini-transcribe' });
			return { ok: true, json: async () => ({ text: dictations[transcriptions++] }) };
		}
		assert.equal(url, 'https://api.openai.com/v1/responses');
		assert.equal(transcriptions, 2);
		assert.equal(options.headers.Authorization, 'Bearer synthetic-openai-key');
		const payload = JSON.parse(options.body);
		assert.equal(payload.model, 'gpt-6.1-sol');
		assert.ok(payload.input.includes(`Doctor's dictation:\n"${dictations.join('\n')}"`));
		reports++;
		return reportResponse();
	});
	const result = await processRecording(db, studyId, id, undefined, directory);
	assert.equal(readFileSync(result.path, 'utf8'), 'Synthetic completed report.');
	assert.equal(reports, 1);
	assert.equal(getRecording(db, studyId, id).processing, 0);
	assert.deepEqual(getTranscriptionSettings(db), { provider: 'openai', model: 'gpt-4o-mini-transcribe' });
});

test('selected OpenAI model is used by processing, not only by direct transcription calls', async t => {
	const { db, directory, studyId, id } = fixture(t);
	setTranscriptionSettings(db, { provider: 'openai', model: 'gpt-4o-transcribe' });
	let transcribed = false;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		if (url.endsWith('/audio/transcriptions')) {
			assert.equal(options.body.get('model'), 'gpt-4o-transcribe'); transcribed = true;
			return { ok: true, json: async () => ({ text: 'Synthetic dictation.' }) };
		}
		assert.equal(url, 'https://api.openai.com/v1/responses');
		return reportResponse();
	});
	await processRecording(db, studyId, id, undefined, directory);
	assert.equal(transcribed, true);
});

test('missing selected provider or report credentials fails before claiming or uploading and preserves the old report', async t => {
	const { db, directory, studyId, id } = fixture(t);
	const previous = saveRecordingReport(db, id, 'Previous report.', directory);
	setTranscriptionSettings(db, { provider: 'elevenlabs', model: 'scribe_v2' });
	t.mock.method(globalThis, 'fetch', async () => assert.fail('Credentials must be checked before upload'));
	delete process.env.ELEVENLABS_API_KEY;
	await assert.rejects(processRecording(db, studyId, id, undefined, directory), { status: 501, message: /ELEVENLABS_API_KEY/ });
	process.env.ELEVENLABS_API_KEY = 'synthetic-elevenlabs-key';
	delete process.env.OPENAI_API_KEY;
	await assert.rejects(processRecording(db, studyId, id, undefined, directory), { status: 501, message: /OPENAI_API_KEY/ });
	assert.equal(getRecording(db, studyId, id).processing, 0);
	assert.equal(getRecording(db, studyId, id).text_report_path, previous);
});

test('provider failures, invalid responses and empty text never fall back, generate or replace an existing report', async t => {
	for (const failure of ['http', 'network', 'json', 'empty', 'missing', 'unconfirmed']) await t.test(failure, async t => {
		const { db, directory, studyId, id } = fixture(t);
		const previous = saveRecordingReport(db, id, 'Previous report.', directory);
		setTranscriptionSettings(db, { provider: 'elevenlabs', model: 'scribe_v2' });
		let calls = 0;
		t.mock.method(globalThis, 'fetch', async url => {
			calls++; assert.equal(url, 'https://api.elevenlabs.io/v1/speech-to-text');
			if (failure === 'network') throw new Error('secret-key-and-provider-patient-content');
			if (failure === 'http') return { ok: false, status: 401, text: async () => 'secret-key-and-provider-patient-content' };
			return { ok: true, json: async () => {
				if (failure === 'json') throw new Error('secret-key-and-provider-patient-content');
				return failure === 'empty' ? { text: '  ' } : failure === 'missing' ? {} : { text: null };
			} };
		});
		await assert.rejects(processRecording(db, studyId, id, undefined, directory), error => {
			assert.match(error.message, /ElevenLabs transcription/);
			assert.doesNotMatch(error.message, /secret-key-and-provider-patient-content/);
			return true;
		});
		assert.equal(calls, 1);
		assert.equal(getRecording(db, studyId, id).text_report_path, previous);
		assert.equal(readFileSync(previous, 'utf8'), 'Previous report.');
		assert.equal(getRecording(db, studyId, id).processing, 0);
	});
});

test('changing transcription settings never changes reports or permits generation on signed recordings', async t => {
	const { db, directory, studyId, id } = fixture(t);
	const previous = saveRecordingReport(db, id, 'Signed report.', directory);
	db.prepare('UPDATE study_recordings SET resident_checked=1,attending_checked=1 WHERE id=?').run(id);
	const before = db.prepare('SELECT * FROM study_recordings WHERE id=?').get(id);
	setTranscriptionSettings(db, { provider: 'elevenlabs', model: 'scribe_v2_medical' });
	assert.deepEqual(db.prepare('SELECT * FROM study_recordings WHERE id=?').get(id), before);
	t.mock.method(globalThis, 'fetch', async () => assert.fail('Signed recordings are immutable'));
	await assert.rejects(processRecording(db, studyId, id, undefined, directory), { status: 409 });
	assert.equal(readFileSync(previous, 'utf8'), 'Signed report.');
});
