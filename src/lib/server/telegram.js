// src/lib/server/telegram.js
// ESM module for SvelteKit/Node 18+ (global fetch available)

import fs from 'node:fs';
import path from 'node:path';
import { studyLabel } from '../study-label.js';
import { recordingExaminations } from '../recording-examinations.js';

function getToken() {
	const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
	if (!TOKEN) {
		throw new Error('Missing TELEGRAM_BOT_TOKEN in environment');
	}
	return TOKEN;
}

function getChatID() {
	const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
	if (!DEFAULT_CHAT_ID) {
		throw new Error('Missing TELEGRAM_CHAT_ID in environment');
	}
	return DEFAULT_CHAT_ID;
}

// ---------- utils ----------

function assert(ok, msg) {
	if (!ok) throw new Error(msg);
}

async function tgRequest(endpoint, payload) {
	const API_BASE = `https://api.telegram.org/bot${getToken()}`;
	const res = await fetch(`${API_BASE}/${endpoint}`, {
		method: 'POST',
		signal: AbortSignal.timeout(15000),
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload)
	});
	let data;
	try {
		data = await res.json();
	} catch {
		throw new Error(`Telegram ${endpoint} HTTP ${res.status} (non-JSON)`);
	}
	if (!data.ok) {
		const description = data.description || `HTTP ${res.status}`;
		throw Object.assign(new Error(`Telegram ${endpoint} failed: ${description}`), {
			telegram_error_code: data.error_code || res.status,
			retry_after: data.parameters?.retry_after
		});
	}
	return data.result;
}

