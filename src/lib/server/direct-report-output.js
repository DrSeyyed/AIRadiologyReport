const invalidOutput = () =>
	new Error(
		'Direct audio reporting returned an unusable report format. The previous report has been preserved. Try generating again or use the transcription workflow.'
	);
const durationOnly =
	/^(?:(?:the|this|it|provided|supplied|attached|uploaded|input|recording|audio|file|clip|has|a|an|is|of|in|length|duration|about|approximately|roughly|estimated|total|long|and|contains|runs|lasts|for|exactly|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b|[\d\s:.,~()=*-])+$/i;
const noDictation =
	/^(?:NO_USABLE_CLINICAL_DICTATION|No (?:usable|intelligible|audible) (?:clinical )?(?:dictation|speech|audio)(?: (?:was |is )?(?:detected|found|provided|available))?)[.!]?$/i;

export function normalizeDirectReportOutput(value) {
	if (typeof value !== 'string' || !value.trim())
		throw new Error('Direct audio reporting returned no report text.');
	let text = value.trim();
	for (let depth = 0; depth < 4; depth++) {
		const fenced = text.match(/^```(?:json|markdown|md|text)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
		if (fenced) {
			text = fenced[1].trim();
			continue;
		}
		if (!['[', '{', '"'].includes(text[0])) break;
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw invalidOutput();
		}
		if (typeof parsed === 'string') text = parsed.trim();
		else if (
			parsed &&
			!Array.isArray(parsed) &&
			Object.keys(parsed).length === 1 &&
			typeof parsed.final_report === 'string'
		)
			text = parsed.final_report.trim();
		else throw invalidOutput();
	}
	if (!text || ['[', '{', '"'].includes(text[0]) || text.startsWith('```')) throw invalidOutput();
	if (durationOnly.test(text) || noDictation.test(text))
		throw new Error(
			'Direct audio reporting returned audio metadata or no usable clinical dictation, not a report. The previous report has been preserved. Check the recording and try again or use the transcription workflow.'
		);
	return text;
}
