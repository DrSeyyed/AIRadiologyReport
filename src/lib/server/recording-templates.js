import { recordingExaminations } from '../recording-examinations.js';
import { recordingError } from './recordings.js';

export function recordingTemplate(db, recording) {
	const examinations = recordingExaminations(recording);
	const lookup = db.prepare('SELECT text FROM report_templates WHERE modality_id = ? AND exam_type_id = ?');
	const templates = examinations.map((exam) => ({
		name: String(exam.name || exam.code || exam.id).replace(/\s+/g, ' ').trim(),
		text: lookup.get(recording.modality_id, exam.id)?.text
	}));
	const missing = templates.filter((template) => !template.text?.trim());
	if (missing.length || !templates.length)
		throw recordingError(`No report template configured for this modality and examination${missing.length ? `: ${missing.map((template) => template.name).join(', ')}` : ''}.`);
	if (templates.length === 1) return templates[0].text;
	return `${templates.map((template) => `## ${template.name}\n${template.text.trim()}`).join('\n\n')}\n\n## Conclusion`;
}
