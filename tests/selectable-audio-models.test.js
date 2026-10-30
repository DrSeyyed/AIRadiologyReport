import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { AUDIO_MODEL_PROVIDERS, DEFAULT_DIRECT_AUDIO_SETTINGS, audioModelSampleRate } from '../src/lib/audio-models.js';
import { normalizeReportGenerationSettings } from '../src/lib/report-generation-models.js';
import { normalizeTranscriptionSettings } from '../src/lib/transcription-models.js';
import { GPT_AUDIO_SUBSTITUTES } from '../src/lib/gpt-audio-settings.js';
import { setReportGenerationSettings, getReportGenerationSettings } from '../src/lib/server/report-generation-settings.js';
import { setTranscriptionSettings } from '../src/lib/server/transcription-settings.js';
import { setGptAudioSettings } from '../src/lib/server/gpt-audio-settings.js';
import { appendRecording, appendRecordingAudio, configureRecording, getRecording } from '../src/lib/server/recordings.js';
import { insertStudy } from '../src/lib/server/studies.js';
import { processRecording, saveRecordingReport } from '../src/lib/server/recording-processing.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const models = AUDIO_MODEL_PROVIDERS.flatMap((provider) => provider.models
	.filter((model) => model.transport !== 'chat')
	.map((model) => ({ provider: provider.id, model: model.id })));
const report = 'FINDINGS:\nA joint effusion is present.\nConclusion:\nA joint effusion is present.';
const dictations = ['سمت چپ low T1؛ 1.5 mm.', 'No right-sided diffusion restriction.'];
const reportResponse = () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: report }] }] }) });

function wave(samples = 3200) {
	const data = Buffer.alloc(44 + samples * 2);
	data.write('RIFF');
	data.writeUInt32LE(data.length - 8, 4);
	data.write('WAVEfmt ', 8);
	data.writeUInt32LE(16, 16);
	data.writeUInt16LE(1, 20);
	data.writeUInt16LE(1, 22);
	data.writeUInt32LE(16000, 24);
	data.writeUInt32LE(32000, 28);
	data.writeUInt16LE(2, 32);
	data.writeUInt16LE(16, 34);
	data.write('data', 36);
	data.writeUInt32LE(samples * 2, 40);
	for (let offset = 44; offset < data.length; offset += 2) data.writeInt16LE(1000, offset);
	return data;
}

function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys=ON');
	initializeSchema(db, schema);
	db.exec(`INSERT INTO modalities VALUES(1,'MR','MRI');
		INSERT INTO exam_types VALUES(1,'KNEE_WO','Knee without contrast');
		INSERT INTO users(id,full_name,role) VALUES(1,'Synthetic Resident','resident'),(2,'Synthetic Attending','attending');
		INSERT INTO report_templates(modality_id,exam_type_id,text) VALUES(1,1,'FINDINGS: Synthetic template');`);
	const directory = mkdtempSync(join(tmpdir(), 'selectable-audio-'));
	const audio = join(directory, 'first.wav');
	const second = join(directory, 'second.wav');
	writeFileSync(audio, wave());
	writeFileSync(second, wave(1600));
	const studyId = insertStudy(db, { patient_code: 'SYNTHETIC', patient_firstname: 'Synthetic', exam_date_jalali: '1405-08-05', exam_time: '09:00', corresponding_attending_id: 2 });
	const recording = appendRecording(db, studyId, audio);
	configureRecording(db, studyId, recording.id, { modality_id: 1, exam_type_ids: [1], corresponding_resident_id: 1 });
	const env = Object.fromEntries(['OPENAI_API_KEY', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY'].map((key) => [key, process.env[key]]));
	process.env.OPENAI_API_KEY = 'synthetic-openai-key';
	process.env.GEMINI_API_KEY = 'synthetic-gemini-key';
	delete process.env.ELEVENLABS_API_KEY;
	t.after(() => {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return { db, directory, audio, second, studyId, id: recording.id };
}

// Substitute only the transport boundary; exercise the real settings snapshot, conversion and report pipeline.
async function processingWithTransport(t, handler) {
	const key = randomUUID();
	globalThis[key] = handler;
	t.after(() => delete globalThis[key]);
	const boundary = new URL('../src/lib/server/generative-audio.js', import.meta.url);
	const facade = `data:text/javascript,${encodeURIComponent(`export { normalizeProviderTranscript } from ${JSON.stringify(boundary.href)}; export async function generateAudioModelText(...args){return globalThis[${JSON.stringify(key)}](...args);}`)}`;
	const generation = new URL('../src/lib/server/recording-generation.js', import.meta.url);
	function imports(source, base, overrides) {
		return source.replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
			const target = overrides[specifier] ?? (specifier.startsWith('.') ? new URL(specifier, base).href : specifier);
			return `from ${JSON.stringify(target)}`;
		});
	}
	const generationSource = imports(readFileSync(generation, 'utf8'), generation, { './generative-audio.js': facade });
	const generationUrl = `data:text/javascript;base64,${Buffer.from(generationSource).toString('base64')}`;
	const processing = new URL('../src/lib/server/recording-processing.js', import.meta.url);
	const source = imports(readFileSync(processing, 'utf8'), processing, { './recording-generation.js': generationUrl });
	return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).processRecording;
}

