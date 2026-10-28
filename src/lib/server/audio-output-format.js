export const durationOnly =
	/^(?:(?:the|this|it|provided|supplied|attached|uploaded|input|recording|audio|file|clip|has|a|an|is|of|in|length|duration|about|approximately|roughly|estimated|total|long|and|contains|runs|lasts|for|exactly|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b|[\d\s:.,~()=*-])+$/i;
export const noDictation =
	/^(?:NO_USABLE_CLINICAL_DICTATION|No (?:usable|intelligible|audible) (?:clinical )?(?:dictation|speech|audio)(?: (?:was |is )?(?:detected|found|provided|available))?)[.!]?$/i;

export function repairJsonTransport(text) {
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
