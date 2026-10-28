import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAudioTranscriptOutput } from '../src/lib/server/audio-transcript-output.js';
import { transcribeWithAudioModel } from '../src/lib/server/audio-model-transcription.js';

const transcript = 'سمت چپ low T1، high T2؛ 1.5 mm.\nتاریخ ۲۲ اسفند ۱۴۰۵؛ no right-sided restriction.';

test('audio transcripts retain original words, line breaks, numbers and calendar notation', () => {
	assert.equal(normalizeAudioTranscriptOutput(`  ${transcript}  `), transcript);
	assert.equal(normalizeAudioTranscriptOutput('[inaudible] No right-sided restriction.'), '[inaudible] No right-sided restriction.');
	assert.equal(normalizeAudioTranscriptOutput('"high T2" signal was dictated.'), '"high T2" signal was dictated.');
});

test('explicit transcript envelopes and code fences are unwrapped without rewriting dictation', () => {
	const values = [JSON.stringify(transcript)];
	for (const field of ['text', 'transcript', 'transcription']) {
		values.push(JSON.stringify({ [field]: transcript }));
		values.push(JSON.stringify({ [field]: transcript, language: 'fa', duration: 12, duration_seconds: 12.5 }));
	}
	for (const language of ['', 'text', 'json', 'markdown', 'md', 'transcript', 'transcription']) {
		values.push(`\`\`\`${language}\n${transcript}\n\`\`\``);
		values.push(`\`\`\`${language}\r\n${JSON.stringify({ transcript })}\r\n\`\`\``);
	}
	values.push(JSON.stringify(`\`\`\`json\n${JSON.stringify({ text: JSON.stringify(transcript) })}\n\`\`\``));
	for (const value of values) assert.equal(normalizeAudioTranscriptOutput(value), transcript);
});

test('transport-only repairs preserve literal line breaks and do not invent clinical text', () => {
	assert.equal(normalizeAudioTranscriptOutput(`{"transcript":"${transcript}",}`), transcript);
	assert.equal(normalizeAudioTranscriptOutput('{"text":"A \\"quoted\\" term; 1.5 mm.\nNo restriction.",}'), 'A "quoted" term; 1.5 mm.\nNo restriction.');
});

test('duration-only, silence and unclear-only responses are not sent as clinical dictation', () => {
	for (const value of ['Audio duration: 12 seconds', 'Duration = 00:12', 'The audio is approximately 2 minutes long.', '12.5', 'NO_USABLE_CLINICAL_DICTATION', 'No intelligible clinical dictation was detected.', '[inaudible]', '[unclear] [unintelligible]']) {
		for (const wrapped of [value, JSON.stringify({ transcript: value }), `\`\`\`text\n${value}\n\`\`\``]) {
			assert.throws(() => normalizeAudioTranscriptOutput(wrapped), /no usable text|only audio duration or metadata/);
		}
	}
});

test('malformed, ambiguous, report and unsupported wrappers remain rejected without leaking content', () => {
	const privateText = 'synthetic-private-provider-text';
	for (const value of [undefined, null, {}, [], '', ' ',
		`{"transcript":"${privateText}"`, `{transcript: "${privateText}"}`,
		JSON.stringify({ final_report: privateText }), JSON.stringify({ report: privateText }),
		JSON.stringify({ duration: 12 }), JSON.stringify({ transcript: 12 }),
		JSON.stringify({ text: privateText, transcript: privateText }),
		JSON.stringify({ transcript: privateText, report: privateText }),
		JSON.stringify({ transcript: privateText, language: {} }),
		JSON.stringify([privateText]), `\`\`\`javascript\n${privateText}\n\`\`\``,
		`\`\`\`text\n${privateText}`]) {
		assert.throws(() => normalizeAudioTranscriptOutput(value), (error) => {
			assert.match(error.message, /audio-model transcription/);
			assert.doesNotMatch(error.message, /synthetic-private-provider-text/);
			return true;
		});
	}
	let nested = transcript;
	for (let index = 0; index < 5; index++) nested = JSON.stringify({ text: nested });
	assert.throws(() => normalizeAudioTranscriptOutput(nested), /too many nested wrappers/);
});

test('audio-model request normalizes wrapped output before returning it to the existing generator', async (t) => {
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls++;
		assert.equal(url, 'https://api.openai.com/v1/chat/completions');
		const payload = JSON.parse(options.body);
		assert.deepEqual(payload.modalities, ['text']);
		assert.match(payload.messages[0].content, /verbatim transcript, not a report/);
		assert.equal(payload.messages[1].content[1].input_audio.data, 'synthetic-prepared-audio');
		return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: {
			content: `\`\`\`json\n${JSON.stringify({ transcription: transcript })}\n\`\`\``
		} }] }) };
	});
	assert.equal(await transcribeWithAudioModel('unused.wav', 'Preserve original dictation.', 'synthetic-prepared-audio'), transcript);
	assert.equal(calls, 1);
});
