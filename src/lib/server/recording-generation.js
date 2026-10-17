import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { recordingExaminations } from '../recording-examinations.js';

const transcriptionPrompt = `دیکتهٔ رادیولوژی ممکن است فارسی، انگلیسی یا ترکیبی از هر دو باشد. متن را به همان زبان گفتار پیاده کن و اصطلاحات انگلیسی رادیولوژی را با حروف لاتین بنویس. ترجمه یا گزارش‌نویسی نکن.
Transcribe only what is audible. Preserve Persian speech and English medical terms in mixed-language dictation, including English terms spoken with a Persian accent. Use standard English spellings for clearly recognised radiology terms and keep sequence names in Latin characters.
Radiology vocabulary (spelling hints only, not findings to insert): high, low, T1, T2, T1-weighted, T2-weighted, low T1, high T1, low T2, high T2, hypodense, hyperdense, isodense, hypointense, hyperintense, isointense, FLAIR, STIR, DWI, ADC, diffusion restriction, enhancement, with contrast, without contrast.
Preserve negation, uncertainty, laterality, numbers, decimal points and measurement units exactly as dictated. Do not swap high with low, hypo with hyper, T1 with T2, or right with left. Do not infer a signal or density from the expected diagnosis. Do not add glossary terms, findings, normal statements or recommendations that were not spoken. Do not guess unclear words or complete missing speech.`;

async function openaiTranscribe(filePath, fileName) {
	const form = new FormData();

	form.append('model', 'gpt-transcribe');
	form.append('prompt', transcriptionPrompt);
	form.append('file', new Blob([readFileSync(filePath)]), fileName);

	const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
		method: 'POST',
		signal: AbortSignal.timeout(120000),
		headers: {
			Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
		},
		body: form
	});

	if (!res.ok) {
		const err = await res.text().catch(() => '');

		throw new Error(`OpenAI transcription failed (HTTP ${res.status}): ${err}`);
	}

	const data = await res.json();
	const text = typeof data.text === 'string' ? data.text.trim() : '';

	if (!text) {
		throw new Error('OpenAI transcription returned no text.');
	}

	return text;
}

export async function openaiGenerateReport(prompt) {
	const res = await fetch('https://api.openai.com/v1/responses', {
		method: 'POST',
		signal: AbortSignal.timeout(120000),
		headers: {
			Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: 'gpt-6.1-sol',
			input: prompt
		})
	});

	if (!res.ok) {
		const err = await res.text().catch(() => '');

		throw new Error(`OpenAI generation failed (HTTP ${res.status}): ${err}`);
	}

	const data = await res.json();

	if (data.error) {
		throw new Error(`OpenAI generation failed: ${data.error.message || 'Unknown error'}`);
	}

	// Prevent saving an incomplete report.
	if (data.status !== 'completed') {
		const reason = data.incomplete_details?.reason;

		throw new Error(
			`OpenAI response was not completed: ${data.status || 'unknown'}${
				reason ? ` (${reason})` : ''
			}`
		);
	}

	// Extract text from the raw Responses API JSON.
	// The first output item can be reasoning rather than a message.
	const content = (Array.isArray(data.output) ? data.output : [])
		.filter((item) => item?.type === 'message')
		.flatMap((item) => (Array.isArray(item.content) ? item.content : []));

	const refusal = content.find((part) => part?.type === 'refusal');

	if (refusal) {
		throw new Error(
			`OpenAI refused to generate the report: ${refusal.refusal || 'No reason given'}`
		);
	}

	const text = content
		.filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
		.map((part) => part.text)
		.join('\n')
		.trim();

	if (!text) {
		throw new Error(`OpenAI returned no report text (response ID: ${data.id || 'unknown'}).`);
	}

	return text;
}

export async function generateRecordingReport(s, template) {
	const modalityLabel = s.modality_name || s.modality_code;
	const examinations = recordingExaminations(s);
	const combined = examinations.length > 1;
	const examTypeLabel = combined ? examinations.map((exam) => exam.name || exam.code).join(' + ') : s.exam_type_name || s.exam_type_code;
	const combinedInstructions = combined ? '\nThis is one combined examination using a single modality. Use a separate body-part heading for each selected examination in the order listed. Keep each finding under its correct body part; do not duplicate it across body parts or apply it to other examinations. Include exactly one shared Conclusion at the end, not a Conclusion or Impression for each body part. Ignore prewritten conclusions in the source templates; derive the shared Conclusion only from the dictation. Do not copy normal template statements that contradict the dictation.' : '';
	const examDetailsLabel = s.exam_details ? ` (${s.exam_details})` : '';
	const studyLabel = `${examTypeLabel}${examDetailsLabel}, ${modalityLabel}`;
	const audioParts = s.audio_parts?.length ? s.audio_parts : [{ audio_report_path: s.audio_report_path }];
	const transcriptions = [];
	for (const part of audioParts)
		transcriptions.push(await openaiTranscribe(part.audio_report_path, basename(part.audio_report_path)));
	const transcription = transcriptions.join('\n');
	const prompt = `You are a radiology report generator.
Translate the doctor's dictation into English and produce a professional radiology report.
Use British radiology terminology and UK English spelling and phrasing.
Follow the template structure, section order, and formatting as closely as possible.
Preserve all clinically relevant information from the dictation. Do not omit any finding.
Add relevant dictated findings that do not fit an existing section.
Bold only pathologic or abnormal findings and recommendations with double asterisks. Do not bold normal or negative findings, headings, or routine text.
Do not invent findings, diagnoses, measurements, comparisons, or recommendations.
Correct obvious transcription, grammar, and terminology errors while preserving clinical meaning.
Use concise professional language. Use only single line breaks between sections, except for one blank line before the Conclusion.
Include a Conclusion that summarises important abnormal findings and relevant recommendations without repeating normals.
If no significant abnormality, give a concise normal conclusion.
Bold all recommendations in the body and Conclusion.
Return only the final report text.
Study label: ${studyLabel}
Template:
"${template}"${combinedInstructions}
Doctor's dictation:
"${transcription}"
Patient gender: ${s.patient_gender}`;

	return openaiGenerateReport(prompt);
}
