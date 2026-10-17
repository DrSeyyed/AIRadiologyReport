import { marked } from 'marked';

export function renderReportMarkdown(text) {
	const lines = (text || '').split(/\r?\n/);
	const spaced = [];
	let fence = '';
	for (const line of lines) {
		const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (marker) {
			if (!fence) fence = marker[1];
			else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
			spaced.push(line);
			continue;
		}
		const label = line.trim().replace(/^#{1,6}\s+/, '').replace(/\*\*|__/g, '');
		if (!fence && !/^(?: {4}|\t)/.test(line) && /^Conclusion(?:\s*:.*)?$/i.test(label) && spaced.length && spaced.at(-1).trim())
			spaced.push('');
		spaced.push(line);
	}
	return marked.parse(spaced.join('\n'), { breaks: true });
}
