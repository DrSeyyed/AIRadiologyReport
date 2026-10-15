import { openaiGenerateReport } from './recording-generation.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const validId = (value) => (typeof value === 'number' || typeof value === 'string') && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));

export const NORMAL_TEMPLATE_PROMPT = `Create a normal findings template.
List only structures that belong to the exact given body part and modality.
Do not include adjacent regions or unrelated structures (e.g. do not mention upper abdomen in a chest study).
Include key related systems or details that are part of that body part.
Write each finding as a short complete sentence (1–2 sentences).
One structure or system per line.
No labels with colons. No extra blank lines or spaces. No other sections.
Modality: [MODALITY]
Body part: [BODY PART]`;

const selection = `SELECT rt.id, rt.modality_id, rt.exam_type_id, rt.text,
	m.code AS modality_code, m.name AS modality_name,
	et.name AS exam_type_name, et.code AS exam_type_code
	FROM report_templates rt JOIN modalities m ON m.id = rt.modality_id
	JOIN exam_types et ON et.id = rt.exam_type_id`;

export function templatePair(db, modalityId, examTypeId) {
	if (!validId(modalityId) || !validId(examTypeId)) fail(400, 'Select a modality and examination.');
	const modality = db.prepare('SELECT id, code, name FROM modalities WHERE id = ?').get(Number(modalityId));
	const examination = db.prepare('SELECT id, code, name FROM exam_types WHERE id = ?').get(Number(examTypeId));
	if (!modality || !examination) fail(404, 'Modality or examination not found.');
	return { modality, examination };
}

export function listTemplates(db, pair) {
	return db.prepare(`${selection}${pair ? ' WHERE rt.modality_id = ? AND rt.exam_type_id = ?' : ''} ORDER BY m.code, et.name`)
		.all(...(pair ? [pair.modality.id, pair.examination.id] : []));
}

export function saveTemplate(db, body) {
	const { modality, examination } = templatePair(db, body?.modality_id, body?.exam_type_id);
	const text = body?.text;
	if (typeof text !== 'string' || !text.trim() || text.length > 50000) fail(400, 'Template text must contain 1–50,000 characters.');
	if (body.id != null && !validId(body.id)) fail(400, 'Invalid template ID.');
	return db.transaction(() => {
		const existing = db.prepare('SELECT id FROM report_templates WHERE modality_id = ? AND exam_type_id = ?')
			.get(modality.id, examination.id);
		if (body.id != null) {
			if (!db.prepare('SELECT id FROM report_templates WHERE id = ?').get(Number(body.id))) fail(404, 'Template not found.');
			if (existing && existing.id !== Number(body.id)) fail(409, 'A template already exists for this selection.');
			db.prepare('UPDATE report_templates SET modality_id = ?, exam_type_id = ?, text = ? WHERE id = ?')
				.run(modality.id, examination.id, text.trim(), Number(body.id));
		} else if (existing) {
			if (body.create_only) fail(409, 'A template now exists for this selection. Reload it before editing.');
			db.prepare('UPDATE report_templates SET text = ? WHERE id = ?').run(text.trim(), existing.id);
		} else {
			db.prepare('INSERT INTO report_templates(modality_id, exam_type_id, text) VALUES(?, ?, ?)')
				.run(modality.id, examination.id, text.trim());
		}
		return listTemplates(db, { modality, examination })[0];
	})();
}

export async function generateTemplateDraft(db, body, generate = openaiGenerateReport) {
	const { modality, examination } = templatePair(db, body?.modality_id, body?.exam_type_id);
	if (!process.env.OPENAI_API_KEY) fail(503, 'OpenAI is not configured.');
	const prompt = NORMAL_TEMPLATE_PROMPT.replace('[MODALITY]', () => `${modality.code} (${modality.name})`)
		.replace('[BODY PART]', () => examination.name);
	let result;
	try {
		result = await generate(prompt);
	} catch {
		fail(502, 'Unable to generate a template. Try again.');
	}
	if (typeof result !== 'string') fail(502, 'AI returned an empty template.');
	const text = result.split(/\r?\n/).map((line) => line.trim().replace(/[\t ]+/g, ' ')).filter(Boolean).join('\n');
	if (!text || text.length > 50000) fail(502, 'AI returned an empty or oversized template.');
	return { text };
}
