import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import {
	getReportGenerationSettings,
	setReportGenerationSettings
} from '../src/lib/server/report-generation-settings.js';
import { setTranscriptionSettings } from '../src/lib/server/transcription-settings.js';
import { setAttendingReportPreferences } from '../src/lib/server/report-preferences.js';
import { prepareDirectAudio, MAX_DIRECT_AUDIO_SECONDS } from '../src/lib/server/direct-audio.js';
import { processRecording, saveRecordingReport } from '../src/lib/server/recording-processing.js';
import {
	appendRecording,
	appendRecordingAudio,
	configureRecording,
	getRecording
} from '../src/lib/server/recordings.js';
import { insertStudy } from '../src/lib/server/studies.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
function wave(samples = 1600, amplitude = 1000) {
	const data = Buffer.alloc(samples * 2 + 44);
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
	for (let offset = 44; offset < data.length; offset += 2) data.writeInt16LE(amplitude, offset);
	return data;
}
function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys=ON');
	initializeSchema(db, schema);
	db.exec(`INSERT INTO modalities VALUES(1,'MR','MRI');
		INSERT INTO exam_types VALUES(1,'KNEE_WO','Knee without contrast');
		INSERT INTO users(id,full_name,role) VALUES(1,'Synthetic Resident','resident'),(2,'Synthetic Attending','attending');
		INSERT INTO report_templates(modality_id,exam_type_id,text) VALUES(1,1,'Findings: Synthetic template');`);
	const directory = mkdtempSync(join(tmpdir(), 'direct-report-test-'));
	const audio = join(directory, 'first.wav');
	writeFileSync(audio, wave());
	const second = join(directory, 'second.wav');
	writeFileSync(second, wave(800, -2000));
	const studyId = insertStudy(db, {
		patient_code: 'SYNTHETIC',
		patient_firstname: 'Synthetic',
		exam_date_jalali: '1405-08-05',
		exam_time: '09:00',
		corresponding_attending_id: 2
	});
	const recording = appendRecording(db, studyId, audio);
	configureRecording(db, studyId, recording.id, {
		modality_id: 1,
		exam_type_ids: [1],
		corresponding_resident_id: 1
	});
	const prior = {
		OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
		FFMPEG_PATH: process.env.FFMPEG_PATH
	};
	process.env.OPENAI_API_KEY = 'synthetic-openai-key';
	delete process.env.ELEVENLABS_API_KEY;
	t.after(() => {
		for (const [name, value] of Object.entries(prior)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return { db, directory, audio, second, studyId, id: recording.id };
}
const completed = () => ({
	ok: true,
	json: async () => ({
		choices: [{ finish_reason: 'stop', message: { content: 'A joint effusion is present.' } }]
	})
});
const conversionDirs = () =>
	readdirSync(tmpdir())
		.filter((name) => name.startsWith('radiology-audio-'))
		.sort();

test('generation mode defaults to existing pipeline, persists strictly and invalid settings never overwrite it', (t) => {
	const { db } = fixture(t);
	assert.deepEqual(getReportGenerationSettings(db), { mode: 'transcribe_then_generate' });
	setReportGenerationSettings(db, { mode: 'direct_audio' });
	for (const value of [
		null,
		{},
		[],
		{ mode: 'other' },
		{ mode: 'direct_audio', model: 'arbitrary' }
	]) {
		assert.throws(() => setReportGenerationSettings(db, value));
		assert.deepEqual(getReportGenerationSettings(db), { mode: 'direct_audio' });
	}
	initializeSchema(db, schema);
	assert.deepEqual(getReportGenerationSettings(db), { mode: 'direct_audio' });
	db.prepare(
		"UPDATE application_settings SET value='broken' WHERE key='report_generation_settings'"
	).run();
	assert.throws(() => getReportGenerationSettings(db), /Saved reporting settings are invalid/);
});

test('audio preparation produces one valid WAV with every decoded sample in original part order and removes temporary files', async (t) => {
	const { audio, second } = fixture(t);
	const before = conversionDirs();
	const prepared = Buffer.from(
		await prepareDirectAudio([{ audio_report_path: audio }, { audio_report_path: second }]),
		'base64'
	);
	assert.equal(prepared.toString('ascii', 0, 4), 'RIFF');
	assert.equal(prepared.toString('ascii', 8, 12), 'WAVE');
	assert.equal(prepared.readUInt32LE(4), prepared.length - 8);
	assert.equal(prepared.readUInt32LE(24), 16000);
	assert.equal(prepared.readUInt16LE(22), 1);
	assert.equal(prepared.readUInt32LE(40), 4800);
	assert.deepEqual(prepared.subarray(44, 3244), wave().subarray(44));
	assert.deepEqual(prepared.subarray(3244), wave(800, -2000).subarray(44));
	assert.deepEqual(conversionDirs(), before);
});

test('Telegram OGG/Opus, browser WebM, M4A/AAC and MP3 parts are decoded rather than mislabeled as WAV', async (t) => {
	const { audio, directory } = fixture(t);
	for (const [extension, encoder] of [
		['ogg', 'libopus'],
		['webm', 'libopus'],
		['m4a', 'aac'],
		['aac', 'aac'],
		['mp3', 'libmp3lame']
	]) {
		const output = join(directory, `synthetic.${extension}`);
		execFileSync(
			process.env.FFMPEG_PATH || 'ffmpeg',
			['-hide_banner', '-loglevel', 'error', '-i', audio, '-c:a', encoder, output],
			{ windowsHide: true }
		);
		const data = Buffer.from(await prepareDirectAudio([{ audio_report_path: output }]), 'base64');
		assert.equal(data.toString('ascii', 0, 4), 'RIFF');
		assert.ok(data.length > 44);
		assert.ok(data.readUInt32LE(40) <= 6400);
	}
});

test('direct processing sends joined audio once with clinical instructions and bypasses even broken transcription settings', async (t) => {
	const { db, directory, second, studyId, id } = fixture(t);
	appendRecordingAudio(db, studyId, id, second, null, { id: 1, role: 'resident' });
	setReportGenerationSettings(db, { mode: 'direct_audio' });
	setTranscriptionSettings(db, { provider: 'elevenlabs', model: 'scribe_v2' });
	db.prepare(
		"UPDATE application_settings SET value='broken' WHERE key='transcription_settings'"
	).run();
	setAttendingReportPreferences(db, 2, { english_variant: 'american' });
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls++;
		assert.equal(url, 'https://api.openai.com/v1/chat/completions');
		assert.equal(options.headers.Authorization, 'Bearer synthetic-openai-key');
		const payload = JSON.parse(options.body);
		assert.equal(payload.model, 'gpt-audio-1.5');
		assert.deepEqual(payload.modalities, ['text']);
		assert.equal(payload.messages[0].role, 'system');
		const prompt = payload.messages[0].content;
		assert.match(prompt, /US English spelling and phrasing/);
		assert.match(prompt, /complete grammatical sentence/);
		assert.match(prompt, /Do not invent findings/);
		assert.match(
			prompt,
			/Preserve Persian and English clinical meaning, negation, uncertainty, laterality, measurements/
		);
		assert.match(prompt, /all|every recording part/);
		assert.match(prompt, /Synthetic template/);
		const content = payload.messages[1].content;
		assert.equal(content.length, 1);
		assert.equal(content[0].type, 'input_audio');
		assert.equal(content[0].input_audio.format, 'wav');
		const samples = Buffer.from(content[0].input_audio.data, 'base64');
		assert.equal(samples.readUInt32LE(40), 4800);
		assert.equal(samples.readInt16LE(44), 1000);
		assert.equal(samples.readInt16LE(3244), -2000);
		return completed();
	});
	const pending = processRecording(db, studyId, id, undefined, directory);
	setReportGenerationSettings(db, { mode: 'transcribe_then_generate' });
	setAttendingReportPreferences(db, 2, { english_variant: 'british' });
	const result = await pending;
	assert.equal(calls, 1);
	assert.equal(readFileSync(result.path, 'utf8'), 'A joint effusion is present.');
	assert.equal(getRecording(db, studyId, id).processing, 0);
});

