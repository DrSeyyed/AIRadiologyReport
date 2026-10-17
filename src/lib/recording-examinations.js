export function recordingExaminations(recording) {
	if (recording?.exam_types?.length) return recording.exam_types;
	return recording?.exam_type_id ? [{
		id: recording.exam_type_id,
		code: recording.exam_type_code,
		name: recording.exam_type_name
	}] : [];
}
