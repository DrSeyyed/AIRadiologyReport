export function studyLabel(study) {
	const code = String(study?.patient_code ?? '').trim();
	return code ? `Study ${code}` : `Study #${study?.id ?? '-'}`;
}
