import { durationOnly, noDictation, repairJsonTransport } from './audio-output-format.js';

const transcriptFields = ['transcript', 'transcription', 'text'];
const reportFields = ['final_report', 'report', 'findings', 'conclusion'];
export const AUDIO_TRANSCRIPT_TOOL_NAME = 'submit_transcript';
const annotationPrefix = /^\[(?:inaudible|unintelligible|unclear)\](?:\s|[.,;:!?]|$)/i;
const annotationsOnly = /^(?:\s|[.,;:!?]|\[(?:inaudible|unintelligible|unclear)\])+$/i;
export class AudioTranscriptFormatError extends Error {
	constructor(reason) {
		super(`OpenAI audio-model transcription returned an unusable transcript format (${reason}). The previous report has been preserved.`);
		this.name = 'AudioTranscriptFormatError';
	}
}

const invalidFormat = (reason) => new AudioTranscriptFormatError(reason);

export function normalizeAudioTranscriptOutput(value) {
	if (typeof value !== 'string' || !value.trim())
		throw new Error('OpenAI audio-model transcription returned no usable text.');
	let text = value.trim();
	for (let depth = 0; ; depth++) {
		const fenced = text.match(/^```(?:json|text|markdown|md|transcript|transcription)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
		let next;
		if (fenced) next = fenced[1];
		else if (['{', '[', '"'].includes(text[0]) && !annotationPrefix.test(text)) {
			let parsed;
			try {
				parsed = JSON.parse(repairJsonTransport(text));
			} catch {
				if (text[0] === '"') break;
				throw invalidFormat('malformed JSON wrapper');
			}
			if (typeof parsed === 'string') next = parsed;
			else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				const fields = transcriptFields.filter((field) => Object.hasOwn(parsed, field));
				if (!fields.length) throw invalidFormat('no explicit transcript field');
				if (reportFields.some((field) => Object.hasOwn(parsed, field)))
					throw invalidFormat('report fields are not verbatim dictation');
				if (fields.some((field) => typeof parsed[field] !== 'string'))
					throw invalidFormat('transcript field is not text');
				if (fields.some((field) => parsed[field].trim() !== parsed[fields[0]].trim()))
					throw invalidFormat('conflicting transcript fields');
				next = parsed[fields[0]];
			} else throw invalidFormat('expected transcript text, not an array or scalar');
		} else {
			if (text.startsWith('```')) throw invalidFormat('unsupported or unclosed code fence');
			break;
		}
		if (depth === 4) throw invalidFormat('too many nested wrappers');
		text = next.trim();
	}
	if (!text || noDictation.test(text) || annotationsOnly.test(text))
		throw new Error('OpenAI audio-model transcription returned no usable text.');
	if (durationOnly.test(text))
		throw invalidFormat('only audio duration or metadata, not dictation');
	return text;
}

export function audioTranscriptionChoice(choice) {
	if (choice?.message?.refusal)
		throw new Error('OpenAI declined audio-model transcription. Review the recording and try again.');
	if (!['stop', 'tool_calls'].includes(choice?.finish_reason))
		throw new Error('OpenAI audio-model transcription was not completed.');
	const calls = choice.message?.tool_calls;
	if (choice.finish_reason === 'tool_calls') {
		if (!Array.isArray(calls) || calls.length !== 1 || calls[0]?.type !== 'function' ||
			calls[0].function?.name !== AUDIO_TRANSCRIPT_TOOL_NAME)
			throw invalidFormat('expected one transcript submission');
		const args = calls[0].function.arguments;
		let parsed;
		try { parsed = JSON.parse(repairJsonTransport(args)); } catch {
			throw invalidFormat('invalid transcript submission arguments');
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.transcript !== 'string')
			throw invalidFormat('transcript submission is missing transcript text');
		return normalizeAudioTranscriptOutput(args);
	}
	if (calls?.length) throw invalidFormat('transcript submission was not completed');
	return normalizeAudioTranscriptOutput(choice.message?.content);
}
