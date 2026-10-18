export const studySortOptions = [
	{ value: 's.patient_code', label: 'Patient Code' },
	{ value: 's.patient_fullname', label: 'Full name' },
	{ value: 's.patient_age', label: 'Patient Age' },
	{ value: 'source_modality', label: 'Source modality' },
	{ value: 'source_description', label: 'Source description' },
	{ value: 's.exam_date_jalali', label: 'Exam Date / time' },
	{ value: 'attending_fullname', label: 'Study attending' },
	{ value: 'residents', label: 'Resident' },
	{ value: 'recording_count', label: 'Recordings' },
	{ value: 'report_count', label: 'Reports' },
	{ value: 'resident_checked_count', label: 'Resident signatures' },
	{ value: 'attending_checked_count', label: 'Attending signatures' },
	{ value: 'typist_checked_count', label: 'Typist signatures' },
	{ value: 'is_favorite', label: 'My favorites' },
	{ value: 's.modality_id', label: 'Recording modality (legacy)' },
	{ value: 's.exam_type_id', label: 'Examination (legacy)' }
];

export function normalizeStudySort(value) {
	const aliases = {
		'p.patient_code': 's.patient_code',
		'p.firstname': 's.patient_fullname',
		'p.lastname': 's.patient_fullname',
		's.patient_firstname': 's.patient_fullname',
		's.patient_lastname': 's.patient_fullname'
	};
	const key = aliases[value] || value;
	return studySortOptions.some((option) => option.value === key) ? key : 's.exam_date_jalali';
}

export function studySortHref(search, column, orderedby, orderdir) {
	const params = new URLSearchParams(search);
	params.set('orderedby', normalizeStudySort(column));
	params.set('orderdir', normalizeStudySort(orderedby) === column && orderdir === 'ASC' ? 'DESC' : 'ASC');
	params.set('page', '1');
	return `/studies?${params}`;
}