test('missing OpenAI credentials fail before upload or processing claim in direct mode', async (t) => {
	const { db, directory, studyId, id } = fixture(t);
	setReportGenerationSettings(db, { mode: 'direct_audio' });
	delete process.env.OPENAI_API_KEY;
	t.mock.method(globalThis, 'fetch', async () => assert.fail('No upload without credentials'));
	await assert.rejects(processRecording(db, studyId, id, undefined, directory), { status: 501 });
	assert.equal(getRecording(db, studyId, id).processing, 0);
});

test('conversion errors, missing FFmpeg and oversized recordings preserve old reports and clear locks without uploads', async (t) => {
	for (const scenario of [
		'invalid',
		'missing-ffmpeg',
		'too-long',
		'multipart-too-long',
		'playlist'
	])
		await t.test(scenario, async (t) => {
			const { db, audio, second, directory, studyId, id } = fixture(t);
			const path = saveRecordingReport(db, id, 'Previous report.', directory);
			setReportGenerationSettings(db, { mode: 'direct_audio' });
			if (scenario === 'invalid') writeFileSync(audio, 'synthetic invalid audio');
			if (scenario === 'missing-ffmpeg')
				process.env.FFMPEG_PATH = join(directory, 'missing-ffmpeg');
			if (scenario === 'too-long')
				writeFileSync(audio, wave(16000 * (MAX_DIRECT_AUDIO_SECONDS + 1), 0));
			if (scenario === 'multipart-too-long') {
				writeFileSync(audio, wave(16000 * 301, 0));
				writeFileSync(second, wave(16000 * 301, 0));
				appendRecordingAudio(db, studyId, id, second, null, { id: 1, role: 'resident' });
			}
			if (scenario === 'playlist')
				writeFileSync(audio, '#EXTM3U\nhttp://127.0.0.1:1/blocked-audio\n');
			const before = conversionDirs();
			t.mock.method(globalThis, 'fetch', async () =>
				assert.fail('Conversion must finish before any API request')
			);
			await assert.rejects(processRecording(db, studyId, id, undefined, directory), (error) => {
				assert.match(
					error.message,
					scenario === 'missing-ffmpeg'
						? /requires ffmpeg/
						: scenario.includes('too-long')
							? /10 minutes/
							: /conversion failed/
				);
				assert.doesNotMatch(error.message, /synthetic invalid audio|blocked-audio/);
				return true;
			});
			assert.equal(getRecording(db, studyId, id).text_report_path, path);
			assert.equal(readFileSync(path, 'utf8'), 'Previous report.');
			assert.equal(getRecording(db, studyId, id).processing, 0);
			assert.deepEqual(conversionDirs(), before);
		});
});

