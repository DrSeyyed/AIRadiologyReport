import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_TRANSCRIPT_TOOL_NAME, AudioTranscriptFormatError, audioTranscriptionChoice, normalizeAudioTranscriptOutput } from '../src/lib/server/audio-transcript-output.js';
import { transcribeWithAudioModel } from '../src/lib/server/audio-model-transcription.js';

const transcript = 'سمت چپ low T1، high T2؛ 1.5 mm.\nتاریخ ۲۲ اسفند ۱۴۰۵؛ no right-sided restriction.';
const toolChoice = (args = JSON.stringify({ transcript })) => ({
	finish_reason: 'tool_calls', message: { content: null, tool_calls: [{
		id: 'synthetic-call', type: 'function', function: { name: AUDIO_TRANSCRIPT_TOOL_NAME, arguments: args }
	}] }
});

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
		values.push(JSON.stringify({ [field]: transcript, language: null, confidence: 0.95, metadata: { duration: 60 }, segments: [] }));
	}
	for (const language of ['', 'text', 'json', 'markdown', 'md', 'transcript', 'transcription']) {
		values.push(`\`\`\`${language}\n${transcript}\n\`\`\``);
		values.push(`\`\`\`${language}\r\n${JSON.stringify({ transcript })}\r\n\`\`\``);
	}
	values.push(JSON.stringify(`\`\`\`json\n${JSON.stringify({ text: JSON.stringify(transcript) })}\n\`\`\``));
	values.push(JSON.stringify({ transcript, text: `  ${transcript}  `, language: null }));
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
		JSON.stringify({ text: 'Different dictation', transcript: privateText }),
		JSON.stringify({ transcript: privateText, report: privateText }),
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
		assert.match(payload.messages[0].content, /verbatim, not a report/);
		assert.equal(payload.tool_choice.function.name, AUDIO_TRANSCRIPT_TOOL_NAME);
		assert.equal(payload.parallel_tool_calls, false);
		assert.deepEqual(payload.tools[0].function.parameters.required, ['transcript']);
		assert.equal(payload.tools[0].function.parameters.additionalProperties, false);
		assert.equal(payload.tools[0].function.strict, undefined);
		assert.equal(payload.response_format, undefined);
		assert.equal(payload.messages[1].content[1].input_audio.data, 'synthetic-prepared-audio');
		return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: {
			content: `\`\`\`json\n${JSON.stringify({ transcription: transcript })}\n\`\`\``
		} }] }) };
	});
	assert.equal(await transcribeWithAudioModel('unused.wav', 'Preserve original dictation.', 'synthetic-prepared-audio'), transcript);
	assert.equal(calls, 1);
});

test('complete transcript tool calls accept both stop and tool_calls finish reasons with null content', () => {
	for (const finish_reason of ['stop', 'tool_calls']) {
		assert.equal(audioTranscriptionChoice({ ...toolChoice(), finish_reason }), transcript);
		assert.equal(audioTranscriptionChoice({ ...toolChoice(JSON.stringify({ transcript, confidence: null })), finish_reason }), transcript);
		for (const args of ['not JSON', '[]', 'null', '{}', '{"transcript":12}', '{"text":"synthetic text"}', '{"transcript":"unfinished', null]) {
			assert.throws(() => audioTranscriptionChoice({ ...toolChoice(args), finish_reason }), AudioTranscriptFormatError);
		}
	}
	const wrong = toolChoice();
	wrong.message.tool_calls[0].function.name = 'generate_report';
	assert.throws(() => audioTranscriptionChoice(wrong), /expected one transcript submission/);
	assert.throws(() => audioTranscriptionChoice({ ...toolChoice(), finish_reason: 'length' }), /not completed/);
	assert.throws(() => audioTranscriptionChoice({ ...toolChoice(), message: { ...toolChoice().message, refusal: 'synthetic-private-refusal' } }), /declined/);
});

test('tool-call payload validation rejects missing, duplicate and incomplete submissions', () => {
	for (const choice of [
		{ finish_reason: 'tool_calls', message: { content: null } },
		{ finish_reason: 'tool_calls', message: { tool_calls: [] } },
		{ finish_reason: 'tool_calls', message: { tool_calls: [null] } },
		{ finish_reason: 'tool_calls', message: { tool_calls: [...toolChoice().message.tool_calls, ...toolChoice().message.tool_calls] } },
		{ finish_reason: 'stop', message: { tool_calls: [null] } },
		{ finish_reason: 'stop', message: { tool_calls: [...toolChoice().message.tool_calls, ...toolChoice().message.tool_calls] } }
	]) assert.throws(() => audioTranscriptionChoice(choice), AudioTranscriptFormatError);
});

test('stop with a complete transcript tool call succeeds without retrying the audio', async (t) => {
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => {
		calls++;
		return { ok: true, json: async () => ({ choices: [{ ...toolChoice(), finish_reason: 'stop' }] }) };
	});
	assert.equal(await transcribeWithAudioModel('unused.wav', 'Transcribe.', 'original-audio'), transcript);
	assert.equal(calls, 1);
});

test('metadata-only, wrong-schema and malformed format results retry original audio once using the same model', async (t) => {
	for (const content of [JSON.stringify({ language: 'fa', duration: 60 }), JSON.stringify({ final_report: 'Synthetic generated report, not dictation.' }), 'Audio duration: 60 seconds', '{transcript: "synthetic text"}']) {
		await t.test(content.startsWith('{') ? 'structured format' : 'duration metadata', async (t) => {
			const requests = [];
			t.mock.method(globalThis, 'fetch', async (_url, options) => {
				requests.push(JSON.parse(options.body));
				return { ok: true, json: async () => ({ choices: [requests.length === 1 ? {
					finish_reason: 'stop', message: { content }
				} : toolChoice()] }) };
			});
			assert.equal(await transcribeWithAudioModel('unused.wav', 'Preserve negation and dates.', 'original-audio'), transcript);
			assert.equal(requests.length, 2);
			for (const payload of requests) {
				assert.equal(payload.model, 'gpt-audio-1.5');
				assert.equal(payload.tool_choice.function.name, 'submit_transcript');
				assert.equal(payload.messages.length, 2);
				assert.equal(payload.messages[1].content[1].input_audio.data, 'original-audio');
			}
			assert.doesNotMatch(requests[0].messages[0].content, /previous attempt/);
			assert.match(requests[1].messages[0].content, /Listen to the original audio again/);
			assert.ok(!JSON.stringify(requests[1]).includes(content));
		});
	}
});

test('malformed tool arguments get one correction attempt and persistent format failures stop after two calls', async (t) => {
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => {
		calls++;
		return { ok: true, json: async () => ({ choices: [toolChoice('{"final_report":"synthetic-private-text"}')] }) };
	});
	await assert.rejects(transcribeWithAudioModel('unused.wav', 'Transcribe.', 'original-audio'), (error) => {
		assert.ok(error instanceof AudioTranscriptFormatError);
		assert.doesNotMatch(error.message, /synthetic-private-text/);
		return true;
	});
	assert.equal(calls, 2);
});

test('valid metadata-rich legacy transcript envelopes do not need a retry', async (t) => {
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => {
		calls++;
		return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: {
			content: JSON.stringify({ transcript, language: null, confidence: 0.9, timestamps: [] })
		} }] }) };
	});
	assert.equal(await transcribeWithAudioModel('unused.wav', 'Transcribe.', 'original-audio'), transcript);
	assert.equal(calls, 1);
});
