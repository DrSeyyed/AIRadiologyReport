import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRecordingReport } from '../src/lib/server/recording-generation.js';

test('report generation defaults to UK English and complete sentences with recording-specific values', async (t) => {
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
			const hint = options.body.get('prompt');
			assert.match(hint, /فارسی/);
			for (const term of ['high', 'low', 'T1', 'T2', 'low T1', 'high T2', 'hypodense', 'hyperdense', 'hyperintense', 'hypointense', 'FLAIR', 'DWI', 'ADC'])
				assert.ok(hint.includes(term), `Missing transcription spelling hint: ${term}`);
			assert.match(hint, /spelling hints only, not findings to insert/);
			assert.match(hint, /Preserve negation, uncertainty, laterality, numbers, decimal points and measurement units/);
			assert.match(hint, /Do not swap high with low, hypo with hyper, T1 with T2/);
			assert.match(hint, /Never convert Jalali\/Shamsi\/Solar Hijri dates to Gregorian or vice versa/);
			assert.match(hint, /Do not infer an unspecified calendar, expand a shortened year, or add missing date components/);
			assert.equal(options.body.has('language'), false);
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
The supplied template is the required report structure, not an example. Preserve every supplied heading's wording and case, and keep sections in exactly the supplied order. Do not rename, omit, merge or reorder headings, add unnecessary headings or substitute a generic layout. Follow the combined-examination and conclusion rules below only where they explicitly require an exception.
The selected English variant and complete-sentence rules take precedence over template spelling and telegraphic wording in narrative text, but must not rename headings or convert dates.
Preserve all clinically relevant information from the dictation. Do not omit any finding.
Adapt findings within the corresponding template sections. Replace all template statements that contradict the dictation, including contradictory normal statements elsewhere in the report. Keep other applicable template content. Place additional dictated findings in the most appropriate existing section without inventing new sections.
Preserve dictated dates in their original calendar, year, month, day, order and precision. Never convert Jalali/Shamsi/Solar Hijri dates to Gregorian or vice versa. Keep Jalali month names as Jalali month names; do not substitute Gregorian month names. Do not infer an unspecified calendar, expand a shortened year, or add missing date components. English translation and UK/US report preferences do not authorise calendar conversion.
Bold only pathologic or abnormal findings and recommendations with double asterisks. Do not bold normal or negative findings, headings, or routine text.
Do not invent findings, diagnoses, measurements, comparisons, or recommendations.
Correct obvious transcription, grammar, and terminology errors while preserving clinical meaning.
Write every finding, recommendation, and Conclusion item as a complete grammatical sentence, including a subject and finite verb; do not use standalone keywords, noun phrases, or telegraphic fragments. Section headings, the study title, and measurement/table labels may remain labels rather than sentences.
Expand dictated shorthand only into the minimum complete sentence that preserves its meaning: for example, "joint effusion" becomes "A joint effusion is present." Do not add an undictated location, side, severity, cause, certainty, comparison, measurement, diagnosis, or recommendation. Preserve negation and uncertainty: "no joint effusion" becomes "No joint effusion is present," and "possible joint effusion" becomes "A joint effusion may be present."
Before returning the report, check that every narrative finding and Conclusion item is a complete sentence and that completing sentences has not changed or added clinical information. Compare the report against the supplied template: all required headings must retain their wording, case and order, subject only to the explicit combined-examination and conclusion exceptions. Check every dictated date: its calendar and values must be unchanged, with no inferred or converted date.
Use concise professional language. Use only single line breaks between sections, except for one blank line before the conclusion section.
For a single examination, retain the template's existing conclusion, impression or summary heading exactly as supplied, in its supplied position; do not rename it to Conclusion or add a duplicate conclusion section. If the template has no such section, append one Conclusion at the end. For combined examinations, follow the shared Conclusion rule below.
In the conclusion section, summarise important abnormal findings and relevant recommendations without repeating normals.
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

test('every audio part receives bilingual hints and mixed-language findings reach generation unchanged', async (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'mixed-dictation-'));
	const parts = ['first.ogg', 'reply.ogg'].map((name) => ({ audio_report_path: join(directory, name) }));
	for (const part of parts) writeFileSync(part.audio_report_path, 'Synthetic test audio, not patient data');
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const dictations = [
		'ضایعه سمت چپ 1.5 mm با low T1 و high T2 دیده می‌شود. diffusion restriction ندارد.',
		'The right-sided focus is hypodense, not hyperdense. T1 hypointense and T2 hyperintense.'
	];
	const hints = [];
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		if (url.endsWith('/audio/transcriptions')) {
			assert.equal(options.body.get('file').name, ['first.ogg', 'reply.ogg'][calls]);
			hints.push(options.body.get('prompt'));
			assert.equal(options.body.has('language'), false);
			return { ok: true, json: async () => ({ text: dictations[calls++] }) };
		}
		assert.equal(url, 'https://api.openai.com/v1/responses');
		assert.equal(calls, 2);
		const prompt = JSON.parse(options.body).input;
		assert.ok(prompt.includes(`Doctor's dictation:\n"${dictations.join('\n')}"`));
		return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Synthetic final report.' }] }] }) };
	});
	assert.equal(await generateRecordingReport({ audio_parts: parts, modality_code: 'MR', exam_type_code: 'BRAIN', patient_gender: 'unknown' }, 'Synthetic template'), 'Synthetic final report.');
	assert.equal(hints.length, 2);
	assert.equal(hints[0], hints[1]);
	assert.match(hints[0], /Persian accent/);
});

