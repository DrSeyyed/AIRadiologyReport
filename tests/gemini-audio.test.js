import test from 'node:test';
import assert from 'node:assert/strict';
import { generateGeminiAudioText } from '../src/lib/server/gemini-audio.js';

const models = ['gemini-3.8-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'];
const privateText = 'synthetic-private-clinical-text';
const key = 'synthetic-server-secret';
const transcript = 'سمت چپ low T1؛ 1.5 mm.\nNo restriction. ۲۲ اسفند ۱۴۰۵';
const transcriptJson = JSON.stringify({ transcript });

function wavData(samples = 2) {
	const wav = Buffer.alloc(44 + samples * 2);
	wav.write('RIFF');
	wav.writeUInt32LE(wav.length - 8, 4);
	wav.write('WAVEfmt ', 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(16000, 24);
	wav.writeUInt32LE(32000, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write('data', 36);
	wav.writeUInt32LE(samples * 2, 40);
	return wav.toString('base64');
}

function args(overrides = {}) {
	return {
		model: models[0],
		audio: { data: wavData(), format: 'wav', sampleRate: 16000 },
		instructions: 'Preserve original dictation and dates.',
		task: 'transcription',
		...overrides
	};
}

function completed(text = transcriptJson, extra = {}) {
	return {
		status: 'completed',
		steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
		...extra
	};
}

function setup(t, implementation = async () => Response.json(completed())) {
	const oldKey = process.env.GEMINI_API_KEY;
	process.env.GEMINI_API_KEY = key;
	t.after(() => {
		if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
		else process.env.GEMINI_API_KEY = oldKey;
	});
	return t.mock.method(globalThis, 'fetch', implementation);
}

async function rejectsSafely(promise, pattern) {
	await assert.rejects(promise, (error) => {
		assert.match(error.message, /^Gemini audio:/);
		assert.match(error.message, pattern);
		assert.doesNotMatch(
			error.message,
			new RegExp(`${privateText}|${key}|generativelanguage|https:`)
		);
		assert.equal(error.cause, undefined);
		return true;
	});
}

for (const model of models) {
	test(`${model} uses stateless Interactions REST and transcript-only JSON`, async (t) => {
		const mock = setup(t, async (url, options) => {
			assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
			assert.equal(options.method, 'POST');
			assert.equal(options.redirect, 'error');
			assert.deepEqual(options.headers, {
				'Content-Type': 'application/json',
				'x-goog-api-key': key
			});
			assert.ok(options.signal instanceof AbortSignal);
			const payload = JSON.parse(options.body);
			assert.equal(payload.model, model);
			assert.equal(payload.store, false);
			assert.equal(payload.stream, false);
			assert.equal(payload.background, false);
			assert.equal(payload.system_instruction, args().instructions);
			assert.equal(payload.previous_interaction_id, undefined);
			assert.equal(payload.tools, undefined);
			assert.equal(payload.generation_config.max_output_tokens, 32768);
			assert.match(payload.input[0].text, /verbatim.*original language/);
			assert.deepEqual(payload.input[1], {
				type: 'audio',
				data: wavData(),
				mime_type: 'audio/wav'
			});
			assert.deepEqual(payload.response_format, {
				type: 'text',
				mime_type: 'application/json',
				schema: {
					type: 'object',
					properties: { transcript: { type: 'string' } },
					required: ['transcript'],
					additionalProperties: false
				}
			});
			assert.doesNotMatch(options.body, new RegExp(key));
			return Response.json(completed(transcriptJson, { model }));
		});
		assert.equal(await generateGeminiAudioText(args({ model })), transcriptJson);
		assert.equal(mock.mock.callCount(), 1);
	});
}

test('report requests enforce plain text, preserve instructions and do not normalize output', async (t) => {
	const text = '\n  FINDINGS:\nسمت چپ 1.5 mm.\nIMPRESSION: No restriction.  ';
	setup(t, async (_, options) => {
		const payload = JSON.parse(options.body);
		assert.deepEqual(payload.response_format, { type: 'text', mime_type: 'text/plain' });
		assert.match(payload.input[0].text, /final report text/);
		assert.equal(payload.system_instruction, privateText);
		return Response.json(completed(text));
	});
	assert.equal(
		await generateGeminiAudioText(args({ task: 'report', instructions: privateText })),
		text
	);
});

test('ignores thought steps and echoed user input, joins only a single final output', async (t) => {
	setup(t, async () =>
		Response.json(
			completed('', {
				steps: [
					{ type: 'user_input', content: [{ type: 'text', text: privateText }] },
					{ type: 'thought', summary: [{ type: 'text', text: privateText }] },
					{
						type: 'model_output',
						status: 'done',
						content: [
							{ type: 'text', text: privateText, thought: true },
							{ type: 'text', text: transcriptJson.slice(0, 20) },
							{ type: 'text', text: transcriptJson.slice(20) }
						]
					}
				]
			})
		)
	);
	assert.equal(await generateGeminiAudioText(args()), transcriptJson);
});

test('rejects unsupported models, tasks, missing instructions and missing server credentials before fetch', async (t) => {
	const mock = setup(t);
	for (const model of [
		'',
		undefined,
		'gemini-3.8-flash-preview',
		'gemini-flash-latest',
		'gemini-2.0-flash',
		privateText
	]) {
		await rejectsSafely(generateGeminiAudioText(args({ model })), /unsupported model/);
	}
	for (const task of [undefined, '', 'translate', privateText])
		await rejectsSafely(generateGeminiAudioText(args({ task })), /task must/);
	for (const instructions of [undefined, '', ' ', {}, 3])
		await rejectsSafely(generateGeminiAudioText(args({ instructions })), /instructions/);
	for (const value of ['', '  ']) {
		process.env.GEMINI_API_KEY = value;
		await rejectsSafely(generateGeminiAudioText(args()), /GEMINI_API_KEY is not configured/);
	}
	delete process.env.GEMINI_API_KEY;
	await rejectsSafely(generateGeminiAudioText(args()), /GEMINI_API_KEY is not configured/);
	await rejectsSafely(generateGeminiAudioText(), /unsupported model/);
	assert.equal(mock.mock.callCount(), 0);
});

test('validates base64, complete WAV chunks, mono, sample rate and PCM16 without sending audio', async (t) => {
	const mock = setup(t);
	const audio = args().audio;
	for (const invalid of [
		null,
		undefined,
		{},
		{ ...audio, format: 'mp3' },
		{ ...audio, sampleRate: 44100 },
		{ ...audio, data: '' },
		{ ...audio, data: 3 },
		{ ...audio, data: '!!!!' },
		{ ...audio, data: 'YWJj\n' },
		{ ...audio, data: 'AB==' },
		{ ...audio, data: Buffer.from(privateText).toString('base64') }
	]) {
		await rejectsSafely(generateGeminiAudioText(args({ audio: invalid })), /audio|WAV/);
	}
	const mutations = [
		(wav) => wav.write('RF64', 0),
		(wav) => wav.write('XXXX', 8),
		(wav) => wav.writeUInt32LE(1000, 4),
		(wav) => wav.writeUInt16LE(2, 22),
		(wav) => wav.writeUInt32LE(48000, 24),
		(wav) => wav.writeUInt16LE(3, 20),
		(wav) => wav.writeUInt16LE(8, 34),
		(wav) => wav.writeUInt32LE(2, 16),
		(wav) => wav.writeUInt32LE(99999, 40),
		(wav) => wav.writeUInt32LE(3, 40),
		(wav) => wav.write('JUNK', 36)
	];
	for (const mutate of mutations) {
		const wav = Buffer.from(audio.data, 'base64');
		mutate(wav);
		await rejectsSafely(
			generateGeminiAudioText(args({ audio: { ...audio, data: wav.toString('base64') } })),
			/WAV|PCM16/
		);
	}
	await rejectsSafely(
		generateGeminiAudioText(args({ audio: { ...audio, data: wavData(0) } })),
		/samples/
	);
	assert.equal(mock.mock.callCount(), 0);
});

test('accepts complete piped WAV with unknown lengths and padded metadata chunks', async (t) => {
	const original = Buffer.from(wavData(), 'base64');
	const metadata = Buffer.alloc(10);
	metadata.write('JUNK');
	metadata.writeUInt32LE(1, 4);
	metadata[8] = 42;
	const wav = Buffer.concat([original.subarray(0, 36), metadata, original.subarray(36)]);
	wav.writeUInt32LE(0xffffffff, 4);
	wav.writeUInt32LE(0xffffffff, 50);
	setup(t);
	assert.equal(
		await generateGeminiAudioText(
			args({ audio: { ...args().audio, data: wav.toString('base64') } })
		),
		transcriptJson
	);
});

test('supports sizeable valid base64 audio without truncating it', async (t) => {
	const data = wavData(600_000);
	setup(t, async (_, options) => {
		assert.equal(JSON.parse(options.body).input[1].data, data);
		return Response.json(completed());
	});
	assert.equal(
		await generateGeminiAudioText(args({ audio: { ...args().audio, data } })),
		transcriptJson
	);
});

test('caps the full UTF-8 request at exactly 20,000,000 bytes including prompts and base64', async (t) => {
	let initialSize;
	const mock = setup(t, async (_, options) => {
		const size = Buffer.byteLength(options.body, 'utf8');
		if (initialSize === undefined) initialSize = size;
		else assert.equal(size, 20_000_000);
		return Response.json(completed());
	});
	await generateGeminiAudioText(args({ instructions: 'a' }));
	const exactInstructions = 'a'.repeat(20_000_000 - initialSize + 1);
	await generateGeminiAudioText(args({ instructions: exactInstructions }));
	await rejectsSafely(
		generateGeminiAudioText(args({ instructions: `${exactInstructions}a` })),
		/20,000,000 bytes/
	);
	await rejectsSafely(
		generateGeminiAudioText(args({ instructions: 'ا'.repeat(10_000_000) })),
		/20,000,000 bytes/
	);
	await rejectsSafely(
		generateGeminiAudioText(args({ audio: { ...args().audio, data: 'A'.repeat(20_000_001) } })),
		/20,000,000 bytes/
	);
	assert.equal(mock.mock.callCount(), 2);
});

test('rejects incomplete, blocked, continuation and faulty interactions without accepting partial text', async (t) => {
	let response;
	setup(t, async () => Response.json(response));
	for (const status of [
		undefined,
		null,
		'in_progress',
		'requires_action',
		'failed',
		'cancelled',
		'incomplete',
		'budget_exceeded',
		'requires_continuation',
		'COMPLETED'
	]) {
		response = completed(privateText, { status });
		await rejectsSafely(generateGeminiAudioText(args()), /did not complete/);
	}
	for (const extra of [
		{ model: 'gemini-flash-latest' },
		{ error: { message: privateText } },
		{ errors: [{ code: 'SAFETY', message: privateText }] },
		{ errors: privateText },
		{ continuation_token: privateText },
		{ refusal: privateText },
		{ block_reason: 'SAFETY' },
		{ finishReason: 'MAX_TOKENS' },
		{ finish_reason: 'SAFETY' },
		{ safety_ratings: [{ blocked: true }] },
		{ safety_ratings: { some: privateText } },
		{ safetyRatings: [null] },
		{ prompt_feedback: { block_reason: 'SAFETY' } },
		{ promptFeedback: { blockReason: 'SAFETY' } }
	]) {
		response = completed(privateText, extra);
		await rejectsSafely(generateGeminiAudioText(args()), /unexpected model|refusal|incomplete/);
	}
});

test('rejects malformed steps, multiple final outputs, tool calls, refusal and non-text content', async (t) => {
	let response;
	setup(t, async () => Response.json(response));
	const output = completed().steps[0];
	for (const steps of [
		undefined,
		null,
		{},
		[],
		[null],
		['text'],
		[{ type: 'thought' }],
		[output, output],
		[{ type: 'function_call', name: privateText }, output],
		[{ ...output, status: 'in_progress' }],
		[{ ...output, finishReason: 'SAFETY' }],
		[{ ...output, content: null }],
		[{ ...output, content: [] }],
		[{ ...output, content: [null] }],
		[{ ...output, content: [{ type: 'audio', data: privateText }] }],
		[{ ...output, content: [{ type: 'refusal', text: privateText }] }],
		[{ ...output, content: [{ type: 'text', text: 3 }] }],
		[{ ...output, content: [{ type: 'text', text: privateText, refusal: true }] }]
	]) {
		response = completed('', { steps });
		await rejectsSafely(generateGeminiAudioText(args()), /output|steps/);
	}
	for (const malformed of [
		null,
		[],
		true,
		42,
		privateText,
		{ status: 'completed', outputs: [{ type: 'text', text: privateText }] }
	]) {
		response = malformed;
		await rejectsSafely(generateGeminiAudioText(args()), /malformed|steps/);
	}
});

test('requires a single nonempty transcript-only JSON object and rejects common refusal text', async (t) => {
	let text;
	setup(t, async () => Response.json(completed(text)));
	for (text of [
		'',
		' ',
		privateText,
		'{',
		'null',
		'[]',
		'1',
		JSON.stringify(privateText),
		JSON.stringify({ transcript: '' }),
		JSON.stringify({ transcript: ' ' }),
		JSON.stringify({ transcript: 3 }),
		JSON.stringify({ transcript, report: privateText }),
		JSON.stringify({ text: transcript }),
		`\`\`\`json\n${transcriptJson}\n\`\`\``
	]) {
		await rejectsSafely(generateGeminiAudioText(args()), /empty|invalid/);
	}
	for (const refusal of [
		"I'm sorry, I cannot help.",
		'I cannot transcribe this audio.',
		'I am unable to assist with this request.'
	]) {
		text = JSON.stringify({ transcript: refusal });
		await rejectsSafely(generateGeminiAudioText(args()), /refused/);
		text = refusal;
		await rejectsSafely(generateGeminiAudioText(args({ task: 'report' })), /refused/);
	}
	text = 'I cannot exclude a small effusion.';
	assert.equal(await generateGeminiAudioText(args({ task: 'report' })), text);
});

test('sanitizes HTTP failures, cancels response bodies, and never retries or falls back', async (t) => {
	let status;
	let cancelled;
	const mock = setup(t, async () => ({
		ok: false,
		status,
		body: new ReadableStream({
			cancel() {
				cancelled = true;
			}
		})
	}));
	for (const [code, hint] of [
		[400, /retry later/],
		[401, /API key/],
		[403, /permissions/],
		[404, /exact model/],
		[413, /shorter/],
		[429, /quota/],
		[500, /retry later/]
	]) {
		status = code;
		cancelled = false;
		await rejectsSafely(generateGeminiAudioText(args()), hint);
		assert.equal(cancelled, true);
	}
	assert.equal(mock.mock.callCount(), 7);
});

test('sanitizes network, redirect, malformed JSON, invalid UTF-8 and body-read failures', async (t) => {
	let implementation;
	setup(t, (...values) => implementation(...values));
	for (implementation of [
		async () => {
			throw new Error(`network ${key} https://example.invalid/${privateText}`);
		},
		async () => new Response(`<html>${privateText}</html>`),
		async () => new Response(new Uint8Array([0xff])),
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error(`${key} ${privateText}`));
					}
				})
			),
		async () => ({ ok: true, body: null })
	]) {
		await rejectsSafely(generateGeminiAudioText(args()), /network|malformed|read|unreadable/);
	}
});

