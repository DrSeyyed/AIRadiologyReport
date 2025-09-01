import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { execSync } from 'node:child_process';

const REPORT_DIR = 'uploads/reports';

function saveReport(db, studyId, text) {
	if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
	const path = join(REPORT_DIR, `study_${studyId}.txt`);
	writeFileSync(path, text ?? '', 'utf-8');
	db.prepare(`UPDATE studies SET text_report_path = ? WHERE id = ?`).run(path, studyId);
	return path;
}

async function openaiTranscribe(filePath, fileName) {
	// Uses OpenAI Whisper via the Audio Transcriptions endpoint
	const form = new FormData();
	form.append('model', 'gpt-4o-transcribe'); // or 'gpt-4o-mini-transcribe' if you prefer
	form.append('file', new Blob([readFileSync(filePath)]), fileName);
	// If you mostly dictate in Persian: form.append('language', 'fa');

	const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
		method: 'POST',
		headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
		body: form
	});
	if (!res.ok) {
		const err = await res.text();
		throw new Error(`OpenAI transcription failed: ${err}`);
	}
	const data = await res.json();
	return data.text || '';
}

function localCliTranscribe(filePath) {
	// Example: whisper.cpp or faster-whisper via TRANSCRIBE_CMD
	// TRANSCRIBE_CMD='whisper-cpp -m ./models/ggml-base.bin -f "{input}" -otxt -of "uploads/reports/tmp" -l auto'
	const cmd = process.env.TRANSCRIBE_CMD;
	if (!cmd) throw new Error('TRANSCRIBE_CMD not configured');

	const outBase = join(REPORT_DIR, `tmp_${Date.now()}`);
	if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });

	const built = cmd.replaceAll('{input}', filePath).replaceAll('{out}', outBase);
	let transcript = '';
	try {
		const stdout = execSync(built, { stdio: ['ignore', 'pipe', 'pipe'] });
		transcript = stdout?.toString('utf-8')?.trim() || transcript;
	} catch (e) {
		// Fallback: many CLIs write a txt file
		const txtPath = `${outBase}.txt`;
		if (existsSync(txtPath)) {
			transcript = readFileSync(txtPath, 'utf-8');
		} else {
			throw e;
		}
	}
	return transcript;
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
		throw new Error(`OpenAI generate failed: ${err}`);
	}

	const data = await res.json();

	// --- Prefer Responses API shapes ---
	let text = '';

	// 1) Convenient field sometimes present
	if (typeof data.output_text === 'string' && data.output_text.trim()) {
		text = data.output_text.trim();
	}

	// 2) New Responses API "output" array with a "message" item containing "content" blocks
	if (!text && Array.isArray(data.output)) {
		const msg = data.output.find((o) => o.type === 'message' && Array.isArray(o.content));
		if (msg) {
			text = msg.content
				.map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
				.filter(Boolean)
				.join('\n')
				.trim();
		} else {
			// Sometimes output is other block types that still carry text
			text = data.output
				.map((o) => o?.content?.[0]?.text ?? o?.text ?? '')
				.filter(Boolean)
				.join('\n')
				.trim();
		}
	}

	// --- Fallbacks for Chat/Completions-like shapes ---
	if (!text) {
		text = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
		text = typeof text === 'string' ? text.trim() : String(text || '');
	}
	console.log('text ', text);
	return text;
}

export async function POST({ params, locals }) {
	if (!locals.user) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
	}

	const id = Number(params.id);
	const db = getDb();

	// 1) Ensure audio exists
	const s = db
		.prepare(
			`SELECT s.modality_id, s.exam_type_id, s.exam_details, s.audio_report_path, p.gender AS patient_gender
       FROM studies s
       JOIN patients p ON p.id = s.patient_id
       WHERE s.id = ?`
		)
		.get(id);

	if (!s?.audio_report_path) {
		return new Response(JSON.stringify({ error: 'No audio uploaded for this study' }), {
			status: 400
		});
	}
	if (!existsSync(s.audio_report_path)) {
		return new Response(JSON.stringify({ error: 'Audio file not found on server' }), {
			status: 404
		});
	}

	// 2) Transcribe
  
	let transcription = '';
	try {
		if (process.env.OPENAI_API_KEY) {
			transcription = await openaiTranscribe(s.audio_report_path, basename(s.audio_report_path));
		} else if (process.env.TRANSCRIBE_CMD) {
			transcription = localCliTranscribe(s.audio_report_path);
		} else {
			return new Response(
				JSON.stringify({
					error:
						'No transcription configured. Set OPENAI_API_KEY or TRANSCRIBE_CMD to enable transcription.'
				}),
				{ status: 501 }
			);
		}
	} catch (e) {
		return new Response(JSON.stringify({ error: e?.message || 'Transcription failed' }), {
			status: 500
		});
	};
	
