const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MODELS = new Set(['gemini-3.8-flash', 'gemini-2.5-pro', 'gemini-2.5-flash']);
const MAX_REQUEST_BYTES = 20_000_000;
const MAX_RESPONSE_BYTES = 4_000_000;
const REQUEST_TIMEOUT_MS = 180_000;

const transcriptSchema = {
	type: 'object',
	properties: { transcript: { type: 'string' } },
	required: ['transcript'],
	additionalProperties: false
};

function failure(message) {
	return new Error(`Gemini audio: ${message}`);
}

function validateAudio(audio) {
	if (audio?.format !== 'wav' || audio.sampleRate !== 16000 || typeof audio.data !== 'string') {
		throw failure('provide base64 mono 16 kHz WAV audio.');
	}
	if (audio.data.length > MAX_REQUEST_BYTES) {
		throw failure(
			'inline request exceeds 20,000,000 bytes; use a shorter recording. File uploads are not supported.'
		);
	}
	if (!audio.data || audio.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio.data)) {
		throw failure('audio must contain valid base64 WAV data.');
	}
	const wav = Buffer.from(audio.data, 'base64');
	if (
		wav.toString('base64') !== audio.data ||
		wav.length < 44 ||
		wav.toString('ascii', 0, 4) !== 'RIFF' ||
		wav.toString('ascii', 8, 12) !== 'WAVE' ||
		(wav.readUInt32LE(4) !== wav.length - 8 && wav.readUInt32LE(4) !== 0xffffffff)
	) {
		throw failure('audio must contain a complete mono 16 kHz WAV file.');
	}
	let formatFound = false;
	let dataFound = false;
	let offset = 12;
	while (offset + 8 <= wav.length) {
		const name = wav.toString('ascii', offset, offset + 4);
		const declaredSize = wav.readUInt32LE(offset + 4);
		const start = offset + 8;
		// Piped WAV encoders use unknown lengths until the stream ends.
		const size = name === 'data' && declaredSize === 0xffffffff ? wav.length - start : declaredSize;
		if (start + size > wav.length) throw failure('WAV audio is incomplete.');
		if (name === 'fmt ') {
			if (
				formatFound ||
				size < 16 ||
				wav.readUInt16LE(start) !== 1 ||
				wav.readUInt16LE(start + 2) !== 1 ||
				wav.readUInt32LE(start + 4) !== 16000 ||
				wav.readUInt32LE(start + 8) !== 32000 ||
				wav.readUInt16LE(start + 12) !== 2 ||
				wav.readUInt16LE(start + 14) !== 16
			) {
				throw failure('audio must be PCM16 mono 16 kHz WAV.');
			}
			formatFound = true;
		}
		if (name === 'data') {
			if (dataFound || !size || size % 2)
				throw failure('WAV audio must contain complete PCM16 samples.');
			dataFound = true;
		}
		offset = start + size + (size % 2);
	}
	if (!formatFound || !dataFound || offset !== wav.length)
		throw failure('WAV audio is incomplete.');
}

function blocked(value) {
	return Boolean(
		value &&
		(value.refusal ||
			value.block_reason ||
			value.blockReason ||
			(value.finish_reason && value.finish_reason !== 'STOP') ||
			(value.finishReason && value.finishReason !== 'STOP') ||
			unsafeRatings(value.safety_ratings) ||
			unsafeRatings(value.safetyRatings))
	);
}

function unsafeRatings(ratings) {
	return (
		ratings !== undefined &&
		(!Array.isArray(ratings) ||
			ratings.some((rating) => !rating || typeof rating !== 'object' || rating.blocked === true))
	);
}

function extractText(result, model, task) {
	if (!result || typeof result !== 'object' || Array.isArray(result))
		throw failure('provider returned a malformed response; retry the recording.');
	if (result.status !== 'completed')
		throw failure(
			'generation did not complete (possibly a safety block or output limit); retry with a shorter recording.'
		);
	if (result.model !== undefined && result.model !== model)
		throw failure('provider returned an unexpected model; check model availability.');
	if (
		result.error ||
		(result.errors && (!Array.isArray(result.errors) || result.errors.length)) ||
		result.continuation_token ||
		blocked(result) ||
		blocked(result.prompt_feedback) ||
		blocked(result.promptFeedback)
	) {
		throw failure(
			'provider reported a refusal, safety block, or incomplete generation; no text was accepted.'
		);
	}
	if (!Array.isArray(result.steps) || !result.steps.length)
		throw failure('provider returned no valid output steps; retry the recording.');
	const outputs = [];
	for (const step of result.steps) {
		if (
			!step ||
			typeof step !== 'object' ||
			blocked(step) ||
			(step.status !== undefined && step.status !== 'done')
		)
			throw failure('provider returned a blocked or incomplete output step.');
		if (step.type === 'thought' || step.type === 'user_input') continue;
		if (step.type !== 'model_output')
			throw failure('provider returned an unsupported output step; no text was accepted.');
		outputs.push(step);
	}
	if (outputs.length !== 1 || !Array.isArray(outputs[0].content) || !outputs[0].content.length)
		throw failure('provider returned missing or multiple model outputs; no text was accepted.');
	let text = '';
	for (const part of outputs[0].content) {
		if (!part || part.type !== 'text' || typeof part.text !== 'string' || blocked(part))
			throw failure('provider returned non-text or refused output; no text was accepted.');
		if (part.thought === true) continue;
		text += part.text;
	}
	if (!text.trim()) throw failure('provider returned empty text; retry the recording.');
	if (task === 'transcription') {
		let transcript;
		try {
			transcript = JSON.parse(text);
		} catch {
			throw failure('provider returned invalid transcript JSON; retry the recording.');
		}
		if (
			!transcript ||
			Array.isArray(transcript) ||
			typeof transcript !== 'object' ||
			Object.keys(transcript).length !== 1 ||
			typeof transcript.transcript !== 'string' ||
			!transcript.transcript.trim()
		)
			throw failure('provider returned an invalid transcript-only object; retry the recording.');
		if (isRefusal(transcript.transcript))
			throw failure('provider refused transcription; no text was accepted.');
	} else if (isRefusal(text)) {
		throw failure('provider refused report generation; no text was accepted.');
	}
	return text;
}

