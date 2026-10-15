import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRecordingReport } from '../src/lib/server/recording-generation.js';

test('report generation sends the exact requested UK English prompt with recording-specific values', async (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'recording-prompt-'));
	const audio = join(directory, 'synthetic.webm');
	writeFileSync(audio, 'Synthetic test audio');
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const previous = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = 'synthetic-test-key';
	t.after(() => {
		if (previous === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previous;
	});
	const transcription = 'Synthetic dictated finding.';
	const template = 'Findings:\nSynthetic template content.';
	const prompts = [];
	let transcriptions = 0;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		if (url === 'https://api.openai.com/v1/audio/transcriptions') {
			transcriptions++;
			assert.equal(options.body.get('model'), 'gpt-transcribe');
			assert.equal(options.body.get('file').name, 'synthetic.webm');
			return { ok: true, json: async () => ({ text: transcription }) };
		}
		assert.equal(url, 'https://api.openai.com/v1/responses');
		const body = JSON.parse(options.body);
		assert.equal(body.model, 'gpt-6.1-sol');
		prompts.push(body.input);
		return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Synthetic final report.' }] }] }) };
	});
	for (const [recording, label, gender] of [
		[{ modality_name: 'Magnetic resonance imaging', exam_type_name: 'Knee without contrast', exam_details: 'Right', patient_gender: 'female' }, 'Knee without contrast (Right), Magnetic resonance imaging', 'female'],
		[{ modality_code: 'CT', exam_type_code: 'CHEST_WC', patient_gender: 'unknown' }, 'CHEST_WC, CT', 'unknown']
	]) {
		assert.equal(await generateRecordingReport({ ...recording, audio_report_path: audio }, template), 'Synthetic final report.');
		assert.equal(prompts.at(-1), `You are a radiology report generator.
Translate the doctor's dictation into English and produce a professional radiology report.
Use British radiology terminology and UK English spelling and phrasing.
Follow the template structure, section order, and formatting as closely as possible.
Preserve all clinically relevant information from the dictation. Do not omit any finding.
Add relevant dictated findings that do not fit an existing section.
Bold only pathologic or abnormal findings and recommendations with double asterisks. Do not bold normal or negative findings, headings, or routine text.
Do not invent findings, diagnoses, measurements, comparisons, or recommendations.
Correct obvious transcription, grammar, and terminology errors while preserving clinical meaning.
Use concise professional language. Use only single line breaks between sections.
Include a Conclusion that summarises important abnormal findings and relevant recommendations without repeating normals.
If no significant abnormality, give a concise normal conclusion.
Bold all recommendations in the body and Conclusion.
Return only the final report text.
Study label: ${label}
Template:
"${template}"
Doctor's dictation:
"${transcription}"
Patient gender: ${gender}`);
	}
	assert.equal(transcriptions, 2);
	assert.equal(prompts.length, 2);
});
