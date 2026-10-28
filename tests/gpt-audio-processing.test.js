import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { getGptAudioSettings, setGptAudioSettings } from '../src/lib/server/gpt-audio-settings.js';
import { setReportGenerationSettings } from '../src/lib/server/report-generation-settings.js';
import { getTranscriptionSettings, setTranscriptionSettings } from '../src/lib/server/transcription-settings.js';
import { setAttendingReportPreferences } from '../src/lib/server/report-preferences.js';
import { processRecording, saveRecordingReport } from '../src/lib/server/recording-processing.js';
import { appendRecording, appendRecordingAudio, configureRecording, getRecording } from '../src/lib/server/recordings.js';
import { insertStudy } from '../src/lib/server/studies.js';
import { prepareDirectAudio, AudioDurationLimitError } from '../src/lib/server/direct-audio.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const substitute = { provider: 'openai', model: 'gpt-transcribe' };
function wave(samples = 12000, amplitude = 1000) {
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
	data.writeUInt32LE(data.length - 44, 40);
	for (let offset = 44; offset < data.length; offset += 2) data.writeInt16LE(amplitude, offset);
	return data;
}
function fixture(t, mode, { samples = 12000, multipart = true } = {}) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys=ON');
	initializeSchema(db, schema);
	db.exec(`INSERT INTO modalities VALUES(1,'MR','MRI');
		INSERT INTO exam_types VALUES(1,'BRAIN_WO','Brain without contrast');
		INSERT INTO users(id,full_name,role) VALUES(1,'Synthetic Resident','resident'),(2,'Synthetic Attending','attending');
		INSERT INTO report_templates(modality_id,exam_type_id,text) VALUES(1,1,'Findings: Synthetic template');`);
	const directory = mkdtempSync(join(tmpdir(), 'gpt-audio-policy-'));
	const audio = join(directory, 'first.wav');
	const second = join(directory, 'second.wav');
	writeFileSync(audio, wave(samples));
	writeFileSync(second, wave(samples, -2000));
	const studyId = insertStudy(db, { patient_code: 'SYNTHETIC', patient_firstname: 'Synthetic', exam_date_jalali: '1405-07-29', exam_time: '09:00', corresponding_attending_id: 2 });
	const recording = appendRecording(db, studyId, audio);
	configureRecording(db, studyId, recording.id, { modality_id: 1, exam_type_ids: [1], corresponding_resident_id: 1 });
	if (multipart) appendRecordingAudio(db, studyId, recording.id, second, null, { id: 1, role: 'resident' });
	setReportGenerationSettings(db, { mode });
	setTranscriptionSettings(db, { provider: 'openai', model: 'gpt-audio-1.5' });
	setAttendingReportPreferences(db, 2, { english_variant: 'american' });
	setGptAudioSettings(db, { limitSeconds: 1, substitute });
	const previous = saveRecordingReport(db, recording.id, 'Previous report.', directory);
	const prior = Object.fromEntries(['OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'FFMPEG_PATH', 'TMP', 'TEMP', 'TMPDIR'].map(name => [name, process.env[name]]));
	for (const name of ['TMP', 'TEMP', 'TMPDIR']) process.env[name] = directory;
	process.env.OPENAI_API_KEY = 'synthetic-openai-key';
	process.env.ELEVENLABS_API_KEY = 'synthetic-elevenlabs-key';
	t.after(() => {
		for (const [name, value] of Object.entries(prior)) {
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
		db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return { db, directory, audio, second, studyId, id: recording.id, previous };
}
const completed = text => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: text } }] }) });
const reportResponse = () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Synthetic completed report.' }] }] }) });
function preserved(f) {
	const recording = getRecording(f.db, f.studyId, f.id);
	assert.equal(recording.processing, 0);
	assert.equal(recording.processing_started_at, null);
	assert.equal(recording.text_report_path, f.previous);
	assert.equal(readFileSync(f.previous, 'utf8'), 'Previous report.');
	assert.equal(readdirSync(f.directory).some(name => name.startsWith('radiology-audio-')), false);
}

