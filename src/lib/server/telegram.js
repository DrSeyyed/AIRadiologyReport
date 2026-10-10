// src/lib/server/telegram.js
// ESM module for SvelteKit/Node 18+ (global fetch available)

import fs from 'node:fs';
import path from 'node:path';

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
		`Study #${esc(study.id)} — source modality: ${esc(study.source_modality || study.modality_code || 'Unspecified')}`
	);
	if (study.source_description || study.description)
		lines.push(
			`Source description (reference only): ${esc((study.source_description || study.description).slice(0, 500))}`
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

	lines.push('Resident: assigned separately for each recording');
	lines.push(`Attending: ${esc(study.attending_fullname ?? '-')}`);

	const recordings = study.recordings || [];
	lines.push(
		`Recordings: ${recordings.length} • Reports: ${recordings.filter((r) => r.text_report_path).length}`
	);
	lines.push(
		`Signed: Resident ${recordings.filter((r) => r.resident_checked).length} • Attending ${recordings.filter((r) => r.attending_checked).length}`
	);
	for (const recording of recordings.slice(0, 5)) {
		const label =
			recording.modality_id && recording.exam_type_id
				? `${recording.modality_code || ''} ${recording.exam_type_code || ''} ${recording.exam_details || ''}`
						.trim()
						.slice(0, 150)
				: 'Awaiting examination selection on site';
		lines.push(
			`Recording #${esc(recording.id)}: ${esc(label)} — ${recording.text_report_path ? 'report ready' : 'no report'} — Resident: ${esc(recording.resident_fullname || 'select on site')}`
		);
	}
	if (recordings.length > 5) lines.push(`… ${recordings.length - 5} more recordings on site`);
	lines.push(
		'<i>Register privately with this bot using /register and wait for administrator approval. Reply to this study message with voice/audio to add a recording. Resident replies stay assigned to that resident; attending replies require a resident selected on the site. The study attending stays unchanged. Save reviewers and examination details on the site, then Transcribe &amp; Generate.</i>'
	);

	if (study.dicom_url) lines.push(`<a href="${esc(study.dicom_url)}">Open DICOM</a>`);

	return lines.join('\n');
}

export function buildFinalReportMessage(study, recording, reportText) {
	const label =
		`${recording.exam_type_code || ''} ${recording.exam_details || ''}, ${recording.modality_code || ''}`.slice(
			0,
			100
		);
	const heading = [
		'<b>Final report signed</b>',
		`Study #${esc(study.id)} — Recording #${esc(recording.id)}`,
		esc(label),
		`Patient: <b>${esc(`${study.patient_firstname || ''} ${study.patient_lastname || ''}`.trim().slice(0, 120))}</b> (code ${esc((study.patient_code || '').slice(0, 64))})`,
		`Assigned resident: ${esc((recording.resident_fullname || '-').slice(0, 60))}`,
		`Study attending: ${esc((study.attending_fullname || '-').slice(0, 60))}`,
		`Resident signature by: ${esc((recording.resident_signer_fullname || 'Unknown (legacy)').slice(0, 60))}`,
		`Attending signature by: ${esc((recording.attending_signer_fullname || 'Unknown (legacy)').slice(0, 60))}`,
		`Date/Time: ${esc(study.exam_date_jalali)} ${esc(study.exam_time)}`
	].join('\n');
	const footer = '\n<i>Full report available on the site.</i>';
	const budget = 4000 - heading.length - footer.length - 12;
	let escaped = '';
	for (const character of reportText) {
		const part = esc(character);
		if (escaped.length + part.length > budget) break;
		escaped += part;
	}
	return `${heading}\n<pre>${escaped}</pre>${footer}`;
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
	await tgRequest('editMessageText', {
		chat_id,
		message_id,
		text,
		parse_mode: 'HTML',
		disable_web_page_preview: true
	});
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
