import jalaali from 'jalaali-js';
import { listRecordings } from './recordings.js';
import { telegramVoiceCount } from './study-state.js';
import { patientName } from '../patient-name.js';

export const studyFields = [
	'patient_code',
	'study_key',
	'patient_fullname',
	'patient_firstname',
	'patient_lastname',
	'patient_gender',
	'patient_age',
	'patient_age_unit',
	'modality_id',
	'exam_type_id',
	'exam_details',
	'exam_date_jalali',
	'exam_time',
	'corresponding_resident_id',
	'corresponding_attending_id',
	'dicom_url',
	'description'
];

export function getStudyDetail(db, id) {
	const study = db
		.prepare(
			`
		SELECT s.*, s.id AS study_id,
			m.code AS modality_code, m.name AS modality_name,
			e.code AS exam_type_code, e.name AS exam_type_name,
			r.full_name AS resident_fullname, a.full_name AS attending_fullname
		FROM studies s
		LEFT JOIN modalities m ON m.id = s.modality_id
		LEFT JOIN exam_types e ON e.id = s.exam_type_id
		LEFT JOIN users r ON r.id = s.corresponding_resident_id
		LEFT JOIN users a ON a.id = s.corresponding_attending_id
		WHERE s.id = ?
	`
		)
		.get(id);
	if (!study) return undefined;
	study.patient_fullname = patientName(study);
	study.telegram_voice_count = telegramVoiceCount(db, id);
	study.recordings = listRecordings(db, id);
	study.recording_count = study.recordings.length;
	study.report_count = study.recordings.filter((r) => r.text_report_path).length;
	study.resident_checked_count = study.recordings.filter((r) => r.resident_checked).length;
	study.attending_checked_count = study.recordings.filter((r) => r.attending_checked).length;
	study.typist_checked_count = study.recordings.filter((r) => r.typist_checked).length;
	return study;
}

export function studySignatureFilter(filters) {
	const conditions = [],
		params = [];
	const residentId = filters.corresponding_resident_id ?? '';
	if (residentId !== '') {
		if (!/^[1-9]\d*$/.test(residentId) || !Number.isSafeInteger(Number(residentId)))
			throw new Error('Invalid resident filter');
		conditions.push('r.corresponding_resident_id = ?');
		params.push(Number(residentId));
	}
	for (const role of ['resident', 'attending', 'typist']) {
		const value = filters[`${role}_checked`] ?? '';
		if (value === '') continue;
		if (!['0', '1'].includes(value)) throw new Error('Invalid signature filter');
		conditions.push(`r.${role}_checked = ?`);
		params.push(Number(value));
	}
	if (!conditions.length) return { sql: '', params };
	const pendingWithoutRecordings = params.every((value) => value === 0)
		? ' OR NOT EXISTS (SELECT 1 FROM study_recordings r WHERE r.study_id = s.id)'
		: '';
	return {
		sql: ` AND (EXISTS (SELECT 1 FROM study_recordings r WHERE r.study_id = s.id AND ${conditions.join(' AND ')})${pendingWithoutRecordings})`,
		params
	};
}

export function normalizeStudyInput(db, input) {
	const output = {};
	for (const key of [
		'patient_code',
		'study_key',
		'patient_firstname',
		'patient_lastname',
		'exam_details',
		'description',
		'dicom_url'
	]) {
		if (input[key] != null && typeof input[key] !== 'string') throw new Error(`Invalid ${key}`);
		output[key] = (input[key] ?? '').trim();
		const limit =
			key === 'description'
				? 2000
				: key === 'dicom_url'
					? 2000
					: key === 'patient_code' || key === 'study_key'
						? 128
						: 200;
		if (output[key].length > limit) throw new Error(`${key} is too long`);
	}
	if (!output.patient_code) throw new Error('Patient code is required');
	if ('patient_fullname' in input && typeof input.patient_fullname !== 'string')
		throw new Error('Invalid patient_fullname');
	output.patient_fullname = 'patient_fullname' in input
		? input.patient_fullname.trim().replace(/\s+/g, ' ')
		: patientName(output);
	if (!output.patient_fullname) throw new Error('Patient full name is required');
	if (output.patient_fullname.length > 401) throw new Error('Patient full name is too long');
	output.patient_gender = input.patient_gender || 'unknown';
	if (!['male', 'female', 'unknown'].includes(output.patient_gender))
		throw new Error('Invalid patient gender');
	output.patient_age =
		input.patient_age == null || input.patient_age === '' ? null : Number(input.patient_age);
	if (
		output.patient_age !== null &&
		(!Number.isSafeInteger(output.patient_age) ||
			output.patient_age < 0 ||
			output.patient_age > 100000)
	)
		throw new Error('Invalid patient age');
	output.patient_age_unit = input.patient_age_unit || 'Y';
	if (!['Y', 'M', 'W', 'D'].includes(output.patient_age_unit)) throw new Error('Invalid age unit');
	for (const [field, table] of [
		['modality_id', 'modalities'],
		['exam_type_id', 'exam_types']
	]) {
		output[field] = input[field] == null || input[field] === '' ? null : Number(input[field]);
		if (
			output[field] !== null &&
			(!Number.isSafeInteger(output[field]) ||
				!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(output[field]))
		)
			throw new Error(`Select a valid ${field.replace('_id', '')}`);
	}
	for (const [field, role] of [
		['corresponding_resident_id', 'resident'],
		['corresponding_attending_id', 'attending']
	]) {
		output[field] = input[field] == null || input[field] === '' ? null : Number(input[field]);
		if (
			output[field] !== null &&
			(!Number.isSafeInteger(output[field]) ||
				!db.prepare('SELECT id FROM users WHERE id = ? AND role = ?').get(output[field], role))
		)
			throw new Error(`Invalid ${role} assignment`);
	}
	const date =
		typeof input.exam_date_jalali === 'string'
			? input.exam_date_jalali.match(/^(\d{4})-(\d{2})-(\d{2})$/)
			: null;
	if (!date || !jalaali.isValidJalaaliDate(Number(date[1]), Number(date[2]), Number(date[3])))
		throw new Error('Invalid Jalali exam date');
	output.exam_date_jalali = input.exam_date_jalali;
	const time =
		typeof input.exam_time === 'string'
			? input.exam_time.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/)
			: null;
	if (!time || Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] || 0) > 59)
		throw new Error('Invalid exam time');
	output.exam_time = `${time[1]}:${time[2]}:${time[3] || '00'}`;
	return output;
}

export function insertStudy(db, input, source = {}) {
	const payload = normalizeStudyInput(db, input);
	payload.source_study_uid = source.source_study_uid || null;
	payload.source_component = source.source_component || null;
	payload.source_description = source.source_description || null;
	payload.source_modality = source.source_modality || null;
	const columns = [
		...studyFields,
		'source_study_uid',
		'source_component',
		'source_description',
		'source_modality'
	];
	const result = db
		.prepare(
			`INSERT INTO studies (${columns.join(', ')}) VALUES (${columns.map((field) => `@${field}`).join(', ')})`
		)
		.run(payload);
	return Number(result.lastInsertRowid);
}