test('cancels oversized streamed responses and rejects without returning a prefix', async (t) => {
	let cancelled = false;
	setup(
		t,
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(4_000_001));
					},
					cancel() {
						cancelled = true;
					}
				})
			)
	);
	await rejectsSafely(generateGeminiAudioText(args()), /4,000,000 bytes/);
	assert.equal(cancelled, true);
});

test('times out hanging fetch within 180 seconds and aborts transport', async (t) => {
	let signal;
	const mock = setup(t, async (_, options) => {
		signal = options.signal;
		return new Promise(() => {});
	});
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const pending = generateGeminiAudioText(args());
	const rejection = rejectsSafely(pending, /timed out after 180 seconds/);
	assert.equal(signal.aborted, false);
	t.mock.timers.tick(180_000);
	await rejection;
	assert.equal(signal.aborted, true);
	assert.equal(mock.mock.callCount(), 1);
});

test('the same deadline covers a response body that never completes', async (t) => {
	let signal;
	setup(t, async (_, options) => {
		signal = options.signal;
		return new Response(new ReadableStream());
	});
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const pending = generateGeminiAudioText(args());
	const rejection = rejectsSafely(pending, /timed out/);
	await Promise.resolve();
	t.mock.timers.tick(180_000);
	await rejection;
	assert.equal(signal.aborted, true);
});
