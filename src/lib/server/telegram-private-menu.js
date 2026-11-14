import { sendBotMessage, answerBotCallback, configurePrivateBotMenu } from './telegram.js';
import { getTelegramWebsiteUrl, validateWebsiteUrl } from './telegram-settings.js';
import { handleTelegramStatistics, isTelegramStatisticsCommand } from './telegram-statistics.js';

export const privateBotCommands = [
	{ command: 'start', description: 'Welcome and main menu' },
	{ command: 'menu', description: 'Show navigation buttons' },
	{ command: 'help', description: 'Help and available commands' },
	{ command: 'status', description: 'Check your account and approval status' },
	{ command: 'register', description: 'Start or restart website registration' },
	{ command: 'cancel', description: 'Cancel your registration request' },
	{ command: 'website', description: 'Open the reporting website' },
	{ command: 'stats', description: 'Your private study statistics' }
];

const actions = new Map([
	['pacs:menu', '/menu'], ['pacs:help', '/help'], ['pacs:status', '/status'],
	['pacs:registration', '/registration'], ['pacs:website', '/website'],
	['pacs:stats', '/stats'], ['pacs:stats:today', '/stats today'],
	['pacs:stats:week', '/stats week'], ['pacs:stats:month', '/stats month']
]);
const steps = {
	name: 'Send your full name.',
	role: 'Send Resident, Attending or Typist.',
	username: 'Send a website username: 3–32 lowercase letters, numbers, dots, underscores or hyphens; start with a letter.',
	password: 'Send a unique website password (8+ characters, up to 72 UTF-8 bytes). Telegram chats are not end-to-end encrypted. Do not send your Telegram password or a login code.'
};

export function isTelegramPrivateMessage(message) {
	return message?.chat?.type === 'private' && message.from?.is_bot === false &&
		!message.sender_chat && message.edit_date == null &&
		Number.isSafeInteger(message.from.id) && message.from.id > 0 &&
		Number.isSafeInteger(message.chat.id) && message.chat.id === message.from.id &&
		Number.isSafeInteger(message.message_id) && message.message_id > 0;
}

function website(db) {
	const saved = getTelegramWebsiteUrl(db);
	if (!saved) return '';
	try { return validateWebsiteUrl(saved); }
	catch { return ''; }
}

function keyboard(url, statistics = false) {
	return { inline_keyboard: [
		...(statistics ? [[
			{ text: 'Today', callback_data: 'pacs:stats:today' },
			{ text: '7 days', callback_data: 'pacs:stats:week' },
			{ text: '30 days', callback_data: 'pacs:stats:month' }
		]] : []),
		[{ text: 'My account', callback_data: 'pacs:status' }, { text: 'My statistics', callback_data: 'pacs:stats' }],
		[{ text: 'Registration', callback_data: 'pacs:registration' }, { text: 'Help', callback_data: 'pacs:help' }],
		[url ? { text: 'Open website', url } : { text: 'Website', callback_data: 'pacs:website' },
			{ text: 'Main menu', callback_data: 'pacs:menu' }]
	] };
}

function currentAccount(db, id) {
	return db.prepare(`SELECT u.full_name, u.role FROM users u
		JOIN telegram_registrations r ON r.user_id = u.id AND r.telegram_user_id = u.telegram_user_id
		WHERE u.telegram_user_id = ? AND r.step = 'approved'
		AND u.role IN ('admin','resident','attending','typist')`).get(String(id));
}

function accountStatus(db, id, now) {
	const user = currentAccount(db, id);
	if (user) return `Account approved\n${user.full_name} · ${user.role}\nWebsite access is active. Use My statistics for your permitted study summary.`;
	const registration = db.prepare('SELECT step, updated_at FROM telegram_registrations WHERE telegram_user_id = ?').get(String(id));
	if (!registration) return 'Not registered\nSend /register to create a website account. An administrator must approve your request before you can sign in.';
	if (registration.step === 'pending') return 'Awaiting administrator approval\nYour request is submitted. You cannot sign in until it is approved. Use /status to check again; contact an administrator if you need assistance.';
	if (registration.step === 'rejected') return 'Registration rejected or expired\nContact an administrator if needed, or send /register to submit a new request.';
	if (registration.step === 'approved') return 'Account link unavailable\nContact an administrator to check the connection to your website account.';
	if (Object.hasOwn(steps, registration.step)) {
		if (registration.updated_at < now - 1800) return 'Registration expired\nRegistration drafts expire after 30 minutes of inactivity. Send /register to begin again.';
		return `Registration in progress\n${steps[registration.step]}\nSend /cancel to cancel. Opening this menu or help does not reset your progress.`;
	}
	return 'Account status unavailable. Contact an administrator.';
}

