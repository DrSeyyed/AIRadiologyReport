import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { normalizeDescription, parseStudyWorkbook } from '../src/lib/server/excel-studies.js';

const HEADERS = [
	'ID',
	'NAME',
	'MODALITY',
	'DESCRIPTION',
	'STUDY DATE',
	'STUDY INST UID',
	'GENDER',
	'AGE'
];
const DATA = [
	'0012',
	'FAMILY^GIVEN',
	'CT',
	'Synthetic description',
	'2024-03-20 13:45:06',
	'TEST.UID.1',
	'M',
	'089Y'
];

function workbook(rows, { bookType = 'xlsx', edit, date1904 = false, secondSheet } = {}) {
	const sheet = XLSX.utils.aoa_to_sheet(rows, { cellDates: false });
	if (edit) edit(sheet);
	const book = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(book, sheet, 'Synthetic');
	if (date1904) book.Workbook = { WBProps: { date1904: true } };
	if (secondSheet)
		XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(secondSheet), 'Ignored');
	return XLSX.write(book, { type: 'buffer', bookType });
}

function parseValues(values, options) {
	return parseStudyWorkbook(
		workbook(
			[
				HEADERS,
				...values.map((overrides) => {
					const data = [...DATA];
					for (const [key, value] of Object.entries(overrides)) data[HEADERS.indexOf(key)] = value;
					return data;
				})
			],
			options
		)
	);
}

for (const bookType of ['xls', 'xlsx']) {
	test(`${bookType}: first sheet roundtrip, formatted IDs, blank first column and headers`, () => {
		const rows = [
			['Synthetic export'],
			[null, ...HEADERS.map((header) => ` ${header.toLowerCase()} `), 'PATIENT KEY'],
			[
				null,
				12,
				'FAMILY^GIVEN^^MIDDLE',
				'ct',
				'Synthetic description',
				'2024-03-20 13:45:06',
				'TEST.UID.1',
				'male',
				'089Y',
				'NOT-THE-ID'
			],
			[],
			[null, 42, 'SINGLE', 'MR', 'Other synthetic description', '20240320', 'TEST.UID.1', 'O', null]
		];
		const studies = parseStudyWorkbook(
			workbook(rows, {
				bookType,
				edit: (sheet) => {
					sheet.B3.z = '000000';
				},
				secondSheet: [['unrelated']]
			})
		);
		assert.deepEqual(studies[0], {
			row: 3,
			source_study_uid: 'TEST.UID.1',
			patient_code: '000012',
			patient_firstname: 'GIVEN MIDDLE',
			patient_lastname: 'FAMILY',
			patient_gender: 'male',
			patient_age: 89,
			patient_age_unit: 'Y',
			modality_code: 'CT',
			source_description: 'Synthetic description',
			exam_date_jalali: '1403-01-01',
			exam_time: '13:45:06',
			errors: []
		});
		assert.equal(studies.length, 2);
		assert.equal(studies[1].row, 5);
		assert.equal(studies[1].patient_code, '42');
		assert.equal(studies[1].patient_lastname, 'SINGLE');
		assert.equal(studies[1].patient_firstname, '');
		assert.equal(studies[1].patient_age, null);
		assert.equal(studies[1].patient_age_unit, 'Y');
		assert.equal(studies[1].patient_gender, 'unknown');
		assert.equal(studies[1].exam_time, '00:00:00');
		assert.equal(studies[1].source_study_uid, studies[0].source_study_uid);
	});

	test(`${bookType}: real date cells and numeric Excel serial preserve wall clocks`, () => {
		const studies = parseValues(
			[
				{ 'STUDY DATE': new Date(2024, 2, 20, 13, 45, 6) },
				{ 'STUDY DATE': 45371 + (13 * 3600 + 45 * 60 + 6) / 86400 },
				{ 'STUDY DATE': 45371 }
			],
			{ bookType }
		);
		assert.deepEqual(
			studies.map((study) => [study.exam_date_jalali, study.exam_time]),
			[
				['1403-01-01', '13:45:06'],
				['1403-01-01', '13:45:06'],
				['1403-01-01', '00:00:00']
			]
		);
		assert.ok(studies.every((study) => study.errors.length === 0));
	});
}

