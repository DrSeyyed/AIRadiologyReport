export function patientName(study) {
	const fullName = typeof study?.patient_fullname === 'string' ? study.patient_fullname.trim() : '';
	return (fullName || [study?.patient_firstname, study?.patient_lastname].filter(Boolean).join(' '))
		.trim()
		.replace(/\s+/g, ' ');
}