function isRefusal(text) {
	return /^(?:i(?: am|'m) sorry\b|sorry[,!.\s]|i (?:cannot|can't|won't|am unable to) (?:assist|help|comply|provide|process|transcribe|generate)\b)/i.test(
		text.trim()
	);
}

async function readResponse(response) {
	if (!response.body || typeof response.body.getReader !== 'function')
		throw failure('provider returned an unreadable response; retry the recording.');
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw failure('provider response exceeded 4,000,000 bytes; no text was accepted.');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
	} catch {
		throw failure('provider returned malformed JSON; retry the recording.');
	}
}

/**
 * Stateless prerecorded audio -> text. Parent applies clinical output normalizers.
 * Official docs: https://ai.google.dev/gemini-api/docs/audio and
 * https://ai.google.dev/gemini-api/docs/interactions-overview (all three models).
 * Inline-only: the entire UTF-8 JSON request, including base64 and instructions,
 * must be <= 20,000,000 bytes. No uploads, retries, or model substitution.
 */
export async function generateGeminiAudioText({ model, audio, instructions, task } = {}) {
	if (!MODELS.has(model))
		throw failure(
			'unsupported model; select gemini-3.8-flash, gemini-2.5-pro, or gemini-2.5-flash.'
		);
	if (task !== 'transcription' && task !== 'report')
		throw failure('task must be transcription or report.');
	if (typeof instructions !== 'string' || !instructions.trim())
		throw failure('nonempty task instructions are required.');
	validateAudio(audio);
	const apiKey = process.env.GEMINI_API_KEY?.trim();
	if (!apiKey) throw failure('GEMINI_API_KEY is not configured on the server.');
	const body = JSON.stringify({
		model,
		store: false,
		stream: false,
		background: false,
		system_instruction: instructions,
		input: [
			{
				type: 'text',
				text:
					task === 'transcription'
						? 'Transcribe this recording verbatim in its original language. Return only a JSON object with one string field, transcript; do not write a report, translate, summarize, or add commentary.'
						: 'Generate the report from this recording according to the supplied instructions. Return only the final report text.'
			},
			{ type: 'audio', data: audio.data, mime_type: 'audio/wav' }
		],
		response_format:
			task === 'transcription'
				? { type: 'text', mime_type: 'application/json', schema: transcriptSchema }
				: { type: 'text', mime_type: 'text/plain' },
		generation_config: { max_output_tokens: 32768 }
	});
	if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES)
		throw failure(
			'inline request exceeds 20,000,000 bytes including base64 and instructions; use a shorter recording. File uploads are not supported.'
		);
	const controller = new AbortController();
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(failure('request timed out after 180 seconds; retry with a shorter recording.'));
		}, REQUEST_TIMEOUT_MS);
	});
	try {
		return await Promise.race([
			timeout,
			(async () => {
				let response;
				try {
					response = await fetch(ENDPOINT, {
						method: 'POST',
						redirect: 'error',
						headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
						body,
						signal: controller.signal
					});
				} catch {
					throw failure('network request failed; check connectivity and retry.');
				}
				if (!response.ok) {
					await response.body?.cancel();
					const hint =
						response.status === 401 || response.status === 403
							? 'check the server API key and project permissions.'
							: response.status === 404
								? 'check access to the selected exact model.'
								: response.status === 429
									? 'quota or rate limit reached; retry later.'
									: response.status === 413
										? 'request is too large; use a shorter recording.'
										: 'provider request failed; retry later.';
					throw failure(
						`HTTP ${Number.isInteger(response.status) ? response.status : 'error'}; ${hint}`
					);
				}
				let result;
				try {
					result = await readResponse(response);
				} catch (error) {
					if (error.message?.startsWith('Gemini audio:')) throw error;
					throw failure('response could not be read completely; retry the recording.');
				}
				return extractText(result, model, task);
			})()
		]);
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}