function select(f, mode, settings) {
	setReportGenerationSettings(f.db, { mode, ...settings });
	setTranscriptionSettings(f.db, settings);
}

function assertPrevious(f, path) {
	const recording = getRecording(f.db, f.studyId, f.id);
	assert.equal(recording.processing, 0);
	assert.equal(recording.text_report_path, path);
	assert.equal(readFileSync(path, 'utf8'), 'Previous report.');
}

test('every new model supports both selections and cannot become a recursive duration substitute', (t) => {
	const f = fixture(t);
	for (const settings of models) {
		assert.deepEqual(normalizeTranscriptionSettings(settings), settings);
		const reporting = { mode: 'direct_audio', ...settings };
		assert.deepEqual(normalizeReportGenerationSettings(reporting), reporting);
		setReportGenerationSettings(f.db, reporting);
		assert.deepEqual(getReportGenerationSettings(f.db), reporting);
		assert.ok(!GPT_AUDIO_SUBSTITUTES.some((provider) => provider.id === settings.provider && provider.models.some((model) => model.id === settings.model)));
	}
	f.db.prepare("UPDATE application_settings SET value=? WHERE key='report_generation_settings'").run('{"mode":"direct_audio"}');
	assert.deepEqual(getReportGenerationSettings(f.db), { mode: 'direct_audio', ...DEFAULT_DIRECT_AUDIO_SETTINGS });
	for (const settings of [{ provider: 'gemini', model: 'gpt-realtime-2' }, { provider: 'openai', model: 'gemini-3.8-flash' }, { provider: 'elevenlabs', model: 'scribe_v2' }])
		assert.throws(() => normalizeReportGenerationSettings({ mode: 'direct_audio', ...settings }));
});