test('description normalization retains punctuation and makes no splitting decisions', () => {
	assert.equal(
		normalizeDescription('  alpha / beta,\n gamma + delta  '),
		'ALPHA / BETA, GAMMA + DELTA'
	);
	assert.equal(normalizeDescription(null), '');
	assert.equal(
		parseValues([{ DESCRIPTION: 'Alpha / Beta, Gamma + Delta' }])[0].source_description,
		'Alpha / Beta, Gamma + Delta'
	);
});

test('SRC NAME fallback and NAME preference; PATIENT KEY never substitutes for ID', () => {
	const fallback = HEADERS.map((header) => (header === 'NAME' ? 'SRC NAME' : header));
	assert.equal(parseStudyWorkbook(workbook([fallback, DATA]))[0].patient_lastname, 'FAMILY');
	const preferred = parseStudyWorkbook(
		workbook([
			[...HEADERS, 'SRC NAME'],
			[...DATA, 'OTHER^VALUE']
		])
	)[0];
	assert.equal(preferred.patient_lastname, 'FAMILY');
	const noId = HEADERS.map((header) => (header === 'ID' ? 'PATIENT KEY' : header));
	assert.throws(() => parseStudyWorkbook(workbook([noId, DATA])), /headers/);
	const missingId = parseStudyWorkbook(
		workbook([
			[...HEADERS, 'PATIENT KEY'],
			[null, ...DATA.slice(1), 'SYNTHETIC-KEY']
		])
	)[0];
	assert.equal(missingId.patient_code, '');
	assert.ok(missingId.errors.includes('ID is required'));
});

test('DICOM ages retain units, numeric ages are years, birth date is ignored', () => {
	const studies = parseValues([
		{ AGE: '005M' },
		{ AGE: '003W' },
		{ AGE: '010D' },
		{ AGE: 0 },
		{ AGE: 23 },
		{ AGE: '24' },
		{ AGE: '' }
	]);
	assert.deepEqual(
		studies.map((study) => [study.patient_age, study.patient_age_unit]),
		[
			[5, 'M'],
			[3, 'W'],
			[10, 'D'],
			[0, 'Y'],
			[23, 'Y'],
			[24, 'Y'],
			[null, 'Y']
		]
	);
	assert.ok(studies.every((study) => study.errors.length === 0));
	const data = [...DATA];
	data[7] = '';
	const birth = parseStudyWorkbook(
		workbook([
			[...HEADERS, 'BIRTH DATE'],
			[...data, '2000-01-01']
		])
	)[0];
	assert.equal(birth.patient_age, null);
});

test('invalid ages yield fixed row errors', () => {
	const studies = parseValues(
		[-1, '-001Y', '089Q', 'unknown', 1.5, '1.5', '99999999999999999999'].map((AGE) => ({ AGE }))
	);
	for (const study of studies) {
		assert.equal(study.patient_age, null);
		assert.equal(study.patient_age_unit, 'Y');
		assert.deepEqual(study.errors, ['AGE is invalid']);
	}
});

test('gender labels are explicit; unsupported labels do not invent sex', () => {
	const labels = ['M', 'male', 'F', 'female', '', 'O', 'unknown', 'UNSUPPORTED-SYNTHETIC'];
	const studies = parseValues(labels.map((GENDER) => ({ GENDER })));
	assert.deepEqual(
		studies.map((study) => study.patient_gender),
		['male', 'male', 'female', 'female', 'unknown', 'unknown', 'unknown', 'unknown']
	);
	assert.ok(studies.slice(0, -1).every((study) => study.errors.length === 0));
	assert.deepEqual(studies.at(-1).errors, ['GENDER is invalid']);
});

test('strict Gregorian strings preserve optional recorded times', () => {
	const studies = parseValues(
		['2024-03-20', '2024-03-20 09:08', '20240320090807', '20240229', '2024-03-20 23:59:59'].map(
			(date) => ({ 'STUDY DATE': date })
		)
	);
	assert.deepEqual(
		studies.map((study) => [study.exam_date_jalali, study.exam_time]),
		[
			['1403-01-01', '00:00:00'],
			['1403-01-01', '09:08:00'],
			['1403-01-01', '09:08:07'],
			['1402-12-10', '00:00:00'],
			['1403-01-01', '23:59:59']
		]
	);
	assert.ok(studies.every((study) => study.errors.length === 0));
});

