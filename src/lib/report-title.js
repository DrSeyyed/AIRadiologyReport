function clean(value) {
	return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function reportTitle(recording) {
	const code = clean(recording?.modality_code).toUpperCase();
	const modality = { MR: 'MRI', MRI: 'MRI', CT: 'CT', US: 'Ultrasound', XR: 'X-ray' }[code]
		|| clean(recording?.modality_name) || code;
	const examination = clean(recording?.exam_type_name) || clean(recording?.exam_type_code);
	const details = clean(recording?.exam_details);
	const contrast = examination.match(/\s+(with\s*(?:&|and)\s*without contrast|without contrast|with contrast)$/i);
	const bodyPart = contrast ? examination.slice(0, contrast.index) : examination;
	const modalityPattern = modality.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const hasModality = modality && new RegExp(`\\b${modalityPattern}\\b`, 'i').test(bodyPart);
	const specialisedModality = (modality === 'MRI' && /\b(?:MRA|MRV|fMRI)\b/i.test(bodyPart))
		|| (modality === 'CT' && /\b(?:CTA|CTV)\b/i.test(bodyPart));
	let title = [bodyPart, hasModality || specialisedModality ? '' : modality, contrast?.[1]].filter(Boolean).join(' ');
	if (/^(left|right|bilateral)$/i.test(details)) {
		if (!new RegExp(`^${details}\\b`, 'i').test(title))
			title = `${details[0].toUpperCase()}${details.slice(1).toLowerCase()} ${title}`.trim();
	} else if (details) {
		title = title ? `${title} (${details})` : details;
	}
	return title || 'Radiology report';
}
