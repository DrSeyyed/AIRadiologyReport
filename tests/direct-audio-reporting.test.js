import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const completed = (text = 'A joint effusion is present.') => ({
	ok: true,
	json: async () => ({
		choices: [{ finish_reason: 'stop', message: { content: text } }]
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
		assert.match(payload.messages[0].content, /Never return JSON/);
		assert.match(payload.messages[0].content, /NO_USABLE_CLINICAL_DICTATION/);
		assert.equal(payload.messages[1].role, 'user');
		const content = payload.messages[1].content;
		assert.equal(content.length, 2);
		assert.equal(content[0].type, 'text');
		const prompt = content[0].text;
		assert.match(prompt, /US English spelling and phrasing/);
		assert.match(prompt, /complete grammatical sentence/);
		assert.match(prompt, /Do not invent findings/);
		assert.match(
			prompt,
			/Preserve Persian and English clinical meaning, negation, uncertainty, laterality, measurements/
		);
		assert.match(prompt, /all|every recording part/);
		assert.match(prompt, /Synthetic template/);
		assert.match(prompt, /Keep its headings and section order/);
		assert.match(prompt, /Replace template statements that conflict with the dictation/);
		assert.equal(content[1].type, 'input_audio');
		assert.equal(content[1].input_audio.format, 'wav');
		const samples = Buffer.from(content[1].input_audio.data, 'base64');
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

test('combined CT templates accompany audio in order and raw-newline JSON reports are saved losslessly as report text', async (t) => {
	const { db, directory, studyId, id } = fixture(t);
	db.exec(`INSERT INTO modalities VALUES(2,'CT','Computed Tomography');
		INSERT INTO exam_types VALUES(2,'CHEST','Chest'),(3,'ABDOMEN','Abdomen'),(4,'PELVIS','Pelvis');
		INSERT INTO report_templates(modality_id,exam_type_id,text) VALUES
		(2,2,'Chest template: Synthetic chest section.'),
		(2,3,'Abdomen template: Synthetic abdomen section.'),
		(2,4,'Pelvis template: Synthetic pelvis section.');`);
	configureRecording(db, studyId, id, {
		modality_id: 2,
		exam_type_ids: [4, 2, 3],
		corresponding_resident_id: 1
	});
	setReportGenerationSettings(db, { mode: 'direct_audio' });
	const text =
		'Study: Synthetic combined CT\nPelvis\nSynthetic pelvic report.\nChest\nSynthetic chest report.\nAbdomen\nSynthetic abdominal report.\n\nConclusion\nSynthetic combined conclusion.';
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls++;
		assert.equal(url, 'https://api.openai.com/v1/chat/completions');
		const content = JSON.parse(options.body).messages[1].content;
		const prompt = content[0].text;
		assert.match(prompt, /Pelvis template: Synthetic pelvis section/);
		assert.match(prompt, /Chest template: Synthetic chest section/);
		assert.match(prompt, /Abdomen template: Synthetic abdomen section/);
		assert.ok(prompt.indexOf('## Pelvis') < prompt.indexOf('## Chest'));
		assert.ok(prompt.indexOf('## Chest') < prompt.indexOf('## Abdomen'));
		assert.match(prompt, /exactly one shared Conclusion/);
		assert.match(prompt, /Preserve every supplied heading's wording and case/);
		assert.match(prompt, /Never convert Jalali\/Shamsi\/Solar Hijri dates to Gregorian or vice versa/);
		assert.equal(content[1].type, 'input_audio');
		const wrapped = '{"final_report":"' + text + '",\n}';
		assert.throws(() => JSON.parse(wrapped));
		return completed(wrapped);
	});
	const result = await processRecording(db, studyId, id, undefined, directory);
	assert.equal(calls, 1);
	assert.equal(result.text, text);
	assert.equal(readFileSync(result.path, 'utf8'), text);
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
		'missing',
		'duration',
		'duration-json',
		'wrapped-duration',
		'no-dictation',
		'malformed-wrapper'
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
				const unusable = {
					duration: 'Audio duration: 00:47',
					'duration-json': '{"duration":47}',
					'wrapped-duration': '{"final_report":"Audio duration: 00:47"}',
					'no-dictation': 'NO_USABLE_CLINICAL_DICTATION',
					'malformed-wrapper': '{"final_report":"truncated'
				};
				if (Object.hasOwn(unusable, scenario)) return completed(unusable[scenario]);
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

test('direct audio sends mandatory template and calendar rules for UK/US English and saves provider dates unchanged', async (t) => {
	for (const variant of ['british', 'american']) {
		for (const date of ['۱۴۰۴/۰۷/۱۲ (Jalali)', '12 Mehr 1404 (Shamsi)', '2025-02-03 (Gregorian)']) {
			await t.test(`${variant}: ${date}`, async (t) => {
				const { db, directory, studyId, id } = fixture(t);
				setReportGenerationSettings(db, { mode: 'direct_audio' });
				setAttendingReportPreferences(db, 2, { english_variant: variant });
				const template = 'TECHNIQUE:\nSynthetic technique.\nOBSERVATIONS:\nSynthetic findings.\nIMPRESSION:\nSynthetic summary.';
				db.prepare('UPDATE report_templates SET text=? WHERE modality_id=1 AND exam_type_id=1').run(template);
				const report = template.replace('Synthetic findings.', `The synthetic comparison date is ${date}.`);
				let calls = 0;
				t.mock.method(globalThis, 'fetch', async (url, options) => {
					calls++;
					assert.equal(url, 'https://api.openai.com/v1/chat/completions');
					const payload = JSON.parse(options.body);
					const system = payload.messages[0].content;
					assert.match(system, /template headings and section order are mandatory/);
					assert.match(system, /never convert Jalali\/Shamsi\/Solar Hijri dates to Gregorian or vice versa/);
					assert.match(system, /An English report does not require Gregorian dates/);
					const prompt = payload.messages[1].content[0].text;
					assert.match(prompt, /Preserve every supplied heading's wording and case/);
					assert.match(prompt, /keep sections in exactly the supplied order/);
					assert.match(prompt, /retain the template's existing conclusion, impression or summary heading exactly as supplied/);
					assert.match(prompt, /without inventing new sections/);
					assert.match(prompt, /Preserve dictated dates in their original calendar, year, month, day, order and precision/);
					assert.match(prompt, /Keep Jalali month names as Jalali month names/);
					assert.match(prompt, /Do not infer an unspecified calendar, expand a shortened year, or add missing date components/);
					assert.match(prompt, /Check every dictated date/);
					assert.match(prompt, variant === 'american' ? /Use American/ : /Use British/);
					assert.ok(prompt.includes(`Template:\n"${template}"`));
					assert.equal(payload.messages[1].content[1].type, 'input_audio');
					return completed(report);
				});
				const result = await processRecording(db, studyId, id, undefined, directory);
				assert.equal(calls, 1);
				assert.equal(result.text, report);
				assert.equal(readFileSync(result.path, 'utf8'), report);
				assert.equal(getRecording(db, studyId, id).processing, 0);
			});
		}
	}
});

async function loadRecordingHttp(db, t) {
	const key = `directAudioHttp_${randomUUID()}`;
	globalThis[key] = db;
	t.after(() => { delete globalThis[key]; });
	const url = new URL('../src/lib/server/recording-http.js', import.meta.url);
	const source = readFileSync(url, 'utf8').replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
		const resolved = specifier === '$lib/server/db'
			? `data:text/javascript,${encodeURIComponent(`export function getDb(){return globalThis[${JSON.stringify(key)}]}`)}`
			: specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier);
		return `from ${JSON.stringify(resolved)}`;
	});
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function inspectionEvent(studyId, recordingId, role = 'admin') {
	return { locals: { user: role ? { id: 99, role } : null }, params: { id: String(studyId), recordingId: String(recordingId) } };
}

test('administrator inspection returns the full raw provider JSON without parsing malformed report content or saving anything', async (t) => {
	const { db, directory, studyId, id } = fixture(t);
	const path = saveRecordingReport(db, id, 'Keep the existing report.', directory);
	const before = getRecording(db, studyId, id);
	const files = readdirSync(directory).sort();
	setReportGenerationSettings(db, { mode: 'direct_audio' });
	const raw = {
		id: 'synthetic-response', model: 'gpt-audio-1.5',
		choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: "{final_report: 'Synthetic report. <script>window.diagnosticExecuted = true</script>'}" } }],
		usage: { prompt_tokens: 12, completion_tokens: 8 }
	};
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls++;
		assert.equal(url, 'https://api.openai.com/v1/chat/completions');
		assert.equal(getRecording(db, studyId, id).processing, 1);
		assert.equal(JSON.parse(options.body).model, 'gpt-audio-1.5');
		return { ok: true, json: async () => raw };
	});
	const { inspectAudio } = await loadRecordingHttp(db, t);
	const response = await inspectAudio(inspectionEvent(studyId, id));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'private, no-store');
	const result = await response.json();
	assert.deepEqual(result, { ok: true, diagnostic: true, raw_response: raw });
	assert.doesNotMatch(JSON.stringify(result), /synthetic-openai-key|input_audio|Synthetic template/);
	assert.equal(calls, 1);
	assert.deepEqual(getRecording(db, studyId, id), before);
	assert.equal(readFileSync(path, 'utf8'), 'Keep the existing report.');
	assert.deepEqual(readdirSync(directory).sort(), files);
});