for (const mode of ['direct_audio', 'transcribe_then_generate']) {
	for (const selected of [substitute, { provider: 'elevenlabs', model: 'scribe_v2_medical' }]) {
		test(`${mode} switches the entire over-limit recording to ${selected.model}, untruncated and ordered, using captured settings`, async t => {
			const f = fixture(t, mode);
			setGptAudioSettings(f.db, { limitSeconds: 1, substitute: selected });
			let transcriptions = 0, reports = 0;
			t.mock.method(globalThis, 'fetch', async (url, options) => {
				assert.notEqual(url, 'https://api.openai.com/v1/chat/completions');
				if (url !== 'https://api.openai.com/v1/responses') {
					const eleven = selected.provider === 'elevenlabs';
					assert.equal(url, eleven ? 'https://api.elevenlabs.io/v1/speech-to-text' : 'https://api.openai.com/v1/audio/transcriptions');
					assert.equal(options.body.get(eleven ? 'model_id' : 'model'), selected.model);
					assert.equal(options.headers[eleven ? 'xi-api-key' : 'Authorization'], eleven ? 'synthetic-elevenlabs-key' : ['Bearer', 'synthetic-openai-key'].join(' '));
					assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), readFileSync(transcriptions ? f.second : f.audio));
					setTranscriptionSettings(f.db, { provider: 'elevenlabs', model: 'scribe_v2' });
					return { ok: true, json: async () => ({ text: `Ordered dictation ${++transcriptions}.` }) };
				}
				assert.equal(transcriptions, 2);
				const payload = JSON.parse(options.body);
				assert.equal(payload.model, 'gpt-6.1-sol');
				assert.ok(payload.input.includes('Ordered dictation 1.\nOrdered dictation 2.'));
				assert.match(payload.input, /Findings: Synthetic template/);
				assert.match(payload.input, /US English spelling/);
				assert.match(payload.input, /YYYY\/MM\/DD/);
				reports++;
				return reportResponse();
			});
			const pending = processRecording(f.db, f.studyId, f.id, undefined, f.directory);
			// Changes made while FFmpeg runs apply only to the next processing request.
			setGptAudioSettings(f.db, { limitSeconds: 100, substitute: null });
			const result = await pending;
			assert.equal(transcriptions, 2);
			assert.equal(reports, 1);
			assert.equal(readFileSync(result.path, 'utf8'), 'Synthetic completed report.');
			assert.equal(getRecording(f.db, f.studyId, f.id).processing, 0);
			assert.deepEqual(getGptAudioSettings(f.db), { limitSeconds: 100, substitute: null });
		});
	}

	for (const samples of [7999, 8000]) {
		test(`${mode} retains GPT Audio ${samples === 8000 ? 'at' : 'below'} the total threshold without needing the substitute key`, async t => {
			const f = fixture(t, mode, { samples });
			setGptAudioSettings(f.db, { limitSeconds: 1, substitute: { provider: 'elevenlabs', model: 'scribe_v2' } });
			delete process.env.ELEVENLABS_API_KEY;
			let audioCalls = 0;
			t.mock.method(globalThis, 'fetch', async (url, options) => {
				if (url === 'https://api.openai.com/v1/responses') return reportResponse();
				assert.equal(url, 'https://api.openai.com/v1/chat/completions');
				const payload = JSON.parse(options.body);
				const decoded = Buffer.from(payload.messages[1].content[1].input_audio.data, 'base64');
				assert.equal(decoded.readUInt32LE(40), samples * (mode === 'direct_audio' ? 4 : 2));
				audioCalls++;
				return completed(mode === 'direct_audio' ? 'Synthetic completed report.' : 'Synthetic dictation.');
			});
			await processRecording(f.db, f.studyId, f.id, undefined, f.directory);
			assert.equal(audioCalls, mode === 'direct_audio' ? 1 : 2);
		});
	}

	for (const failure of ['disabled', 'missing-key', 'invalid', 'invalid-policy', 'missing-ffmpeg', 'substitute-http', 'substitute-empty']) {
		test(`${mode} preserves the report and releases the lock on ${failure}`, async t => {
			const f = fixture(t, mode);
			let calls = 0;
			if (failure === 'disabled') setGptAudioSettings(f.db, { limitSeconds: 1, substitute: null });
			if (failure === 'missing-key') {
				setGptAudioSettings(f.db, { limitSeconds: 1, substitute: { provider: 'elevenlabs', model: 'scribe_v2' } });
				delete process.env.ELEVENLABS_API_KEY;
			}
			if (failure === 'invalid') writeFileSync(f.second, 'Invalid synthetic audio');
			if (failure === 'invalid-policy') f.db.prepare("UPDATE application_settings SET value='broken' WHERE key='gpt_audio_settings'").run();
			if (failure === 'missing-ffmpeg') process.env.FFMPEG_PATH = join(f.directory, 'missing-ffmpeg.exe');
			t.mock.method(globalThis, 'fetch', async url => {
				calls++;
				assert.ok(failure.startsWith('substitute-'));
				assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
				return failure === 'substitute-http' ? { ok: false, status: 429 } : { ok: true, json: async () => ({ text: ' ' }) };
			});
			const expected = {
				disabled: /1 second of total recording audio/,
				'missing-key': /Set ELEVENLABS_API_KEY/,
				invalid: /Audio conversion failed/,
				'invalid-policy': /Saved GPT Audio settings are invalid/,
				'missing-ffmpeg': /requires ffmpeg/,
				'substitute-http': /transcription failed \(HTTP 429\)/,
				'substitute-empty': /transcription returned no text/
			}[failure];
			await assert.rejects(processRecording(f.db, f.studyId, f.id, undefined, f.directory), expected);
			assert.equal(calls, failure.startsWith('substitute-') ? 1 : 0);
			preserved(f);
		});
	}

	test(`${mode} does not substitute for GPT Audio provider failures`, async t => {
		const f = fixture(t, mode, { samples: 8000 });
		let calls = 0;
		t.mock.method(globalThis, 'fetch', async url => {
			calls++;
			assert.equal(url, 'https://api.openai.com/v1/chat/completions');
			return { ok: false, status: 429 };
		});
		await assert.rejects(processRecording(f.db, f.studyId, f.id, undefined, f.directory), /HTTP 429/);
		assert.equal(calls, 1);
		preserved(f);
	});

	test(`${mode} sends the complete original file to the substitute even when duration detection stops decoding early`, async t => {
		const f = fixture(t, mode, { samples: 3 * 16000, multipart: false });
		let transcriptions = 0;
		t.mock.method(globalThis, 'fetch', async (url, options) => {
			if (url === 'https://api.openai.com/v1/responses') return reportResponse();
			assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
			assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), readFileSync(f.audio));
			assert.equal(options.body.get('file').size, 44 + 3 * 32000);
			transcriptions++;
			return { ok: true, json: async () => ({ text: 'Synthetic complete dictation.' }) };
		});
		await processRecording(f.db, f.studyId, f.id, undefined, f.directory);
		assert.equal(transcriptions, 1);
		assert.deepEqual(getTranscriptionSettings(f.db), { provider: 'openai', model: 'gpt-audio-1.5' });
	});

	test(`${mode} accepts an administrator limit higher than the previous 600-second safeguard`, async t => {
		const f = fixture(t, mode, { samples: 601 * 16000, multipart: false });
		setGptAudioSettings(f.db, { limitSeconds: 602, substitute: null });
		let audioCalls = 0;
		t.mock.method(globalThis, 'fetch', async (url, options) => {
			if (url === 'https://api.openai.com/v1/responses') return reportResponse();
			assert.equal(url, 'https://api.openai.com/v1/chat/completions');
			const payload = JSON.parse(options.body);
			assert.equal(Buffer.from(payload.messages[1].content[1].input_audio.data, 'base64').readUInt32LE(40), 601 * 32000);
			audioCalls++;
			return completed('Synthetic dictation or report.');
		});
		await processRecording(f.db, f.studyId, f.id, undefined, f.directory);
		assert.equal(audioCalls, 1);
	});
}

