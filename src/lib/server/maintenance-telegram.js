const MAINTENANCE_TEXT = 'Website is updating. Messages are not processed during maintenance; please resend after service resumes.';
const SEND_PERMISSIONS = [
	'can_send_messages', 'can_send_audios', 'can_send_documents', 'can_send_photos',
	'can_send_videos', 'can_send_video_notes', 'can_send_voice_notes', 'can_send_polls',
	'can_send_other_messages', 'can_add_web_page_previews', 'can_send_media_messages',
	'can_react_to_messages'
];
const PERMISSIONS = new Set([...SEND_PERMISSIONS,
	'can_edit_tag', 'can_change_info', 'can_invite_users', 'can_pin_messages', 'can_manage_topics'
]);
const INVALID_PERMISSIONS = 'TELEGRAM_MAINTENANCE_INVALID_PERMISSIONS';
const MEMORY_LIMIT = 1024;
const DUPLICATE_TTL = 10 * 60_000;

function fail(message, code) {
	const error = new Error(`Telegram maintenance: ${message}.`);
	if (code) error.code = code;
	throw error;
}

function id(value, group = false) {
	const text = String(value);
	if (!(group ? /^-[1-9]\d*$/ : /^[1-9]\d*$/).test(text) || !Number.isSafeInteger(Number(text)))
		fail('invalid chat or user ID');
	return text;
}

function config(env) {
	const token = env.TELEGRAM_BOT_TOKEN;
	const chatId = env.TELEGRAM_CHAT_ID;
	if (!token && !chatId) return null;
	if (typeof token !== 'string' || !/^[A-Za-z0-9:_-]+$/.test(token) || !chatId)
		fail('both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required');
	return { token, chatId: id(chatId, true) };
}

function permissions(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value)))
		fail('invalid permissions', INVALID_PERMISSIONS);
	const entries = Object.entries(value);
	if (!entries.length || entries.some(([key, flag]) => !PERMISSIONS.has(key) || typeof flag !== 'boolean'))
		fail('invalid permissions', INVALID_PERMISSIONS);
	return Object.fromEntries(entries);
}

function validateSnapshot(snapshot) {
	if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
		Object.keys(snapshot).some((key) => !['chatId', 'permissions'].includes(key)))
		fail('invalid snapshot');
	return { chatId: id(snapshot.chatId, true), permissions: permissions(snapshot.permissions) };
}

// request is fetch-compatible; no API errors or transport details escape this boundary.
async function call(settings, request, method, body) {
	let result;
	try {
		const response = await request(`https://api.telegram.org/bot${settings.token}/${method}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15_000)
		});
		if (response.ok === false) throw new Error();
		result = await response.json();
		if (result?.ok !== true || result.result === undefined) throw new Error();
	} catch {
		fail(`${method} request failed`);
	}
	return result.result;
}

export async function snapshotTelegramMaintenance({ env = process.env, request = globalThis.fetch } = {}) {
	const settings = config(env);
	if (!settings) return null;
	const chat = await call(settings, request, 'getChat', { chat_id: settings.chatId });
	if (!chat || !['group', 'supergroup'].includes(chat.type) || id(chat.id, true) !== settings.chatId)
		fail('configured chat must be a group or supergroup');
	const original = permissions(chat.permissions);
	const bot = await call(settings, request, 'getMe', {});
	if (!bot || bot.is_bot !== true) fail('invalid bot identity');
	const botId = id(bot.id);
	const member = await call(settings, request, 'getChatMember', { chat_id: settings.chatId, user_id: botId });
	if (!member || (member.status !== 'creator' &&
		!(member.status === 'administrator' && member.can_restrict_members === true)))
		fail('bot administrator rights with can_restrict_members are required');
	return { chatId: settings.chatId, permissions: original };
}

async function setPermissions(snapshot, options, locked) {
	if (snapshot === null) return false;
	const saved = validateSnapshot(snapshot);
	const settings = config(options.env ?? process.env);
	if (!settings) fail('Telegram configuration is required');
	const next = { ...saved.permissions };
	if (locked) for (const key of SEND_PERMISSIONS) next[key] = false;
	const result = await call(settings, options.request ?? globalThis.fetch, 'setChatPermissions', {
		chat_id: saved.chatId, permissions: next, use_independent_chat_permissions: true
	});
	if (result !== true) fail('setChatPermissions request failed');
	return true;
}

export async function lockTelegramMaintenance(snapshot, options = {}) {
	return setPermissions(snapshot, options, true);
}

export async function unlockTelegramMaintenance(snapshot, options = {}) {
	return setPermissions(snapshot, options, false);
}

export async function notifyTelegramMaintenance(snapshot, { enabled, env = process.env, request = globalThis.fetch } = {}) {
	if (snapshot === null) return false;
	const saved = validateSnapshot(snapshot);
	if (typeof enabled !== 'boolean') fail('enabled must be a boolean');
	const settings = config(env);
	if (!settings) fail('Telegram configuration is required');
	await call(settings, request, 'sendMessage', {
		chat_id: saved.chatId,
		text: enabled
			? 'Website maintenance has started. This group is locked for ordinary members until maintenance ends.'
			: 'Website maintenance has ended. Previous group permissions have been restored; please resend messages not processed during maintenance.'
	});
	return true;
}

function remember(map, key, value) {
	map.delete(key);
	map.set(key, value);
	while (map.size > MEMORY_LIMIT) map.delete(map.keys().next().value);
}

export function createMaintenanceTelegramResponder({ env = process.env, request = globalThis.fetch, now = Date.now } = {}) {
	const seen = new Map();
	const chats = new Map();
	const inFlight = new Set();
	return async function respond(update, snapshot) {
		const settings = config(env);
		if (!settings) return false;
		const saved = snapshot == null ? null : validateSnapshot(snapshot);
		const callback = update?.callback_query;
		const message = callback ? callback.message : update?.message;
		const sender = callback ? callback.from : message?.from;
		if (!message?.chat || !sender || sender.is_bot ||
			(!callback && (message.edit_date || update.edited_message || update.edited_channel_post))) return false;
		const privateChat = message.chat.type === 'private';
		if (!privateChat && !['group', 'supergroup'].includes(message.chat.type)) return false;
		let chatId;
		try { chatId = id(message.chat.id, !privateChat); } catch { return false; }
		if (!privateChat && chatId !== settings.chatId && chatId !== saved?.chatId) return false;
		if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) return false;
		if (callback && (typeof callback.id !== 'string' || !callback.id || callback.id.length > 256)) return false;
		const time = now();
		if (!Number.isFinite(time)) fail('invalid clock');
		for (const [key, timestamp] of seen) if (time - timestamp >= DUPLICATE_TTL) seen.delete(key);
		for (const [key, timestamp] of chats) if (time - timestamp >= 60_000) chats.delete(key);
		if (seen.has(update.update_id) || inFlight.has(chatId)) return true;
		if (chats.has(chatId)) {
			remember(seen, update.update_id, time);
			return true;
		}
		// Bound concurrent work as well as retained deduplication/rate-limit state.
		if (inFlight.size >= MEMORY_LIMIT) return true;
		inFlight.add(chatId);
		try {
			await call(settings, request, callback ? 'answerCallbackQuery' : 'sendMessage', callback
				? { callback_query_id: callback.id, text: MAINTENANCE_TEXT }
				: { chat_id: chatId, text: MAINTENANCE_TEXT });
			remember(seen, update.update_id, time);
			remember(chats, chatId, time);
			return true;
		} finally {
			inFlight.delete(chatId);
		}
	};
}