test('direct API errors, refusals and incomplete/empty responses never save partial output or silently fall back', async (t) => {
	for (const scenario of [
		'http',
		'network',
		'json',
		'null',
		'refusal',
		'length',
		'filter',
		'empty',
		'missing'
	])
		await t.test(scenario, async (t) => {
			const { db, directory, studyId, id } = fixture(t);
			const path = saveRecordingReport(db, id, 'Previous report.', directory);
			setReportGenerationSettings(db, { mode: 'direct_audio' });
			let calls = 0;
			t.mock.method(globalThis, 'fetch', async (url) => {
				calls++;
				assert.equal(url, 'https://api.openai.com/v1/chat/completions');
				if (scenario === 'network') throw new Error('sensitive-provider-content');
				if (scenario === 'http')
					return { ok: false, status: 403, text: async () => 'sensitive-provider-content' };
				return {
					ok: true,
					json: async () => {
						if (scenario === 'json') throw new Error('sensitive-provider-content');
						if (scenario === 'null') return null;
						if (scenario === 'missing') return {};
						return {
							choices: [
								{
									finish_reason:
										scenario === 'length'
											? 'length'
											: scenario === 'filter'
												? 'content_filter'
												: 'stop',
									message: {
										content: scenario === 'empty' ? ' ' : 'Partial unsafe-to-save report',
										refusal: scenario === 'refusal' ? 'sensitive-provider-content' : null
									}
								}
							]
						};
					}
				};
			});
			await assert.rejects(processRecording(db, studyId, id, undefined, directory), (error) => {
				assert.doesNotMatch(
					error.message,
					/sensitive-provider-content|Partial unsafe-to-save report/
				);
				return true;
			});
			assert.equal(calls, 1);
			assert.equal(getRecording(db, studyId, id).text_report_path, path);
			assert.equal(readFileSync(path, 'utf8'), 'Previous report.');
			assert.equal(getRecording(db, studyId, id).processing, 0);
		});
});

test('direct mode does not bypass signed recording guards or mutate saved signatures when mode changes', async (t) => {
	const { db, directory, studyId, id } = fixture(t);
	const path = saveRecordingReport(db, id, 'Signed report.', directory);
	db.prepare('UPDATE study_recordings SET resident_checked=1,attending_checked=1 WHERE id=?').run(
		id
	);
	const before = getRecording(db, studyId, id);
	setReportGenerationSettings(db, { mode: 'direct_audio' });
	assert.deepEqual(getRecording(db, studyId, id), before);
	t.mock.method(globalThis, 'fetch', async () =>
		assert.fail('Signed recordings must never reach providers')
	);
	await assert.rejects(processRecording(db, studyId, id, undefined, directory), { status: 409 });
	assert.equal(readFileSync(path, 'utf8'), 'Signed report.');
});