test('preparation enforces decoded total duration to the sample, returns split WAVs only after validation and cleans up', async t => {
	const f = fixture(t, 'direct_audio', { samples: 8000 });
	const parts = [{ audio_report_path: f.audio }, { audio_report_path: f.second }];
	const prepared = await prepareDirectAudio(parts, { limitSeconds: 1, splitParts: true, transcription: true });
	assert.equal(prepared.length, 2);
	for (const [index, audio] of prepared.entries()) {
		assert.deepEqual(Buffer.from(audio, 'base64'), readFileSync(index ? f.second : f.audio));
	}
	writeFileSync(f.second, wave(8001));
	await assert.rejects(prepareDirectAudio(parts, { limitSeconds: 1, splitParts: true }), AudioDurationLimitError);
	for (const limitSeconds of [0, -1, 1.5, NaN, Infinity, '600', 134218]) {
		await assert.rejects(prepareDirectAudio(parts, { limitSeconds }), /valid GPT Audio time limit/);
	}
	assert.equal(readdirSync(f.directory).some(name => name.startsWith('radiology-audio-')), false);
});

test('dedicated transcription ignores an invalid GPT Audio policy and never changes the primary selection', async t => {
	const f = fixture(t, 'transcribe_then_generate');
	setTranscriptionSettings(f.db, substitute);
	f.db.prepare("UPDATE application_settings SET value='broken' WHERE key='gpt_audio_settings'").run();
	t.mock.method(globalThis, 'fetch', async url => url === 'https://api.openai.com/v1/responses'
		? reportResponse() : { ok: true, json: async () => ({ text: 'Synthetic dictation.' }) });
	await processRecording(f.db, f.studyId, f.id, undefined, f.directory);
	assert.deepEqual(getTranscriptionSettings(f.db), substitute);
});