test('inspection exposes incomplete provider responses for diagnosis but never creates a report', async (t) => {
	const { db, directory, studyId, id } = fixture(t);
	setReportGenerationSettings(db, { mode: 'direct_audio' });
	const before = getRecording(db, studyId, id);
	const files = readdirSync(directory).sort();
	const raw = { choices: [{ finish_reason: 'length', message: { content: '{"final_report":"Synthetic truncated response' } }] };
	t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => raw }));
	const { inspectAudio } = await loadRecordingHttp(db, t);
	const response = await inspectAudio(inspectionEvent(studyId, id));
	assert.equal(response.status, 200);
	assert.deepEqual((await response.json()).raw_response, raw);
	assert.deepEqual(getRecording(db, studyId, id), before);
	assert.equal(getRecording(db, studyId, id).text_report_path, null);
	assert.deepEqual(readdirSync(directory).sort(), files);
});

test('raw response inspection rejects anonymous and non-admin callers before accessing the database', async (t) => {
	const { inspectAudio } = await loadRecordingHttp(null, t);
	t.mock.method(globalThis, 'fetch', async () => assert.fail('Unauthorized diagnostic request'));
	for (const role of [null, 'resident', 'attending', 'typist']) {
		const response = await inspectAudio(inspectionEvent(1, 1, role));
		assert.equal(response.status, role ? 403 : 401);
		assert.deepEqual(Object.keys(await response.json()), ['error']);
	}
});