test('transcription workflow requests exact template headings and unchanged dates independently of English preference', async (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'template-calendar-prompt-'));
	const audio = join(directory, 'synthetic.ogg');
	writeFileSync(audio, 'Synthetic audio; no patient data');
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const template = 'TECHNIQUE:\nSynthetic technique.\nOBSERVATIONS:\nSynthetic findings.\nIMPRESSION:\nSynthetic summary.';
	for (const variant of ['british', 'american']) {
		for (const date of ['۱۴۰۴/۰۷/۱۲ (Jalali)', '12 Mehr 1404 (Shamsi)', '2025-02-03 (Gregorian)', '04/07/12']) {
			await t.test(`${variant}: ${date}`, async (t) => {
				const dictation = `Synthetic comparison date: ${date}.`;
				const report = template.replace('Synthetic findings.', `The synthetic comparison date is ${date}.`);
				let calls = 0;
				t.mock.method(globalThis, 'fetch', async (url, options) => {
					calls++;
					if (url.endsWith('/audio/transcriptions')) {
						assert.match(options.body.get('prompt'), /Never convert Jalali\/Shamsi\/Solar Hijri dates to Gregorian or vice versa/);
						return { ok: true, json: async () => ({ text: dictation }) };
					}
					assert.equal(url, 'https://api.openai.com/v1/responses');
					const prompt = JSON.parse(options.body).input;
					assert.match(prompt, /Preserve every supplied heading's wording and case/);
					assert.match(prompt, /keep sections in exactly the supplied order/);
					assert.match(prompt, /retain the template's existing conclusion, impression or summary heading exactly as supplied/);
					assert.match(prompt, /without inventing new sections/);
					assert.match(prompt, /Never convert Jalali\/Shamsi\/Solar Hijri dates to Gregorian or vice versa/);
					assert.match(prompt, /Do not infer an unspecified calendar, expand a shortened year, or add missing date components/);
					assert.match(prompt, /UK\/US report preferences do not authorise calendar conversion/);
					assert.match(prompt, variant === 'american' ? /Use American/ : /Use British/);
					assert.ok(prompt.includes(`Template:\n"${template}"`));
					assert.ok(prompt.includes(`Doctor's dictation:\n"${dictation}"`));
					return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: report }] }] }) };
				});
				assert.equal(await generateRecordingReport({ audio_report_path: audio, modality_code: 'MR', exam_type_code: 'SYNTHETIC', report_english_variant: variant }, template), report);
				assert.equal(calls, 2);
			});
		}
	}
});