const help = [
	'Personal Taleghani PACS — Help',
	'',
	'/menu — Navigation buttons',
	'/status — Your account and approval status',
	'/register — Start or restart registration',
	'/cancel — Cancel a registration request (not an approved account)',
	'/website — Open the reporting website',
	'/stats — Your study summary for the last 7 days',
	'/stats today | 3d | week | month | year',
	'/stats YYYY-MM-DD YYYY-MM-DD — Inclusive Jalali examination dates',
	'',
	'Registration: full name → role → website username → unique website password → administrator approval. Drafts expire after 30 minutes of inactivity.',
	'Use a unique website password, never your Telegram password or login code. Password messages are deleted where Telegram permits; private bot chats are not end-to-end encrypted.',
	'Statistics follow your current permissions and contain no patient details. Manage recordings, reports and signatures on the website. Study-group voice/reply behavior is unchanged.',
	'For account approval, password resets or access problems, contact your administrator.'
].join('\n');

export async function handleTelegramPrivateMenu(db, update, {
	send = sendBotMessage,
	answer = answerBotCallback,
	configure = configurePrivateBotMenu,
	statistics = handleTelegramStatistics,
	now = Math.floor(Date.now() / 1000)
} = {}) {
	if (update?.edited_message) return false;
	let message = update?.message;
	const callback = update?.callback_query;
	if (callback) {
		if (typeof callback.id !== 'string' || !callback.id || callback.id.length > 256 || !actions.has(callback.data)) return false;
		message = { ...callback.message, from: callback.from, text: actions.get(callback.data) };
		// Callback messages were sent by the bot; authenticate the person pressing the button.
		if (!isTelegramPrivateMessage(message)) return false;
		try { await answer(callback.id); }
		catch { /* Expired callback acknowledgements must not prevent read-only menu navigation. */ }
	}
	if (!isTelegramPrivateMessage(message) || typeof message.text !== 'string') return false;
	const command = message.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
	if (!command.startsWith('/')) return false;
	if (command === '/register' || command === '/cancel') {
		if (!currentAccount(db, message.from.id)) return false;
		await send(String(message.chat.id), accountStatus(db, message.from.id, now), undefined, keyboard(website(db)));
		return true;
	}
	const url = website(db);
	if (isTelegramStatisticsCommand(message.text)) {
		await statistics(db, { message }, {
			send: (id, text) => send(id, text, undefined, keyboard(url, true))
		});
		return true;
	}
	let text;
	switch (command) {
		case '/start':
		case '/menu':
			text = `Personal Taleghani PACS\nYour reporting workspace, connected.\n\n${accountStatus(db, message.from.id, now)}\n\nChoose an option below. /help lists all commands.`;
			break;
		case '/help': text = help; break;
		case '/status': text = accountStatus(db, message.from.id, now); break;
		case '/registration':
			text = `Website registration\n\n${accountStatus(db, message.from.id, now)}\n\nSend /register to start or restart registration, or /cancel to cancel an unapproved request. Menu buttons never submit or approve an account.`;
			break;
		case '/website':
			text = url ? 'Reporting website\nUse Open website below. Sign in with your approved website username and password.'
				: 'The website link has not been configured. Ask an administrator to save the website link in User Management.';
			break;
		default: text = 'Unknown command. Use /help or choose an option below. Send /register to begin registration. Your existing registration progress is unchanged.';
	}
	await send(String(message.chat.id), text, undefined, keyboard(url));
	if (command === '/start') {
		try { await configure(message.chat.id, privateBotCommands); }
		catch { /* Inline buttons remain available if Telegram cannot configure the command menu. */ }
	}
	return true;
}
