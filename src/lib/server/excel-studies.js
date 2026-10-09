import * as XLSX from 'xlsx';
import jalaali from 'jalaali-js';

const REQUIRED_HEADERS = ['ID', 'MODALITY', 'DESCRIPTION', 'STUDY DATE', 'STUDY INST UID'];
const MAX_ROWS = 5000;

export function normalizeDescription(text) {
	return String(text ?? '')
		.trim()
		.replace(/\s+/g, ' ')
		.toUpperCase();
}

function cellText(cell, formatted = false) {
	if (!cell || cell.v == null) return '';
	return String(formatted ? XLSX.utils.format_cell(cell) : cell.v).trim();
}

function validDate(year, month, day) {
	if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12) {
		return false;
	}
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return Number.isInteger(day) && day >= 1 && day <= days[month - 1];
}

function studyDate(cell, date1904) {
	let parts;
	if (cell?.v instanceof Date) {
		const date = cell.v;
		parts = [
			date.getUTCFullYear(),
			date.getUTCMonth() + 1,
			date.getUTCDate(),
			date.getUTCHours(),
			date.getUTCMinutes(),
			date.getUTCSeconds()
		];
	} else if (typeof cell?.v === 'number') {
		const serial = cell.v;
		if (!Number.isFinite(serial) || serial < 0 || (!date1904 && Math.floor(serial) === 60)) {
			return null;
		}
		// Round floating-point Excel fractions to the recorded second, without timezone conversion.
		const seconds = Math.round(serial * 86400);
		const wholeDays = Math.floor(seconds / 86400);
		if (!date1904 && wholeDays === 60) return null;
		const date = XLSX.SSF.parse_date_code(wholeDays, { date1904 });
		if (!date) return null;
		const clock = seconds % 86400;
		parts = [
			date.y,
			date.m,
			date.d,
			Math.floor(clock / 3600),
			Math.floor((clock % 3600) / 60),
			clock % 60
		];
	} else {
		const text = cellText(cell);
		const separated = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
		const compact = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?$/.exec(text);
		const match = separated || compact;
		if (!match) return null;
		parts = match.slice(1).map((value) => Number(value ?? 0));
	}
	const [year, month, day, hour, minute, second] = parts;
	if (
		!validDate(year, month, day) ||
		!Number.isInteger(hour) ||
		hour < 0 ||
		hour > 23 ||
		!Number.isInteger(minute) ||
		minute < 0 ||
		minute > 59 ||
		!Number.isInteger(second) ||
		second < 0 ||
		second > 59
	)
		return null;
	try {
		const { jy, jm, jd } = jalaali.toJalaali(year, month, day);
		const pad = (value) => String(value).padStart(2, '0');
		return {
			date: `${String(jy).padStart(4, '0')}-${pad(jm)}-${pad(jd)}`,
			time: `${pad(hour)}:${pad(minute)}:${pad(second)}`
		};
	} catch {
		return null;
	}
}

function parseAge(cell, errors) {
	const text = cellText(cell);
	if (!text) return { age: null, unit: 'Y' };
	const dicom = /^(\d{3})([YMWD])$/i.exec(text);
	const numeric = typeof cell.v === 'number' ? cell.v : /^\d+$/.test(text) ? Number(text) : NaN;
	if (dicom) return { age: Number(dicom[1]), unit: dicom[2].toUpperCase() };
	if (Number.isSafeInteger(numeric) && numeric >= 0) return { age: numeric, unit: 'Y' };
	errors.push('AGE is invalid');
	return { age: null, unit: 'Y' };
}

function parseGender(cell, errors) {
	const gender = cellText(cell).toUpperCase();
	if (gender === 'M' || gender === 'MALE') return 'male';
	if (gender === 'F' || gender === 'FEMALE') return 'female';
	if (gender === '' || gender === 'O' || gender === 'UNKNOWN') return 'unknown';
	errors.push('GENDER is invalid');
	return 'unknown';
}