test('invalid dates are rejected before conversion, including Excel phantom leap day', () => {
	const dates = [
		'2023-02-29',
		'2024-02-30',
		'2024-13-01',
		'2024-00-01',
		'2024-01-00',
		'0000-01-01',
		'2024-3-20',
		'2024/03/20',
		'2024-03-20T12:00:00Z',
		'2024-03-20 24:00:00',
		'20240320235960',
		'20240320126000',
		'202403201234',
		-1,
		0,
		60,
		60.5
	];
	const studies = parseValues(dates.map((date) => ({ 'STUDY DATE': date })));
	for (const study of studies) {
		assert.equal(study.exam_date_jalali, null);
		assert.equal(study.exam_time, '00:00:00');
		assert.deepEqual(study.errors, ['STUDY DATE is invalid']);
	}
});

test('1904 workbook date system is respected', () => {
	const [study] = parseValues([{ 'STUDY DATE': 43909.5 }], { date1904: true });
	assert.equal(study.exam_date_jalali, '1403-01-01');
	assert.equal(study.exam_time, '12:00:00');
	assert.deepEqual(study.errors, []);
});

test('required missing cells remain rows with errors; blank rows are skipped', () => {
	const studies = parseStudyWorkbook(
		workbook([HEADERS, [], ['   '], [null, null, null, null, null, 'TEST.UID.2']])
	);
	assert.equal(studies.length, 1);
	assert.equal(studies[0].row, 4);
	assert.deepEqual(studies[0].errors, [
		'ID is required',
		'NAME is required',
		'MODALITY is required',
		'DESCRIPTION is required',
		'STUDY DATE is required'
	]);
	assert.ok(
		parseValues([{ 'STUDY INST UID': '' }])[0].errors.includes('STUDY INST UID is required')
	);
});

test('oversize strings are flagged without truncation or exposing cell contents', () => {
	const [study] = parseValues([
		{
			ID: 'I'.repeat(129),
			NAME: 'N'.repeat(201),
			DESCRIPTION: 'D'.repeat(501),
			'STUDY INST UID': 'U'.repeat(129)
		}
	]);
	assert.equal(study.patient_code.length, 129);
	assert.equal(study.patient_lastname.length, 201);
	assert.equal(study.source_description.length, 501);
	assert.equal(study.source_study_uid.length, 129);
	assert.deepEqual(study.errors, [
		'ID exceeds 128 characters',
		'NAME exceeds 200 characters',
		'DESCRIPTION exceeds 500 characters',
		'STUDY INST UID exceeds 128 characters'
	]);
});

test('header search stops at row 20; missing headers, malformed and empty workbooks reject', () => {
	const prefix = Array.from({ length: 19 }, () => ['Synthetic preamble']);
	assert.equal(parseStudyWorkbook(workbook([...prefix, HEADERS, DATA]))[0].row, 21);
	assert.throws(
		() => parseStudyWorkbook(workbook([['Extra'], ...prefix, HEADERS, DATA])),
		/headers/
	);
	assert.throws(() => parseStudyWorkbook(workbook([['Unrecognized'], DATA])), /headers/);
	assert.throws(() => parseStudyWorkbook(workbook([HEADERS, [], ['   ']])), /no data rows/);
	assert.throws(() => parseStudyWorkbook(workbook([])), /no data/);
	for (const buffer of [
		Buffer.alloc(0),
		Buffer.from('not an Excel workbook'),
		Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0])
	]) {
		assert.throws(() => parseStudyWorkbook(buffer), /Malformed Excel workbook/);
	}
});

test('5000 nonblank rows allowed; 5001 reject without counting blank rows', () => {
	const rows = Array.from({ length: 5000 }, () => [...DATA]);
	assert.equal(parseStudyWorkbook(workbook([HEADERS, [], ...rows, []])).length, 5000);
	assert.throws(() => parseStudyWorkbook(workbook([HEADERS, ...rows, [], DATA])), /5000 data rows/);
});
