import jalaali from 'jalaali-js';
import { patientName } from '../patient-name.js';
import { telegramMessageLink } from './telegram-replies.js';

const MESSAGE_LIMIT = 4096;

function parseDay(value) {
	if (typeof value !== 'string') return null;
	const match = value.trim().match(/^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/);
	if (!match) return null;
	const [, year, , month, day] = match;
	const date = { jy: Number(year), jm: Number(month), jd: Number(day) };
	return date.jy >= 1 && jalaali.isValidJalaaliDate(date.jy, date.jm, date.jd) ? date : null;
}

function formatDay({ jy, jm, jd }) {
	return [jy, jm, jd].map((value, index) => String(value).padStart(index === 0 ? 4 : 2, '0')).join('-');
}

function shiftDay(date, direction) {
	let { jy, jm, jd } = date;
	jd += direction;
	if (jd === 0) {
		if (--jm === 0) { jm = 12; jy--; }
		if (jy < 1) return null;
		jd = jalaali.jalaaliMonthLength(jy, jm);
	} else if (jd > jalaali.jalaaliMonthLength(jy, jm)) {
		jd = 1;
		if (++jm === 13) { jm = 1; jy++; }
	}
	return jalaali.isValidJalaaliDate(jy, jm, jd) ? { jy, jm, jd } : null;
}

function studyClock(study) {
	const date = parseDay(study?.exam_date_jalali);
	if (!date || typeof study?.exam_time !== 'string') return null;
	const match = study.exam_time.trim().match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
	if (!match) return null;
	const hour = Number(match[1]), minute = Number(match[2]), second = Number(match[3] || 0);
	if (hour > 23 || minute > 59 || second > 59) return null;
	const day = hour < 8 ? shiftDay(date, -1) : date;
	return day ? {
		day: formatDay(day),
		date: formatDay(date),
		seconds: hour * 3600 + minute * 60 + second,
		time: `${match[1]}:${match[2]}:${match[3] || '00'}`
	} : null;
}

export function clinicalDayForStudy(study) {
	return studyClock(study)?.day ?? null;
}

export function clinicalDayTopicName(day) {
	const date = parseDay(day);
	const next = date && shiftDay(date, 1);
	return next ? `${formatDay(date).replaceAll('-', '/')} 08:00 → ${formatDay(next).replaceAll('-', '/')} 08:00` : null;
}

function boundedText(value, limit) {
	const text = String(value ?? '').replace(/\s+/g, ' ').replace(/\p{Cc}/gu, '').trim();
	let result = '', length = 0;
	for (const character of text) {
		if (length === limit) return `${result}…`;
		result += character;
		length++;
	}
	return result;
}

function escapeHtml(value) {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function messageId(value) {
	if (typeof value !== 'string' && typeof value !== 'number') return null;
	const text = String(value).trim();
	if (!/^\d+(?:\.0+)?$/.test(text)) return null;
	const id = Number(text);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function compareIds(a, b) {
	const left = String(a ?? ''), right = String(b ?? '');
	if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
		const x = BigInt(left), y = BigInt(right);
		if (x !== y) return x < y ? -1 : 1;
	}
	return left < right ? -1 : left > right ? 1 : 0;
}

function entryText({ row, clock, link }) {
	const code = boundedText(row.patient_code, 64) || boundedText(`Study ${row.id ?? ''}`, 64);
	const name = boundedText(patientName(row), 100) || 'Unknown patient';
	const modality = boundedText(row.source_modality, 40) || boundedText(row.modality_code, 40);
	const description = boundedText(row.source_description, 200) || boundedText(row.description, 200);
	const fields = [name, modality, description].filter(Boolean).map(escapeHtml);
	const disabled = row.disabled === true || row.disabled === 1 || row.disabled === '1';
	return `${clock.time} · <a href="${link}">${escapeHtml(code)}</a> · ${fields.join(' · ')}${disabled ? ' · <b>Disabled</b>' : ''}`;
}

function paginate(heading, entries) {
	const bodyLength = entries.reduce((length, entry) => length + entry.length + 1, 0);
	if (heading.length + bodyLength <= MESSAGE_LIMIT) return [`${heading}\n${entries.join('\n')}`];
	// The number of entries bounds the number of pages, so this reserves every part-number digit.
	const budget = MESSAGE_LIMIT - `${heading}\nPart ${entries.length}/${entries.length}\n`.length;
	const pages = [];
	let page = [], length = 0;
	for (const entry of entries) {
		const added = entry.length + (page.length ? 1 : 0);
		if (length + added > budget) {
			pages.push(page.join('\n'));
			page = [];
			length = 0;
		}
		length += entry.length + (page.length ? 1 : 0);
		page.push(entry);
	}
	if (page.length) pages.push(page.join('\n'));
	return pages.map((body, index) => `${heading}\nPart ${index + 1}/${pages.length}\n${body}`);
}

export function buildTelegramStudyIndexes(studies, chatId) {
	const grouped = new Map();
	let skipped = 0;
	for (const row of studies) {
		if (row?.telegram_message_id == null || String(row.telegram_message_id).trim() === '') continue;
		const id = messageId(row.telegram_message_id);
		const link = id === null ? null : telegramMessageLink({ chat_id: chatId, message_id: id });
		const clock = studyClock(row);
		if (!link || !clock || !clinicalDayTopicName(clock.day)) { skipped++; continue; }
		const attending = Number(row.corresponding_attending_id);
		const attendingId = Number.isSafeInteger(attending) && attending > 0 ? attending : 0;
		const key = `${clock.day}:${attendingId}`;
		if (!grouped.has(key)) grouped.set(key, { day: clock.day, attendingId, entries: [] });
		grouped.get(key).entries.push({ row, clock, link });
	}
	const groups = [...grouped.values()].sort((a, b) =>
		a.day < b.day ? -1 : a.day > b.day ? 1 : a.attendingId - b.attendingId
	).map(({ day, attendingId, entries }) => {
		entries.sort((a, b) => a.clock.date < b.clock.date ? -1 : a.clock.date > b.clock.date ? 1 :
			a.clock.seconds - b.clock.seconds || compareIds(a.row.id, b.row.id));
		const attendingName = attendingId === 0 ? 'Unassigned attending' :
			boundedText(entries[0].row.attending_fullname, 100) || `Attending ${attendingId}`;
		const heading = `<b>${escapeHtml(attendingName)}</b>\n${clinicalDayTopicName(day)}`;
		return { day, attendingId, attendingName, texts: paginate(heading, entries.map(entryText)) };
	});
	return { groups, skipped };
}