/** Parse the first Excel sheet; row numbers are one-based worksheet coordinates. */
export function parseStudyWorkbook(buffer) {
	let workbook;
	try {
		if (!(buffer instanceof Uint8Array) || buffer.length < 8) throw new Error();
		const zip = buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 3 && buffer[3] === 4;
		const cfb = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every(
			(byte, i) => buffer[i] === byte
		);
		if (!zip && !cfb) throw new Error();
		// Keep date cells as serials so workbook wall-clock values never depend on host timezone.
		workbook = XLSX.read(buffer, {
			type: 'buffer',
			cellDates: false,
			cellNF: true,
			cellText: true
		});
	} catch {
		throw new Error('Malformed Excel workbook');
	}
	const sheet = workbook.Sheets[workbook.SheetNames[0]];
	if (!sheet?.['!ref']) throw new Error('Workbook has no data');
	let range;
	try {
		range = XLSX.utils.decode_range(sheet['!ref']);
	} catch {
		throw new Error('Malformed Excel worksheet');
	}
	const getCell = (row, column) => sheet[XLSX.utils.encode_cell({ r: row, c: column })];
	let header;
	let headerRow;
	for (let row = 0; row < 20 && row <= range.e.r; row++) {
		const columns = new Map();
		for (let column = range.s.c; column <= range.e.c; column++) {
			const label = cellText(getCell(row, column)).toUpperCase();
			if (label && !columns.has(label)) columns.set(label, column);
		}
		if (
			REQUIRED_HEADERS.every((label) => columns.has(label)) &&
			(columns.has('NAME') || columns.has('SRC NAME'))
		) {
			header = columns;
			headerRow = row;
			break;
		}
	}
	if (!header) throw new Error('Required Excel headers not found in the first 20 rows');
	const nameHeader = header.has('NAME') ? 'NAME' : 'SRC NAME';
	const date1904 = Boolean(workbook.Workbook?.WBProps?.date1904);
	const studies = [];
	for (let row = headerRow + 1; row <= range.e.r; row++) {
		let blank = true;
		for (let column = range.s.c; column <= range.e.c; column++) {
			if (cellText(getCell(row, column))) {
				blank = false;
				break;
			}
		}
		if (blank) continue;
		if (studies.length === MAX_ROWS) throw new Error('Workbook exceeds 5000 data rows');
		const cell = (label) => (header.has(label) ? getCell(row, header.get(label)) : undefined);
		const errors = [];
		const required = (label, limit, formatted = false) => {
			const value = cellText(cell(label), formatted);
			if (!value) errors.push(`${label} is required`);
			if (limit && value.length > limit) errors.push(`${label} exceeds ${limit} characters`);
			return value;
		};
		const patientCode = required('ID', 128, true);
		const name = required(nameHeader, 200);
		const components = name.split('^').map((part) => part.trim());
		const modality = required('MODALITY', 128).toUpperCase();
		const description = required('DESCRIPTION', 500);
		const uid = required('STUDY INST UID', 128);
		const dateText = required('STUDY DATE');
		const date = dateText ? studyDate(cell('STUDY DATE'), date1904) : null;
		if (dateText && !date) errors.push('STUDY DATE is invalid');
		const age = parseAge(cell('AGE'), errors);
		const gender = parseGender(cell('GENDER') ?? cell('SEX'), errors);
		studies.push({
			row: row + 1,
			source_study_uid: uid,
			patient_code: patientCode,
			patient_firstname: components.slice(1).filter(Boolean).join(' '),
			patient_lastname: components[0],
			patient_gender: gender,
			patient_age: age.age,
			patient_age_unit: age.unit,
			modality_code: modality,
			source_description: description,
			exam_date_jalali: date?.date ?? null,
			exam_time: date?.time ?? '00:00:00',
			errors
		});
	}
	if (!studies.length) throw new Error('Workbook has no data rows');
	return studies;
}