test('inspection retains mode, signed, disabled, lock, reviewer, template, audio and study ownership guards', async (t) => {
	for (const scenario of ['pipeline-mode', 'signed', 'disabled', 'processing', 'resident', 'attending', 'template', 'audio', 'wrong-study']) {
		await t.test(scenario, async (t) => {
			const { db, directory, audio, studyId, id } = fixture(t);
			const path = saveRecordingReport(db, id, 'Existing guarded report.', directory);
			if (scenario !== 'pipeline-mode') setReportGenerationSettings(db, { mode: 'direct_audio' });
			if (scenario === 'signed') db.prepare('UPDATE study_recordings SET resident_checked=1 WHERE id=?').run(id);
			if (scenario === 'disabled') db.prepare('UPDATE studies SET disabled=1 WHERE id=?').run(studyId);
			if (scenario === 'processing') db.prepare('UPDATE study_recordings SET processing=1,processing_started_at=? WHERE id=?').run(Math.floor(Date.now() / 1000), id);
			if (scenario === 'resident') db.prepare('UPDATE study_recordings SET corresponding_resident_id=NULL WHERE id=?').run(id);
			if (scenario === 'attending') db.prepare('UPDATE studies SET corresponding_attending_id=NULL WHERE id=?').run(studyId);
			if (scenario === 'template') db.exec('DELETE FROM report_templates');
			if (scenario === 'audio') rmSync(audio);
			const before = getRecording(db, studyId, id);
			t.mock.method(globalThis, 'fetch', async () => assert.fail('Guarded diagnostic request must not upload audio'));
			const { inspectAudio } = await loadRecordingHttp(db, t);
			const response = await inspectAudio(inspectionEvent(scenario === 'wrong-study' ? studyId + 1 : studyId, id));
			assert.ok(response.status >= 400);
			assert.deepEqual(Object.keys(await response.json()), ['error']);
			assert.deepEqual(getRecording(db, studyId, id), before);
			assert.equal(readFileSync(path, 'utf8'), 'Existing guarded report.');
		});
	}
});

test('inspection transport errors release the processing lock and preserve reports without exposing response bodies', async (t) => {
	const { db, directory, studyId, id } = fixture(t);
	const path = saveRecordingReport(db, id, 'Keep this report.', directory);
	setReportGenerationSettings(db, { mode: 'direct_audio' });
	const before = getRecording(db, studyId, id);
	t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500, text: async () => 'synthetic-provider-secret' }));
	const { inspectAudio } = await loadRecordingHttp(db, t);
	const response = await inspectAudio(inspectionEvent(studyId, id));
	assert.equal(response.status, 500);
	assert.deepEqual(await response.json(), { error: 'Direct audio reporting failed (HTTP 500).' });
	assert.deepEqual(getRecording(db, studyId, id), before);
	assert.equal(readFileSync(path, 'utf8'), 'Keep this report.');
});
