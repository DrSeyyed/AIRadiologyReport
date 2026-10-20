export function trackStudyReply(db, message) {
	if (!(message.voice || message.audio) || !message.reply_to_message?.message_id) return null;
	const chatId = String(message.chat.id);
	const parentId = message.reply_to_message.message_id;
	const study = db.prepare('SELECT id FROM studies WHERE telegram_message_id IN (?, ?)')
		.get(String(parentId), `${parentId}.0`);
	const parent = study ? null : db.prepare('SELECT study_id FROM study_telegram_voices WHERE chat_id = ? AND message_id = ? AND deleted = 0')
		.get(chatId, parentId);
	const studyId = study?.id || parent?.study_id;
	if (!studyId) return null;
	const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ')
		|| message.sender_chat?.title || message.from?.username || '';
	db.prepare(`INSERT INTO study_telegram_voices(study_id, chat_id, message_id, parent_message_id, sender_name, message_kind, chat_username)
		VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, message_id) DO UPDATE SET
		sender_name = excluded.sender_name, chat_username = excluded.chat_username`)
		.run(studyId, chatId, message.message_id, study ? null : parentId, senderName.slice(0, 80), message.voice ? 'voice' : 'audio', message.chat.username || '');
	return studyId;
}

export function telegramMessageLink(reply) {
	if (!Number.isSafeInteger(reply.message_id) || reply.message_id <= 0) return null;
	if (/^[A-Za-z0-9_]+$/.test(reply.chat_username || ''))
		return `https://t.me/${reply.chat_username}/${reply.message_id}`;
	const match = String(reply.chat_id).match(/^-100([1-9]\d*)$/);
	return match ? `https://t.me/c/${match[1]}/${reply.message_id}` : null;
}

function escapeHtml(value) {
	return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatStudyReplyLinks(replies = [], budget = 4096) {
	const rows = replies.filter((reply) => !reply.deleted && telegramMessageLink(reply))
		.sort((a, b) => a.message_id - b.message_id);
	if (!rows.length) return '';
	const key = (reply) => `${reply.chat_id}:${reply.message_id}`;
	const byId = new Map(rows.map((reply) => [key(reply), reply]));
	const roots = new Map();
	for (const reply of rows) {
		let root = reply;
		const visited = new Set([key(root)]);
		while (root.parent_message_id) {
			const parent = byId.get(`${root.chat_id}:${root.parent_message_id}`);
			if (!parent || visited.has(key(parent))) break;
			visited.add(key(parent));
			root = parent;
		}
		roots.set(key(reply), key(root));
	}
	const labels = new Map(rows.map((reply, index) => [key(reply),
		`<a href="${telegramMessageLink(reply)}">${reply.message_kind === 'audio' ? 'Audio' : 'Voice'} ${index + 1}${reply.sender_name ? ` (${escapeHtml(reply.sender_name.slice(0, 40))})` : ''}</a>`]));
	function render(selected) {
		const groups = new Map();
		for (const reply of [...selected].sort((a, b) => a.message_id - b.message_id)) {
			const root = roots.get(key(reply));
			if (!groups.has(root)) groups.set(root, []);
			groups.get(root).push(labels.get(key(reply)));
		}
		const lines = ['<b>Voice/audio replies</b>', ...[...groups.values()].map((links) => links.join(' → '))];
		if (selected.length < rows.length) lines.push(`… ${rows.length - selected.length} more replies`);
		return lines.join('\n');
	}
	const selected = [];
	let text = '';
	for (const reply of [...rows].reverse()) {
		const candidate = render([...selected, reply]);
		if (candidate.length > budget) break;
		selected.push(reply);
		text = candidate;
	}
	return text || (render([]).length <= budget ? render([]) : '');
}
