import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReportMarkdown } from '../src/lib/report-markdown.js';

test('report previews and printouts preserve single line breaks and selective bold formatting', () => {
	for (const newline of ['\n', '\r\n']) {
		const text = ['Lungs are clear.', '**Small pleural effusion.**', 'Conclusion:', '**Follow-up advised.**'].join(newline);
		const html = renderReportMarkdown(text);
		assert.equal((html.match(/<br\s*\/?\s*>/g) || []).length, 3);
		assert.match(html, /<strong>Small pleural effusion\.<\/strong>/);
		assert.match(html, /<strong>Follow-up advised\.<\/strong>/);
		assert.doesNotMatch(html, /<strong>Lungs are clear/);
	}
});

test('report rendering retains paragraphs, headings and empty-report behaviour', () => {
	const html = renderReportMarkdown('## Findings\nNormal brain.\n\n## Conclusion\nNo significant abnormality.');
	assert.match(html, /<h2>Findings<\/h2>/);
	assert.match(html, /<p>Normal brain\.<\/p>/);
	assert.match(html, /<h2>Conclusion<\/h2>/);
	assert.equal(renderReportMarkdown(''), '');
	assert.equal(renderReportMarkdown(null), '');
});
