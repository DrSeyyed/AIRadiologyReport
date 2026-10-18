export function recordingExaminations(recording) {
	if (recording?.exam_types?.length) return recording.exam_types.map((exam) => ({
		...exam, exam_details: exam.exam_details ?? recording.exam_details ?? ''
	}));
	return recording?.exam_type_id ? [{
		id: recording.exam_type_id,
		code: recording.exam_type_code,
		name: recording.exam_type_name,
		exam_details: recording.exam_details ?? ''
	}] : [];
}

export function examinationLabel(exam) {
	const name = String(exam.name || exam.code || exam.id).replace(/\s+/g, ' ').trim();
	const details = String(exam.exam_details ?? '').replace(/\s+/g, ' ').trim();
	return `${name}${details ? ` (${details})` : ''}`;
}