export function esc(s) {
	const t = (s ?? '').toString();
	// Minimal HTML escaping for parse_mode: 'HTML'
	return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- study message formatting ----------

export function buildStudyMessage(study) {
	const lines = [];
	lines.push(`<b>🩺 ${esc(studyLabel(study))}</b>`);
	lines.push(`Modality: ${esc(study.source_modality || study.modality_code || '-')}`);
	if (study.source_description || study.description)
		lines.push(
			`Description: ${esc((study.source_description || study.description).slice(0, 500))}`
		);

	lines.push(
		`Patient: <b>${esc(study.patient_firstname ?? '-')} ${esc(study.patient_lastname ?? '-')}</b> ` +
			`<i>(code ${esc(study.patient_code ?? '-')})</i>`
	);
	const ageGender = [
		study.patient_age != null
			? `Age: ${esc(study.patient_age)} ${esc({ Y: 'years', M: 'months', W: 'weeks', D: 'days' }[study.patient_age_unit || 'Y'])}`
			: null,
		study.patient_gender ? `Gender: ${esc(study.patient_gender)}` : null
	]
		.filter(Boolean)
		.join(' • ');
	if (ageGender) lines.push(ageGender);

	lines.push(`Date/Time: ${esc(study.exam_date_jalali ?? '-')} ${esc(study.exam_time ?? '')}`);

	if (study.description && study.description !== study.source_description)
		lines.push(`Note: ${esc(study.description.slice(0, 300))}`);

	lines.push(`Needs attention: ${study.needs_attention ? '⚠️ Yes' : 'No'}`);
	if (study.attention_note)
		lines.push(`${study.needs_attention ? 'Attention note' : 'Previous attention note (reference)'}: ${esc(study.attention_note.slice(0, 300))}`);

	lines.push(`Attending: ${esc(study.attending_fullname ?? '-')}`);

	const recordings = study.recordings || [];
	lines.push(
		`Recordings: ${recordings.length} • Reports: ${recordings.filter((r) => r.text_report_path).length}`
	);
	lines.push(
		`Signed: Resident ${recordings.filter((r) => r.resident_checked).length} • Attending ${recordings.filter((r) => r.attending_checked).length} • Typist (printed) ${recordings.filter((r) => r.typist_checked).length}`
	);
	for (const recording of recordings.slice(0, 5)) {
		const label =
			recording.modality_id && recording.exam_type_id
				? `${recording.modality_code || ''} ${recordingExaminations(recording).map((exam) => exam.code || exam.name).join(' + ')} ${recording.exam_details || ''}`
						.trim()
						.slice(0, 150)
				: 'Examination pending';
		lines.push(
			`Recording #${esc(recording.id)}: ${esc(label)}${recording.audio_parts?.length > 1 ? ` (${recording.audio_parts.length} voice parts)` : ''} — ${recording.text_report_path ? 'report ready' : 'no report'} — Resident: ${esc(recording.resident_fullname || '-')}`
		);
		lines.push(
			`Resident ${recording.resident_checked ? '✅' : '⬜'} • Attending ${recording.attending_checked ? '✅' : '⬜'} • Typist / printed ${recording.typist_checked ? `✅ (${esc((recording.typist_signer_fullname || 'Unknown signer').slice(0, 60))})` : '⬜'}`
		);
	}
	if (recordings.length > 5) lines.push(`… ${recordings.length - 5} more recordings on site`);

	if (study.dicom_url) lines.push(`<a href="${esc(study.dicom_url)}">Open DICOM</a>`);

	const text = lines.join('\n');
	return study.disabled
		? `<b>❌ DISABLED — replies are not processed</b>\n<s>${text}</s>`
		: text;
}

// ---------- message send/edit/delete ----------

export async function sendBotMessage(chat_id, text, reply_to_message_id, reply_markup) {
	return tgRequest('sendMessage', {
		chat_id,
		text,
		...(reply_to_message_id ? { reply_parameters: { message_id: reply_to_message_id } } : {}),
		...(reply_markup ? { reply_markup } : {})
	});
}

export async function getStudyGroupInviteLink() {
	const chat_id = getChatID();
	const chat = await tgRequest('getChat', { chat_id });
	assert(['group', 'supergroup', 'channel'].includes(chat.type), 'Study chat must be a group or channel');
	if (chat.username && /^[A-Za-z0-9_]+$/.test(chat.username))
		return `https://t.me/${chat.username}`;
	let link = chat.invite_link;
	if (!link) {
		const created = await tgRequest('createChatInviteLink', { chat_id, name: 'Website invitations' });
		link = created.invite_link;
	}
	const url = new URL(link);
	assert(url.protocol === 'https:' && ['t.me', 'telegram.me'].includes(url.hostname) && !url.username && !url.password, 'Invalid Telegram invite link');
	return url.href;
}

export async function sendStudyMessage(study, chat_id) {
	chat_id = chat_id ?? getChatID();
	assert(chat_id, 'chat_id is required (set TELEGRAM_CHAT_ID or pass explicitly)');
	const text = buildStudyMessage(study);
	const res = await tgRequest('sendMessage', {
		chat_id,
		text,
		parse_mode: 'HTML',
		disable_web_page_preview: true
	});
	// returns { message_id, chat:{id,...}, ... }
	return { chat_id, message_id: res.message_id };
}

export async function editStudyMessage(study, chat_id) {
	chat_id = chat_id ?? getChatID();
	let message_id = study.telegram_message_id;
	assert(chat_id, 'chat_id is required');
	assert(message_id, 'message_id is required');
	const text = buildStudyMessage(study);
	try {
		await tgRequest('editMessageText', {
			chat_id,
			message_id,
			text,
			parse_mode: 'HTML',
			disable_web_page_preview: true
		});
	} catch (error) {
		if (error.telegram_error_code !== 400 || !/message is not modified/i.test(error.message)) throw error;
	}
	return true;
}

export async function syncStudyMessage(study) {
	if (!study?.telegram_message_id) return false;
	try {
		await editStudyMessage(study);
		return true;
	} catch {
		return false;
	}
}

export async function deleteMessage(message_id, chat_id) {
	chat_id = chat_id ?? getChatID();
	assert(chat_id, 'chat_id is required');
	assert(message_id, 'message_id is required');
	try {
		await tgRequest('deleteMessage', { chat_id, message_id });
	} catch (error) {
		if (error.telegram_error_code !== 400 || !/message to delete not found/i.test(error.message)) throw error;
	}
	return true;
}

export async function sendReply(chat_id, text, reply_to_message_id) {
	assert(chat_id, 'chat_id is required');
	assert(reply_to_message_id, 'reply_to_message_id is required');
	const res = await tgRequest('sendMessage', {
		chat_id,
		text,
		parse_mode: 'HTML',
		disable_web_page_preview: true,
		reply_to_message_id,
		allow_sending_without_reply: true
	});
	return { chat_id, message_id: res.message_id };
}

// ---------- files (voice, etc.) ----------

export async function getFile(file_id) {
	const FILE_BASE = `https://api.telegram.org/file/bot${getToken()}`;
	assert(file_id, 'file_id is required');
	const res = await tgRequest('getFile', { file_id });
	// res: { file_id, file_unique_id, file_size, file_path }
	const file_path = res.file_path;
	const download_url = `${FILE_BASE}/${file_path}`;
	return { file_path, download_url };
}

/**
 * Download a Telegram file_id to destPath.
 * Returns absolute path.
 */
export async function downloadFile(file_id, destPath) {
	const { download_url } = await getFile(file_id);
	const r = await fetch(download_url);
	if (!r.ok) throw new Error(`Download failed: ${r.status} ${r.statusText}`);
	const buf = Buffer.from(await r.arrayBuffer());

	const abs = path.resolve(destPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, buf);
	return abs;
}

// ---------- webhook utilities ----------

export async function setWebhook(url) {
	assert(url, 'url is required');
	const secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
	assert(
		typeof secret_token === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(secret_token),
		'Configure a valid TELEGRAM_WEBHOOK_SECRET before setting the webhook'
	);
	const res = await tgRequest('setWebhook', { url, secret_token, allowed_updates: ['message'] });
	return !!res;
}

export async function deleteWebhook(drop_pending_updates = false) {
	const res = await tgRequest('deleteWebhook', { drop_pending_updates });
	return !!res;
}

// ---------- convenience: tiny safe HTML note ----------

export function smallNoteHTML(text) {
	return `<i>${esc(text)}</i>`;
}
