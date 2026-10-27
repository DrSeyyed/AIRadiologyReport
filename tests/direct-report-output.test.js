import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDirectReportOutput } from '../src/lib/server/direct-report-output.js';

const report =
	'Study: Synthetic examination\nFindings\n**A joint effusion is present.**\n\nConclusion\n**A joint effusion is present.**';

test('direct output keeps report text, real newlines, headings and Markdown unchanged', () => {
	assert.equal(normalizeDirectReportOutput(report), report);
	assert.equal(normalizeDirectReportOutput(`  ${report}\n`), report);
	assert.equal(
		normalizeDirectReportOutput('The duration of symptoms is 20 seconds.'),
		'The duration of symptoms is 20 seconds.'
	);
});

test('final_report JSON, quoted JSON and complete code fences are unwrapped without altering clinical text', () => {
	for (const output of [
		JSON.stringify({ final_report: report }),
		JSON.stringify(report),
		JSON.stringify(JSON.stringify({ final_report: report })),
		'```json\n' + JSON.stringify({ final_report: report }) + '\n```',
		'```markdown\n' + report + '\n```',
		'```\n' + report + '\n```'
	]) {
		assert.equal(normalizeDirectReportOutput(output), report);
	}
});

test('duration-only text and no-dictation responses are rejected instead of becoming reports', () => {
	for (const output of [
		'Audio duration: 00:47',
		'Duration: 15.4 seconds.',
		'The audio is approximately 20 seconds long.',
		'00:47',
		'42 seconds',
		'The recording lasts for 1 minute and 10 seconds.',
		'NO_USABLE_CLINICAL_DICTATION',
		'No intelligible speech was detected.',
		JSON.stringify({ final_report: 'Audio duration: 00:47' })
	]) {
		assert.throws(
			() => normalizeDirectReportOutput(output),
			/audio metadata or no usable clinical dictation/
		);
	}
});

test('malformed JSON, unknown structured output, empty wrappers and non-string content fail safely', () => {
	for (const output of [
		undefined,
		null,
		{},
		[],
		'',
		' ',
		'{"final_report":"truncated',
		'{"duration":12}',
		'{"transcript":"synthetic dictation"}',
		JSON.stringify({ final_report: report, error: 'sensitive-provider-content' }),
		'{"final_report":null}',
		'{"final_report":{}}',
		'{"final_report":""}',
		'[]',
		'```json\n{"duration":12}\n```',
		'```json\n{"final_report":"truncated'
	]) {
		assert.throws(
			() => normalizeDirectReportOutput(output),
			(error) => {
				assert.match(error.message, /no report text|unusable report format/);
				assert.doesNotMatch(
					error.message,
					/sensitive-provider-content|synthetic dictation|truncated/
				);
				return true;
			}
		);
	}
});
