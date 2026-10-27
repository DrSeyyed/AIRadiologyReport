const fieldType = (value) =>
	value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const diagnosticFields = [
	'final_report',
	'report',
	'text',
	'content',
	'transcript',
	'duration',
	'error',
	'study',
	'findings',
	'conclusion'
];

function structuredFormat(value) {
	if (Array.isArray(value))
		return `JSON array; items=${value.length}; first item=${fieldType(value[0])}`;
	if (value && typeof value === 'object') {
		const fields = diagnosticFields
			.filter((name) => Object.hasOwn(value, name))
			.map((name) => `${name}=${fieldType(value[name])}`);
		if (!Object.hasOwn(value, 'final_report')) fields.unshift('final_report=missing');
		return `JSON object; fields=${Object.keys(value).length}; ${fields.join('; ')}`;
	}
	return `JSON ${fieldType(value)}`;
}

const invalidOutput = (format, wrappers) =>
	new Error(
		`Direct audio reporting returned an unusable report format. The previous report has been preserved. Try generating again or use the transcription workflow. Format diagnostic: ${format}${wrappers.length ? `; wrappers=${wrappers.join(' > ')}` : ''}.`
	);
const durationOnly =
	/^(?:(?:the|this|it|provided|supplied|attached|uploaded|input|recording|audio|file|clip|has|a|an|is|of|in|length|duration|about|approximately|roughly|estimated|total|long|and|contains|runs|lasts|for|exactly|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b|[\d\s:.,~()=*-])+$/i;
const noDictation =
	/^(?:NO_USABLE_CLINICAL_DICTATION|No (?:usable|intelligible|audible) (?:clinical )?(?:dictation|speech|audio)(?: (?:was |is )?(?:detected|found|provided|available))?)[.!]?$/i;

function repairJsonTransport(text) {
	// Repair transport syntax only; never add missing quotes, braces or clinical text.
	let result = '';
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (inString) {
			if (escaped) {
				result += character;
				escaped = false;
				continue;
			}
			if (character === '\\') {
				result += character;
				escaped = true;
				continue;
			}
			if (character === '"') inString = false;
			if (character === '\n') result += '\\n';
			else if (character === '\r') result += '\\r';
			else if (character === '\t') result += '\\t';
			else result += character;
		} else {
			if (character === '"') inString = true;
			if (character === ',') {
				let next = index + 1;
				while (next < text.length && ' \t\r\n'.includes(text[next])) next++;
				if (text[next] === '}' || text[next] === ']') continue;
			}
			result += character;
		}
	}
	return result;
}

function jsonSyntaxDiagnostic(error) {
	const message = typeof error?.message === 'string' ? error.message : '';
	if (/unterminated string/i.test(message)) return 'incomplete JSON string';
	if (/unexpected end/i.test(message)) return 'incomplete JSON container';
	if (/bad control character/i.test(message))
		return 'invalid control character inside a JSON string';
	if (/bad (?:escaped character|unicode escape)/i.test(message)) return 'invalid JSON escape';
	if (/expected.*property name/i.test(message)) return 'invalid JSON property syntax';
	if (/after property value/i.test(message))
		return 'invalid JSON separator or unescaped quotation mark';
	return 'invalid JSON syntax';
}

export function normalizeDirectReportOutput(value) {
	if (typeof value !== 'string' || !value.trim())
		throw new Error('Direct audio reporting returned no report text.');
	let text = value.trim();
	const wrappers = [];
	for (let depth = 0; depth < 4; depth++) {
		const fenced = text.match(/^```(?:json|markdown|md|text)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
		if (fenced) {
			wrappers.push('code fence');
			text = fenced[1].trim();
			continue;
		}
		if (!['[', '{', '"'].includes(text[0])) break;
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			try {
				const repaired = repairJsonTransport(text);
				if (repaired === text) throw error;
				parsed = JSON.parse(repaired);
			} catch (parseError) {
				const prefix =
					text[0] === '"'
						? 'quotation mark'
						: text[0] === '['
							? 'opening square bracket'
							: 'opening brace';
				throw invalidOutput(
					`unparseable JSON-like text beginning with ${prefix}; syntax=${jsonSyntaxDiagnostic(parseError)}`,
					wrappers
				);
			}
		}
		if (typeof parsed === 'string') {
			wrappers.push('JSON string');
			text = parsed.trim();
		} else if (
			parsed &&
			!Array.isArray(parsed) &&
			Object.keys(parsed).length === 1 &&
			typeof parsed.final_report === 'string'
		) {
			wrappers.push('final_report object');
			text = parsed.final_report.trim();
		} else throw invalidOutput(structuredFormat(parsed), wrappers);
	}
	if (!text) throw invalidOutput('empty report after unwrapping', wrappers);
	if (text.startsWith('```'))
		throw invalidOutput(
			wrappers.length === 4 ? 'wrapper depth limit reached' : 'unsupported or unclosed code fence',
			wrappers
		);
	if (['[', '{', '"'].includes(text[0]))
		throw invalidOutput('wrapper depth limit reached', wrappers);
	if (durationOnly.test(text) || noDictation.test(text))
		throw new Error(
			'Direct audio reporting returned audio metadata or no usable clinical dictation, not a report. The previous report has been preserved. Check the recording and try again or use the transcription workflow.'
		);
	return text;
}
