import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import {
	existsSync,
	mkdirSync,
	writeFileSync,
	readFileSync
} from 'node:fs';
import { join, basename } from 'node:path';

const REPORT_DIR = 'uploads/reports';

function saveReport(db, studyId, text) {
	if (!existsSync(REPORT_DIR)) {
		mkdirSync(REPORT_DIR, { recursive: true });
	}

	const path = join(REPORT_DIR, `study_${studyId}.txt`);

	writeFileSync(path, text, 'utf-8');

	db.prepare(
		'UPDATE studies SET text_report_path = ? WHERE id = ?'
	).run(path, studyId);

	return path;
}

async function openaiTranscribe(filePath, fileName) {
	const form = new FormData();

	form.append('model', 'gpt-4o-transcribe');
	form.append('file', new Blob([readFileSync(filePath)]), fileName);

	const res = await fetch(
		'https://api.openai.com/v1/audio/transcriptions',
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
			},
			body: form
		}
	);

	if (!res.ok) {
		const err = await res.text().catch(() => '');

		throw new Error(
			`OpenAI transcription failed (HTTP ${res.status}): ${err}`
		);
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
		headers: {
			Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: 'gpt-5',
			input: prompt
		})
	});

	if (!res.ok) {
		const err = await res.text().catch(() => '');

		throw new Error(
			`OpenAI generation failed (HTTP ${res.status}): ${err}`
		);
	}

	const data = await res.json();

	if (data.error) {
		throw new Error(
			`OpenAI generation failed: ${data.error.message || 'Unknown error'}`
		);
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
		.flatMap((item) =>
			Array.isArray(item.content) ? item.content : []
		);

	const refusal = content.find((part) => part?.type === 'refusal');

	if (refusal) {
		throw new Error(
			`OpenAI refused to generate the report: ${
				refusal.refusal || 'No reason given'
			}`
		);
	}

	const text = content
		.filter(
			(part) =>
				part?.type === 'output_text' &&
				typeof part.text === 'string'
		)
		.map((part) => part.text)
		.join('\n')
		.trim();

	if (!text) {
		throw new Error(
			`OpenAI returned no report text (response ID: ${
				data.id || 'unknown'
			}).`
		);
	}

	return text;
}

export async function POST({ params, locals }) {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const id = Number(params.id);

	if (!Number.isSafeInteger(id) || id <= 0) {
		return json({ error: 'Invalid study ID' }, { status: 400 });
	}

	if (!process.env.OPENAI_API_KEY) {
		return json(
			{
				error:
					'Set OPENAI_API_KEY to enable transcription and report generation.'
			},
			{ status: 501 }
		);
	}

	try {
		const db = getDb();

		const s = db
			.prepare(`
				SELECT
					s.modality_id,
					s.exam_type_id,
					s.exam_details,
					s.audio_report_path,
					p.gender AS patient_gender
				FROM studies s
				JOIN patients p ON p.id = s.patient_id
				WHERE s.id = ?
			`)
			.get(id);

		if (!s) {
			return json({ error: 'Study not found' }, { status: 404 });
		}

		if (!s.audio_report_path) {
			return json(
				{ error: 'No audio uploaded for this study' },
				{ status: 400 }
			);
		}

		if (!existsSync(s.audio_report_path)) {
			return json(
				{ error: 'Audio file not found on server' },
				{ status: 404 }
			);
		}

		const templateRow = db
			.prepare(`
				SELECT text
				FROM report_templates
				WHERE modality_id = ? AND exam_type_id = ?
				LIMIT 1
			`)
			.get(s.modality_id, s.exam_type_id);

		const template = templateRow?.text;

		if (typeof template !== 'string' || !template.trim()) {
			return json(
				{
					error:
						'No report template configured for this modality and exam type'
				},
				{ status: 400 }
			);
		}

		const modalityRow = db
			.prepare('SELECT code, name FROM modalities WHERE id = ?')
			.get(s.modality_id);

		const modalityLabel = (
			modalityRow?.name ||
			modalityRow?.code ||
			'Imaging'
		).trim();

		const examTypeRow = db
			.prepare('SELECT code, name FROM exam_types WHERE id = ?')
			.get(s.exam_type_id);

		const examTypeLabel = (
			examTypeRow?.name ||
			examTypeRow?.code ||
			''
		).trim();

		// Correct field name: exam_details.
		const examDetailsLabel = s.exam_details
			? ` (${s.exam_details})`
			: '';

		const studyLabel =
			`${examTypeLabel}${examDetailsLabel}, ${modalityLabel}`;

		const transcription = await openaiTranscribe(
			s.audio_report_path,
			basename(s.audio_report_path)
		);

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

		const finalReport = await openaiGenerateReport(prompt);
		const path = saveReport(db, id, finalReport);

		return json({
			ok: true,
			path,
			text: finalReport
		});
	} catch (e) {
		return json(
			{
				error:
					e instanceof Error
						? e.message
						: 'Report generation failed'
			},
			{ status: 500 }
		);
	}
}