//   let transcription =
// 		'افیژن سیویر پلورال در سمت راست و مودریت در سمت چپ به همراه پسیف کلاپس ریه مجاور مشهود است. شواهد کاردیومگالی مشاهده می گردد. آسیت مودریت شکمی مشهود است. تصویر ساختار های تی تو غیر اختصاصی به سایز تقریبی 20 در 11 میلیمتر در مجاورت لیگامان فالسيفور مشاهده می شود که نیاز به تطبیق و یافته های سناگرافی دارد. شواهد کلسیستکتامی مشاهده می گردد. دیلاتاسیون مجاری صفرابی داخل کبدی مشهود است. سی بیدی 13 میلیمتر تنگی در قسمت دیستال سی بیدی در ناهی آمپول باطر قابل مشاهده می باشد. تطبیق و یافته های کلینیکی و آزمایشگاهی به درصورت اندیکاسیون بررسی تکمیلی با اندوساناگرافی پیشنهاد می گردد. چند کیست کورتیکال کوچک در هر دو کلیه مشهود است. هیدرونفروز خفیف در کلیه سمت چپ به همراه دیلاتاسیون پروگزیمال حالب در این سمت قابل مشاهده می باشد که مطرح کننده درجاتی از یو پی جی او در این سمت می باشد. فولنس در کلیه سمت راست نیز قابل مشاهده می باشد. ادم زیجلدی در اطراف شکم مشهود است.';

	const template = db
		.prepare(
			`
  SELECT text
  FROM report_templates
  WHERE modality_id = ? AND exam_type_id = ?
  LIMIT 1
`
		)
		.get(s.modality_id, s.exam_type_id).text;

	const patient_gender = s.patient_gender;

	const modalityRow = db
		.prepare(`SELECT code, name FROM modalities WHERE id = ?`)
		.get(s.modality_id);
	const modalityLabel = (modalityRow?.name || modalityRow?.code || 'Imaging').trim();

	const examTypeRow = db
		.prepare(`SELECT code, name FROM exam_types WHERE id = ?`)
		.get(s.exam_type_id);
	const examTypeLabel = (examTypeRow?.name || examTypeRow?.code || '').trim();

	const examDetailsLabel = s.exam_detail ? ` (${s.exam_detail})` : '';

	// Compose a concise study label: e.g., "MR Abdomen and Pelvic"
	const studyLabel = `${examTypeLabel}${examDetailsLabel}, ${modalityLabel}`;

	// 4) Build your exact prompt (as in your Python sample)
let prompt = `
You are a radiology report generator.

Use the following template exactly as a guide for formatting the report. 

Template:
"
${template}
"

Doctor's dictation: "${transcription}"

Patient gender: ${patient_gender}

Translate to English and produce the final ${studyLabel} report according to the template.
Return only the report text. Bold ONLY pathologic/abnormal findings by wrapping them in **double asterisks**; do not bold normal/negative statements. Do NOT omit any clinically relevant content from the dictation, even if it does not belong to the primary study region or is not represented in the template.
`.trim();

// prompt = `
// You are a radiology report generator.

// Use the following template exactly as a guide for formatting the report.

// Template:
// "
// ${template}
// "

// Doctor's dictation: "${transcription}"
// Patient gender: ${patient_gender}
// Study label: ${studyLabel}

// Instructions:
// - Write the final report in Persian (Farsi). Do NOT translate into English.
// - The output must be right-to-left.
// - Use Persian punctuation marks throughout (convert if needed): "،" for commas, "؛" for semicolons, "؟" for questions, "٪" for percent, with correct spacing rules.
// - Bold ONLY pathologic/abnormal findings by wrapping them in **double asterisks**; do not bold normal/negative statements.
// - Follow the template’s section headings and structure exactly; fill all placeholders consistently from the dictation.
// - Return only the report text (no explanations, no code fences).

// Generate the final ${studyLabel} report now.
// `.trim();

	// 5) Generate final report via OpenAI Responses API
	console.log(prompt);

  let finalReport = '';
	try {
		if (!process.env.OPENAI_API_KEY) {
			return new Response(
				JSON.stringify({
					error: 'OPENAI_API_KEY not set; cannot generate report. (Transcription completed.)'
				}),
				{ status: 501 }
			);
		}
		finalReport = await openaiGenerateReport(prompt);
	} catch (e) {
		return new Response(JSON.stringify({ error: e?.message || 'Generation failed' }), {
			status: 500
		});
	}
	console.log('here ', finalReport);
	//let finalReport = prompt
	// 6) Save report file & update DB
	const path = saveReport(db, id, finalReport);

	return json({
		ok: true,
		path,
		text: finalReport
	});
}
