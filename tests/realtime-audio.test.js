import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateRealtimeAudioText } from '../src/lib/server/realtime-audio.js';

function wave(bytes = 9600) {
	const data = Buffer.alloc(44 + bytes);
	data.write('RIFF');
	data.writeUInt32LE(data.length - 8, 4);
	data.write('WAVEfmt ', 8);
	data.writeUInt32LE(16, 16);
	data.writeUInt16LE(1, 20);
	data.writeUInt16LE(1, 22);
	data.writeUInt32LE(24000, 24);
	data.writeUInt32LE(48000, 28);
	data.writeUInt16LE(2, 32);
	data.writeUInt16LE(16, 34);
	data.write('data', 36);
	data.writeUInt32LE(bytes, 40);
	for (let offset = 44; offset + 1 < data.length; offset += 2)
		data.writeInt16LE((offset % 2000) - 1000, offset);
	return data;
}

const audio = (data) => ({ data: data.toString('base64'), format: 'wav', sampleRate: 24000 });
const transcript = (text) => ({
	type: 'function_call',
	status: 'completed',
	name: 'submit_transcript',
	call_id: 'call_1',
	arguments: JSON.stringify({ transcript: text })
});
const report = (text) => ({
	type: 'message',
	status: 'completed',
	role: 'assistant',
	content: [{ type: 'output_text', text }]
});
const done = (output = [transcript('Synthetic dictated words.')], changes = {}) => ({
	type: 'response.done',
	response: { id: 'resp_1', status: 'completed', status_details: null, output, ...changes }
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeSocket extends EventEmitter {
	constructor(onSend) {
		super();
		this.readyState = 0;
		this.sent = [];
		this.terminated = 0;
		this.onSend = onSend;
	}
	open() {
		this.readyState = 1;
		this.emit('open');
	}
	event(event) {
		this.emit('message', Buffer.from(JSON.stringify(event)), false);
	}
	send(payload, callback) {
		const event = JSON.parse(payload);
		this.sent.push(event);
		callback();
		this.onSend?.(event, this);
	}
	terminate() {
		this.terminated++;
		this.readyState = 3;
		this.emit('close', 1006);
	}
	serverClose() {
		this.readyState = 3;
		this.emit('close', 1000, Buffer.from('synthetic-secret'));
	}
}

function fixture(
	t,
	{
		final = done(),
		autoOpen = true,
		autoUpdate = true,
		autoCommit = true,
		autoResponse = true,
		onSend,
		...overrides
	} = {}
) {
	const prior = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = 'synthetic-realtime-secret';
	t.after(() => {
		if (prior === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = prior;
	});
	let request;
	const socket = new FakeSocket((event, ws) => {
		onSend?.(event, ws);
		if (event.type === 'session.update' && autoUpdate)
			queueMicrotask(() => ws.event({ type: 'session.updated', session: event.session }));
		if (event.type === 'input_audio_buffer.commit' && autoCommit)
			queueMicrotask(() => ws.event({ type: 'input_audio_buffer.committed', item_id: 'input_1' }));
		if (event.type === 'response.create' && autoResponse)
			queueMicrotask(() => {
				ws.event({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } });
				if (final) ws.event(final);
			});
	});
	const options = {
		model: 'gpt-realtime-2.1',
		audio: audio(wave()),
		instructions: 'Synthetic transcription requirements.',
		task: 'transcription',
		timeoutMs: 1000,
		webSocketFactory: (url, settings) => {
			request = { url, settings };
			if (autoOpen) queueMicrotask(() => socket.open());
			return socket;
		},
		...overrides
	};
	const pending = generateRealtimeAudioText(options);
	return { socket, pending, options, request: () => request };
}

function cleaned(socket) {
	assert.equal(socket.readyState, 3);
	for (const name of ['open', 'message', 'error', 'close'])
		assert.equal(socket.listenerCount(name), 0, name);
}

for (const model of ['gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini']) {
	test(`${model} uses the GA Realtime endpoint and a required transcript function, never Live or chat`, async (t) => {
		const f = fixture(t, { model });
		assert.equal(await f.pending, 'Synthetic dictated words.');
		assert.equal(f.request().url, `wss://api.openai.com/v1/realtime?model=${model}`);
		assert.deepEqual(f.request().settings.headers, {
			Authorization: 'Bearer synthetic-realtime-secret'
		});
		assert.equal(f.request().settings.handshakeTimeout, 1000);
		const session = f.socket.sent[0].session;
		assert.equal(session.type, 'realtime');
		assert.deepEqual(session.output_modalities, ['text']);
		assert.deepEqual(session.audio.input, {
			format: { type: 'audio/pcm', rate: 24000 },
			turn_detection: null,
			transcription: null,
			noise_reduction: null
		});
		assert.equal(session.truncation, 'disabled');
		assert.equal(session.max_output_tokens, 'inf');
		assert.deepEqual(session.tool_choice, { type: 'function', name: 'submit_transcript' });
		assert.equal(session.tools.length, 1);
		assert.equal(session.tools[0].name, 'submit_transcript');
		assert.equal(session.tools[0].function, undefined);
		assert.equal(session.tools[0].parameters.additionalProperties, false);
		assert.match(session.instructions, /verbatim/);
		assert.equal(f.socket.terminated, 1);
		cleaned(f.socket);
	});
}

test('report task requests only text and returns a completed assistant message', async (t) => {
	const f = fixture(t, {
		task: 'report',
		final: done([report('  Findings:\nSynthetic report.  ')])
	});
	assert.equal(await f.pending, 'Findings:\nSynthetic report.');
	assert.deepEqual(f.socket.sent[0].session.tools, []);
	assert.equal(f.socket.sent[0].session.tool_choice, 'none');
	assert.match(f.socket.sent[0].session.instructions, /completed report/);
	assert.equal(f.socket.sent.filter((event) => event.type === 'response.create').length, 1);
	cleaned(f.socket);
});

test('waits for session.updated, streams only ordered raw PCM chunks, commits, then waits for commit acknowledgement', async (t) => {
	const source = wave(120_002);
	const f = fixture(t, {
		audio: audio(source),
		autoUpdate: false,
		autoCommit: false,
		autoResponse: false
	});
	await tick();
	assert.deepEqual(
		f.socket.sent.map((event) => event.type),
		['session.update']
	);
	f.socket.event({ type: 'session.created', session: { type: 'realtime' } });
	await tick();
	assert.equal(f.socket.sent.length, 1);
	f.socket.event({ type: 'session.updated', session: f.socket.sent[0].session });
	await tick();
	const chunks = f.socket.sent
		.filter((event) => event.type === 'input_audio_buffer.append')
		.map((event) => Buffer.from(event.audio, 'base64'));
	assert.deepEqual(
		chunks.map((chunk) => chunk.length),
		[48_000, 48_000, 24_002]
	);
	assert.deepEqual(Buffer.concat(chunks), source.subarray(44));
	assert.equal(f.socket.sent.at(-1).type, 'input_audio_buffer.commit');
	assert.equal(
		f.socket.sent.some((event) => event.type === 'response.create'),
		false
	);
	f.socket.event({ type: 'input_audio_buffer.committed', item_id: 'input_1' });
	await tick();
	assert.deepEqual(f.socket.sent.at(-1), {
		type: 'response.create',
		response: { output_modalities: ['text'] }
	});
	f.socket.event({ type: 'response.created', response: { id: 'resp_1' } });
	f.socket.event(done());
	assert.equal(await f.pending, 'Synthetic dictated words.');
	cleaned(f.socket);
});

test('ignores streaming fragments and waits for response.done before returning', async (t) => {
	const f = fixture(t, { final: null });
	let resolved = false;
	void f.pending.then(() => {
		resolved = true;
	});
	await tick();
	for (const event of [
		{ type: 'response.function_call_arguments.delta', delta: '{"transcript":"partial' },
		{ type: 'response.function_call_arguments.done', arguments: '{"transcript":"premature"}' },
		{ type: 'response.output_item.done', item: transcript('premature') },
		{ type: 'response.output_text.done', text: 'premature' }
	])
		f.socket.event({ response_id: 'resp_1', ...event });
	await tick();
	assert.equal(resolved, false);
	assert.equal(f.socket.terminated, 0);
	f.socket.event(done([transcript('  Final transcript.  ')]));
	assert.equal(await f.pending, 'Final transcript.');
	cleaned(f.socket);
});

for (const status of ['cancelled', 'incomplete', 'failed', 'in_progress', undefined]) {
	test(`rejects ${status} responses even with nonempty partial output`, async (t) => {
		const f = fixture(t, {
			final: done([transcript('Partial.')], {
				status,
				status_details: { reason: 'max_output_tokens' }
			})
		});
		await assert.rejects(f.pending, /did not complete/);
		cleaned(f.socket);
	});
}

const invalidOutputs = [
	['missing output', undefined],
	['empty output', []],
	['multiple calls', [transcript('One.'), transcript('Two.')]],
	['null item', [null]],
	['incomplete item', [{ ...transcript('Partial.'), status: 'incomplete' }]],
	['missing item status', [{ ...transcript('Words.'), status: undefined }]],
	['missing required function', [report('Wrong surface.')]],
	['wrong function', [{ ...transcript('Words.'), name: 'other_tool' }]],
	['invalid JSON', [{ ...transcript('Words.'), arguments: '{"transcript":"partial' }]],
	['nonstring arguments', [{ ...transcript('Words.'), arguments: { transcript: 'Words.' } }]],
	['empty transcript', [transcript(' \n ')]],
	['numeric transcript', [transcript(123)]],
	[
		'extra arguments',
		[{ ...transcript('Words.'), arguments: '{"transcript":"Words.","report":"Ambiguous"}' }]
	],
	['array arguments', [{ ...transcript('Words.'), arguments: '["Words."]' }]],
	['null arguments', [{ ...transcript('Words.'), arguments: 'null' }]],
	['duplicate keys', [{ ...transcript('Words.'), arguments: '{"transcript":"One.","transcript":"Two."}' }]],
	['refusal', [{ ...transcript('Words.'), refusal: 'Refused.' }]]
];
for (const [label, output] of invalidOutputs) {
	test(`rejects transcription ${label} without retry or fallback`, async (t) => {
		const final = done();
		final.response.output = output;
		const f = fixture(t, { final });
		await assert.rejects(f.pending, /OpenAI Realtime/);
		assert.equal(f.socket.sent.filter((event) => event.type === 'response.create').length, 1);
		cleaned(f.socket);
	});
}

for (const [label, item] of [
	['empty text', report(' ')],
	['nonstring text', report({ text: 'No.' })],
	['tool output', transcript('No.')],
	['wrong role', { ...report('No.'), role: 'user' }],
	['refusal content', { ...report('No.'), content: [{ type: 'refusal', refusal: 'No.' }] }],
	[
		'text with refusal',
		{ ...report('No.'), content: [{ type: 'output_text', text: 'No.', refusal: 'Refused.' }] }
	],
	['audio', { ...report('No.'), content: [{ type: 'output_audio', transcript: 'Not text.' }] }],
	[
		'multiple content parts',
		{
			...report('No.'),
			content: [
				{ type: 'output_text', text: 'One.' },
				{ type: 'output_text', text: 'Two.' }
			]
		}
	]
]) {
	test(`rejects report ${label}`, async (t) => {
		const f = fixture(t, { task: 'report', final: done([item]) });
		await assert.rejects(f.pending, /OpenAI Realtime/);
		cleaned(f.socket);
	});
}

test('rejects completed status with refusal/truncation status details', async (t) => {
	const f = fixture(t, {
		final: done([transcript('Looks complete.')], { status_details: { reason: 'content_filter' } })
	});
	await assert.rejects(f.pending, /did not complete/);
	cleaned(f.socket);
});

for (const event of [
	{ type: 'response.refusal.delta', delta: 'Refused.' },
	{ type: 'response.output_audio.delta', delta: 'AAAA' },
	{ type: 'conversation.item.truncated', item_id: 'input_1' },
	{ type: 'input_audio_buffer.speech_started' },
	{ type: 'input_audio_buffer.speech_stopped' },
	{ type: 'response.output_text.delta', response_id: 'wrong_response', delta: 'Wrong.' },
	{ type: 'response.created', response: { id: 'second_response' } },
	{ ...done(), response: { ...done().response, id: 'wrong_response' } }
]) {
	test(`rejects interruption or unsolicited event ${event.type}`, async (t) => {
		const f = fixture(t, { final: null });
		const rejected = assert.rejects(f.pending, /OpenAI Realtime/);
		await tick();
		f.socket.event(event);
		await rejected;
		cleaned(f.socket);
	});
}

for (const stage of ['configuring', 'committing', 'responding']) {
	test(`provider errors during ${stage} reject and never expose provider text or credentials`, async (t) => {
		const f = fixture(t, {
			autoUpdate: stage !== 'configuring',
			autoCommit: stage !== 'committing',
			final: null
		});
		const rejected = assert.rejects(f.pending, (error) => {
			assert.match(error.message, /provider rejected/);
			assert.doesNotMatch(error.message, /synthetic-realtime-secret|private dictation/);
			return true;
		});
		await tick();
		f.socket.event({
			type: 'error',
			error: { message: 'synthetic-realtime-secret private dictation', code: 'secret' }
		});
		await rejected;
		cleaned(f.socket);
	});
}

test('rejects raw socket errors without leaking connection details', async (t) => {
	const f = fixture(t, { autoOpen: false });
	const rejected = assert.rejects(f.pending, /^Error: OpenAI Realtime audio connection failed\.$/);
	f.socket.emit('error', new Error('synthetic-realtime-secret'));
	await rejected;
	cleaned(f.socket);
});

test('rejects constructor errors without leaking credentials', async (t) => {
	const f = fixture(t, {
		webSocketFactory: () => {
			throw new Error('synthetic-realtime-secret');
		}
	});
	await assert.rejects(f.pending, /^Error: OpenAI Realtime audio connection failed\.$/);
});

for (const stage of ['connecting', 'responding']) {
	test(`rejects socket closure during ${stage}, including a normal close code`, async (t) => {
		const f = fixture(t, { autoOpen: stage !== 'connecting', final: null });
		const rejected = assert.rejects(f.pending, /closed before a completed response/);
		await tick();
		f.socket.serverClose();
		await rejected;
		cleaned(f.socket);
	});
}

for (const stage of ['connecting', 'configuring', 'committing', 'responding']) {
	test(`timeout during ${stage} terminates the socket and removes listeners`, async (t) => {
		const f = fixture(t, {
			timeoutMs: 20,
			autoOpen: stage !== 'connecting',
			autoUpdate: stage !== 'configuring',
			autoCommit: stage !== 'committing',
			final: null
		});
		await assert.rejects(f.pending, /timed out/);
		assert.equal(f.socket.terminated, 1);
		cleaned(f.socket);
	});
}

test('termination during handshake safely absorbs ws asynchronous error before close', async (t) => {
	const f = fixture(t, { timeoutMs: 10, autoOpen: false });
	f.socket.terminate = function () {
		this.terminated++;
		queueMicrotask(() => {
			this.emit('error', new Error('synthetic-realtime-secret'));
			this.serverClose();
		});
	};
	await assert.rejects(f.pending, /timed out/);
	await tick();
	cleaned(f.socket);
});

for (const mode of ['throw', 'callback']) {
	test(`handles ${mode} send failures without exposing raw errors`, async (t) => {
		const f = fixture(t);
		f.socket.send = (_payload, callback) => {
			if (mode === 'throw') throw new Error('synthetic-realtime-secret');
			callback(new Error('synthetic-realtime-secret'));
		};
		await assert.rejects(f.pending, /^Error: OpenAI Realtime audio send failed\.$/);
		cleaned(f.socket);
	});
}

for (const payload of ['not-json', 'null', '{}', '[]']) {
	test(`rejects malformed socket event ${payload}`, async (t) => {
		const f = fixture(t, { autoOpen: false });
		const rejected = assert.rejects(f.pending, /invalid event/);
		f.socket.emit('message', Buffer.from(payload), false);
		await rejected;
		cleaned(f.socket);
	});
}

test('rejects binary messages', async (t) => {
	const f = fixture(t, { autoOpen: false });
	const rejected = assert.rejects(f.pending, /invalid event/);
	f.socket.emit('message', Buffer.from('{}'), true);
	await rejected;
	cleaned(f.socket);
});

test('rejects unsolicited output before session acknowledgement', async (t) => {
	const f = fixture(t, { autoUpdate: false });
	const rejected = assert.rejects(f.pending, /unsolicited output/);
	await tick();
	f.socket.event({ type: 'response.output_text.delta', delta: 'Do not accept.' });
	await rejected;
	cleaned(f.socket);
});

for (const mutate of [
	(session) => {
		session.audio.input.turn_detection = { type: 'server_vad' };
	},
	(session) => {
		session.audio.input.format.rate = 16000;
	},
	(session) => {
		session.output_modalities = ['audio'];
	},
	(session) => {
		delete session.audio.input.turn_detection;
	},
	(session) => { session.truncation = 'auto'; },
	(session) => { session.tool_choice = 'auto'; }
]) {
	test('requires effective session configuration acknowledgement before uploading audio', async (t) => {
		const f = fixture(t, { autoUpdate: false });
		const rejected = assert.rejects(f.pending, /did not confirm/);
		await tick();
		const session = structuredClone(f.socket.sent[0].session);
		mutate(session);
		f.socket.event({ type: 'session.updated', session });
		await rejected;
		assert.equal(f.socket.sent.length, 1);
		cleaned(f.socket);
	});
}

const headerMutations = [
	['RIFF', (data) => data.write('RIFX')],
	['RIFF length', (data) => data.writeUInt32LE(0, 4)],
	['WAVE', (data) => data.write('XXXX', 8)],
	['fmt chunk', (data) => data.write('junk', 12)],
	['fmt size', (data) => data.writeUInt32LE(18, 16)],
	['PCM encoding', (data) => data.writeUInt16LE(3, 20)],
	['channels', (data) => data.writeUInt16LE(2, 22)],
	['sample rate', (data) => data.writeUInt32LE(16000, 24)],
	['byte rate', (data) => data.writeUInt32LE(96000, 28)],
	['block alignment', (data) => data.writeUInt16LE(4, 32)],
	['bit depth', (data) => data.writeUInt16LE(8, 34)],
	['data chunk', (data) => data.write('junk', 36)],
	['data length', (data) => data.writeUInt32LE(1, 40)]
];
for (const [label, mutate] of headerMutations) {
	test(`rejects invalid WAV ${label} before connecting`, async (t) => {
		const data = wave();
		mutate(data);
		const f = fixture(t, { audio: audio(data) });
		await assert.rejects(f.pending, /WAV/);
		assert.equal(f.request(), undefined);
	});
}

for (const [label, value] of [
	['missing audio', undefined],
	['wrong declared format', { ...audio(wave()), format: 'pcm' }],
	['wrong declared rate', { ...audio(wave()), sampleRate: 16000 }],
	['invalid base64', { ...audio(wave()), data: '%%%%' }],
	['base64 whitespace', { ...audio(wave()), data: ` ${wave().toString('base64')}` }],
	['empty audio', audio(Buffer.alloc(0))],
	['short header', audio(Buffer.alloc(20))],
	['empty PCM', audio(wave(0))],
	['odd PCM byte length', audio(wave(1))]
]) {
	test(`rejects ${label} locally`, async (t) => {
		const f = fixture(t, { audio: value });
		await assert.rejects(f.pending, /WAV/);
		assert.equal(f.request(), undefined);
	});
}

for (const change of [
	{ model: 'gpt-live' },
	{ model: 'gpt-realtime-2.1-unknown' },
	{ task: 'unknown' },
	{ instructions: '' },
	{ instructions: null },
	{ timeoutMs: 0 },
	{ timeoutMs: Infinity },
	{ timeoutMs: 2.5 }
]) {
	test(`rejects invalid adapter options ${JSON.stringify(change)}`, async (t) => {
		const f = fixture(t, change);
		await assert.rejects(f.pending);
		assert.equal(f.request(), undefined);
	});
}

test('requires only the server OPENAI_API_KEY before opening a connection', async (t) => {
	const f = fixture(t, { autoOpen: false });
	const rejected = assert.rejects(f.pending, /closed before/);
	f.socket.serverClose();
	await rejected;
	delete process.env.OPENAI_API_KEY;
	let connected = false;
	await assert.rejects(
		generateRealtimeAudioText({
			...f.options,
			apiKey: 'client-supplied-is-not-accepted',
			webSocketFactory: () => {
				connected = true;
			}
		}),
		/OPENAI_API_KEY is required/
	);
	assert.equal(connected, false);
});