for (const mode of ['direct_audio', 'transcribe_then_generate']) for (const settings of models) {
	test(`${mode} uses ${settings.model} with ordered audio, shared clinical prompts and a fixed settings snapshot`, async (t) => {
		const f = fixture(t);
		appendRecordingAudio(f.db, f.studyId, f.id, f.second, null, { id: 1, role: 'resident' });
		select(f, mode, settings);
		if (mode === 'direct_audio' && settings.provider === 'gemini') delete process.env.OPENAI_API_KEY;
		let calls = 0;
		const run = await processingWithTransport(t, async (actual, audio, prompt, task) => {
			assert.equal(actual.provider, settings.provider);
			assert.equal(actual.model, settings.model);
			assert.equal(task, mode === 'direct_audio' ? 'report' : 'transcription');
			const decoded = Buffer.from(audio, 'base64');
			assert.equal(decoded.readUInt32LE(24), audioModelSampleRate(settings));
			assert.match(prompt, /Never convert Jalali/);
			assert.match(prompt, /negation/);
			if (mode === 'direct_audio') {
				assert.match(prompt, /FINDINGS: Synthetic template/);
				assert.match(prompt, /YYYY\/MM\/DD/);
				assert.match(prompt, /NO_USABLE_CLINICAL_DICTATION/);
				assert.equal(decoded.readUInt32LE(40), audioModelSampleRate(settings) * 0.3 * 2);
			}
			setReportGenerationSettings(f.db, { mode: 'transcribe_then_generate' });
			setTranscriptionSettings(f.db, { provider: 'openai', model: 'gpt-transcribe' });
			return mode === 'direct_audio' ? report : JSON.stringify({ transcript: dictations[calls++] });
		});
		let reports = 0;
		t.mock.method(globalThis, 'fetch', async (url, options) => {
			assert.equal(mode, 'transcribe_then_generate');
			assert.equal(url, 'https://api.openai.com/v1/responses');
			const body = JSON.parse(options.body);
			assert.equal(body.model, 'gpt-6.1-sol');
			assert.ok(body.input.includes(dictations.join('\n')));
			reports++;
			return reportResponse();
		});
		const result = await run(f.db, f.studyId, f.id, undefined, f.directory);
		assert.equal(result.text, report);
		assert.equal(getRecording(f.db, f.studyId, f.id).processing, 0);
		assert.equal(calls, mode === 'direct_audio' ? 0 : 2);
		assert.equal(reports, mode === 'direct_audio' ? 0 : 1);
	});
}

for (const mode of ['direct_audio', 'transcribe_then_generate']) for (const provider of ['gemini', 'openai']) {
	const settings = models.find((entry) => entry.provider === provider);
	test(`${provider} ${mode} preflights all audio before requests and only duration overflow activates substitution`, async (t) => {
		const f = fixture(t);
		writeFileSync(f.audio, wave(16000));
		writeFileSync(f.second, wave(16000));
		appendRecordingAudio(f.db, f.studyId, f.id, f.second, null, { id: 1, role: 'resident' });
		select(f, mode, settings);
		const previous = saveRecordingReport(f.db, f.id, 'Previous report.', f.directory);
		setGptAudioSettings(f.db, { limitSeconds: 1, substitute: null });
		let transports = 0;
		const run = await processingWithTransport(t, () => { transports++; throw new Error('Unexpected transport'); });
		let requests = 0;
		t.mock.method(globalThis, 'fetch', async (url, options) => {
			requests++;
			if (url.endsWith('/audio/transcriptions')) {
				assert.equal(options.body.get('model'), 'gpt-transcribe');
				return { ok: true, json: async () => ({ text: 'Synthetic dictation.' }) };
			}
			assert.equal(url, 'https://api.openai.com/v1/responses');
			return reportResponse();
		});
		await assert.rejects(run(f.db, f.studyId, f.id, undefined, f.directory), /at most 1 second/);
		assertPrevious(f, previous);
		assert.equal(requests, 0);
		assert.equal(transports, 0);
		setGptAudioSettings(f.db, { limitSeconds: 1, substitute: { provider: 'openai', model: 'gpt-transcribe' } });
		if (provider === 'gemini' && mode === 'direct_audio') {
			delete process.env.OPENAI_API_KEY;
			await assert.rejects(run(f.db, f.studyId, f.id, undefined, f.directory), /OPENAI_API_KEY.*over-limit/);
			assertPrevious(f, previous);
			assert.equal(requests, 0);
			process.env.OPENAI_API_KEY = 'synthetic-openai-key';
		}
		assert.equal((await run(f.db, f.studyId, f.id, undefined, f.directory)).text, report);
		assert.equal(requests, 3);
		assert.equal(transports, 0);
	});

	test(`${provider} ${mode} preserves the old report on provider failure and rejects missing credentials before locking`, async (t) => {
		const f = fixture(t);
		select(f, mode, settings);
		const previous = saveRecordingReport(f.db, f.id, 'Previous report.', f.directory);
		setGptAudioSettings(f.db, { limitSeconds: 600, substitute: { provider: 'openai', model: 'gpt-transcribe' } });
		let calls = 0;
		const run = await processingWithTransport(t, () => { calls++; throw new Error('Synthetic provider failure.'); });
		t.mock.method(globalThis, 'fetch', () => { throw new Error('No fallback allowed'); });
		await assert.rejects(run(f.db, f.studyId, f.id, undefined, f.directory), /Synthetic provider failure/);
		assert.equal(calls, 1);
		assertPrevious(f, previous);
		delete process.env[provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY'];
		await assert.rejects(run(f.db, f.studyId, f.id, undefined, f.directory), (error) => error.status === 501);
		assertPrevious(f, previous);
		assert.equal(calls, 1);
	});
}

for (const settings of models.filter((entry) => entry.provider === 'gemini')) {
	test(`${settings.model} transcribes through the real REST adapter and forwards only ordered dictation to report generation`, async (t) => {
		const f = fixture(t);
		appendRecordingAudio(f.db, f.studyId, f.id, f.second, null, { id: 1, role: 'resident' });
		select(f, 'transcribe_then_generate', settings);
		let calls = 0;
		t.mock.method(globalThis, 'fetch', async (url, options) => {
			const body = JSON.parse(options.body);
			if (url === 'https://generativelanguage.googleapis.com/v1beta/interactions') {
				assert.equal(body.model, settings.model);
				assert.equal(body.store, false);
				const text = JSON.stringify({ transcript: dictations[calls++] });
				return new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] }));
			}
			assert.equal(url, 'https://api.openai.com/v1/responses');
			assert.equal(calls, 2);
			assert.equal(body.model, 'gpt-6.1-sol');
			assert.ok(options.body.indexOf(dictations[0]) < options.body.indexOf(dictations[1]));
			assert.ok(!options.body.includes('"transcript":'));
			calls++;
			return reportResponse();
		});
		assert.equal((await processRecording(f.db, f.studyId, f.id, undefined, f.directory)).text, report);
		assert.equal(calls, 3);
	});
}

