import { marked } from 'marked';

export function renderReportMarkdown(text) {
	return marked.parse(text || '', { breaks: true });
}
