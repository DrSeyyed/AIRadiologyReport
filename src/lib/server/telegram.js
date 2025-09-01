// src/lib/server/telegram.js
// ESM module for SvelteKit/Node 18+ (global fetch available)

import fs from 'node:fs';
import path from 'node:path';


function getToken(){
	const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
	if (!TOKEN) {
		throw new Error('Missing TELEGRAM_BOT_TOKEN in environment');
	}
	return TOKEN
}

function getChatID(){
	const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
	if (!DEFAULT_CHAT_ID) {
		throw new Error('Missing TELEGRAM_CHAT_ID in environment');
	}
	return DEFAULT_CHAT_ID
}





// ---------- utils ----------

function assert(ok, msg) {
	if (!ok) throw new Error(msg);
}

async function tgRequest(endpoint, payload) {
	const API_BASE = `https://api.telegram.org/bot${getToken()}`;
	const res = await fetch(`${API_BASE}/${endpoint}`, {
		method: 'POST',
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
		throw new Error(`Telegram ${endpoint} failed: ${description}`);
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
	lines.push(`<b>🩺 Study</b>`);
	lines.push(
		`Study #${esc(study.id)} — ${esc(study.exam_type_code ?? '')} (${esc(study.modality_code ?? '')})`
	);
	if (study.exam_details) lines.push(`Details: ${esc(study.exam_details)}`);

	lines.push(
		`Patient: <b>${esc(study.patient_firstname ?? '-')} ${esc(study.patient_lastname ?? '-')}</b> ` +
			`<i>(code ${esc(study.patient_code ?? '-')})</i>`
	);
	const ageGender = [
		study.patient_age != null ? `Age: ${esc(study.patient_age)}` : null,
		study.patient_gender ? `Gender: ${esc(study.patient_gender)}` : null
	]
		.filter(Boolean)
		.join(' • ');
	if (ageGender) lines.push(ageGender);

	lines.push(`Date/Time: ${esc(study.exam_date_jalali ?? '-')} ${esc(study.exam_time ?? '')}`);

	if (study.description) lines.push(`Note: ${esc(study.description)}`);

	lines.push(`Resident: ${esc(study.resident_fullname ?? '-')}`);
	lines.push(`Attending: ${esc(study.attending_fullname ?? '-')}`);

	lines.push(`Audio : ${study.audio_report_path ? '✔' : '✖'}`);
	lines.push(`Report: ${study.text_report_path ? '✔' : '✖'}`);

	lines.push(
		`Status: Resident <b>${study.resident_checked ? '✔' : '✖'}</b> • ` +
			`Attending <b>${study.attending_checked ? '✔' : '✖'}</b>`
	);

	if (study.dicom_url) lines.push(`<a href="${esc(study.dicom_url)}">Open DICOM</a>`);

	return lines.join('\n');
}

// ---------- message send/edit/delete ----------

export async function sendStudyMessage(study, chat_id) {
	chat_id = chat_id ?? getChatID()
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
	chat_id = chat_id ?? getChatID()
	let message_id = study.telegram_message_id;
	assert(chat_id, 'chat_id is required');
	assert(message_id, 'message_id is required');
	const text = buildStudyMessage(study);
	await tgRequest('editMessageText', {
		chat_id,
		message_id,
		text,
		parse_mode: 'HTML',
		disable_web_page_preview: true
	});
	return true;
}

export async function deleteMessage(message_id, chat_id) {
	chat_id = chat_id ?? getChatID()
	assert(chat_id, 'chat_id is required');
	assert(message_id, 'message_id is required');
	await tgRequest('deleteMessage', { chat_id, message_id });
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
	console.log(download_url)
	const r = await fetch(download_url);
	if (!r.ok) throw new Error(`Download failed: ${r.status} ${r.statusText}`);
	const buf = Buffer.from(await r.arrayBuffer());

	const abs = path.resolve(destPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, buf);
	console.log(abs)
	return abs;
}

// ---------- webhook utilities ----------

export async function setWebhook(url) {
	assert(url, 'url is required');
	const res = await tgRequest('setWebhook', { url });
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
