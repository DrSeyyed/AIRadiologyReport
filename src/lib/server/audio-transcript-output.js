import { durationOnly, noDictation, repairJsonTransport } from './audio-output-format.js';

const transcriptFields = ['transcript', 'transcription', 'text'];
const metadataFields = ['language', 'duration', 'duration_seconds'];
const annotationPrefix = /^\[(?:inaudible|unintelligible|unclear)\](?:\s|[.,;:!?]|$)/i;
const annotationsOnly = /^(?:\s|[.,;:!?]|\[(?:inaudible|unintelligible|unclear)\])+$/i;
const invalidFormat = (reason) => new Error(
	`OpenAI audio-model transcription returned an unusable transcript format (${reason}). The previous report has been preserved.`
);

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
				if (fields.length !== 1 || typeof parsed[fields[0]] !== 'string' ||
					Object.keys(parsed).some((field) => field !== fields[0] && (
						!metadataFields.includes(field) || !['string', 'number'].includes(typeof parsed[field])
					))) throw invalidFormat('expected one explicit transcript field');
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
		throw new Error('OpenAI audio-model transcription returned only audio duration or metadata, not dictation. The previous report has been preserved. Try again or choose a dedicated transcription model.');
	return text;
}
