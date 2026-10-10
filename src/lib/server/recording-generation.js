import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

async function openaiTranscribe(filePath, fileName) {
	const form = new FormData();

	form.append('model', 'gpt-transcribe');
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

async function openaiGenerateReport(prompt) {
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
	const examTypeLabel = s.exam_type_name || s.exam_type_code;
	const examDetailsLabel = s.exam_details ? ` (${s.exam_details})` : '';
	const studyLabel = `${examTypeLabel}${examDetailsLabel}, ${modalityLabel}`;
	const transcription = await openaiTranscribe(s.audio_report_path, basename(s.audio_report_path));
	const prompt = `
You are a radiology report generator.

Use the following template exactly as a guide for formatting the report.

Template:
"
${template}
"

Doctor's dictation: "${transcription}"

Patient gender: ${s.patient_gender}

Translate to English and produce the final ${studyLabel} report according to the template.
Return only the report text. Bold ONLY pathologic/abnormal findings and recommendations by wrapping them in **double asterisks**; do not bold normal/negative statements. Do NOT omit any clinically relevant content from the dictation, even if it does not belong to the primary study region or is not represented in the template.
`.trim();

	return openaiGenerateReport(prompt);
}