for (const mode of ['direct_audio', 'transcribe_then_generate']) {
	test(`Gemini ${mode} rejects silent output without replacing the previous report or falling back`, async (t) => {
		const f = fixture(t);
		select(f, mode, { provider: 'gemini', model: 'gemini-2.5-flash' });
		const previous = saveRecordingReport(f.db, f.id, 'Previous report.', f.directory);
		let calls = 0;
		t.mock.method(globalThis, 'fetch', async (url) => {
			assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
			calls++;
			return new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: mode === 'direct_audio' ? 'NO_USABLE_CLINICAL_DICTATION' : '{"transcript":""}' }] }] }));
		});
		await assert.rejects(processRecording(f.db, f.studyId, f.id, undefined, f.directory));
		assert.equal(calls, 1);
		assertPrevious(f, previous);
	});
}

test('Gemini direct reporting reaches the real REST adapter without requiring an OpenAI key', async (t) => {
	const f = fixture(t);
	select(f, 'direct_audio', { provider: 'gemini', model: 'gemini-3.8-flash' });
	delete process.env.OPENAI_API_KEY;
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
		const body = JSON.parse(options.body);
		assert.equal(body.model, 'gemini-3.8-flash');
		assert.equal(body.store, false);
		assert.match(body.system_instruction, /FINDINGS: Synthetic template/);
		assert.equal(body.input[1].mime_type, 'audio/wav');
		assert.equal(Buffer.from(body.input[1].data, 'base64').readUInt32LE(24), 16000);
		calls++;
		return new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: report }] }] }), { status: 200 });
	});
	assert.equal((await processRecording(f.db, f.studyId, f.id, undefined, f.directory)).text, report);
	assert.equal(calls, 1);
});
