import { getStudyStatistics } from './study-statistics.js';
import { statisticsMetrics, statisticsPresets } from '../study-statistics-options.js';
import { sendBotMessage } from './telegram.js';

const usage = [
	'Study statistics — /stats (last 7 days)',
	'/stats today | 3d | week | month | year',
	'/stats YYYY-MM-DD YYYY-MM-DD (inclusive Jalali dates)',
	'/stats help',
	'Dates use Asia/Tehran and the study examination date, not recent activity.',
	'Private summaries only: administrators see all studies; residents see studies assigned to them or their recordings; attendings see assigned studies; typists see studies with a recording they currently personally signed.',
	'Current status is counted. Apart from active/disabled, workflow counts include active studies only and may overlap. No patient details are included.'
].join('\n');

export function isTelegramStatisticsCommand(text) {
	return (
		typeof text === 'string' &&
		/^\/(?:stats|statistics)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text.trim())
	);
}

function parameters(text) {
	const args = text.trim().split(/\s+/).slice(1);
	if (args.length === 1 && args[0].toLowerCase() === 'help') return null;
	const presets = {
		today: 'today',
		'3d': '3-days',
		week: '7-days',
		month: '30-days',
		year: '365-days'
	};
	if (!args.length) return new URLSearchParams({ date_range: '7-days' });
	if (args.length === 1 && Object.hasOwn(presets, args[0].toLowerCase()))
		return new URLSearchParams({ date_range: presets[args[0].toLowerCase()] });
	if (args.length === 2 && args.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))
		return new URLSearchParams({ date_range: 'custom', date_from: args[0], date_to: args[1] });
	throw Object.assign(new Error('Invalid statistics command'), { status: 400 });
}

function summary(result) {
	const scopes = {
		all: 'All studies',
		assigned: 'Your assigned studies',
		signed: 'Studies with your current personal signature'
	};
	const preset =
		statisticsPresets.find(({ value }) => value === result.range.preset)?.label || 'Custom';
	return [
		'Study statistics',
		`Scope: ${scopes[result.scope]}`,
		`${preset}: ${result.range.date_from} – ${result.range.date_to} (Jalali, Asia/Tehran; inclusive)`,
		...statisticsMetrics.map(({ key, label }) => `${label}: ${result.totals[key]}`),
		'Current status by examination date. Workflow counts are active-only and may overlap. No patient details.'
	].join('\n');
}

export async function handleTelegramStatistics(
	db,
	update,
	{ send = sendBotMessage, service = getStudyStatistics, now = new Date() } = {}
) {
	const message = update?.message;
	if (
		update?.edited_message ||
		!message ||
		message.edit_date != null ||
		message.chat?.type !== 'private' ||
		message.from?.is_bot !== false ||
		message.sender_chat ||
		!Number.isSafeInteger(message.from?.id) ||
		message.from.id <= 0 ||
		!Number.isSafeInteger(message.chat.id) ||
		message.chat.id !== message.from.id ||
		!Number.isSafeInteger(message.message_id) ||
		message.message_id <= 0 ||
		!isTelegramStatisticsCommand(message.text)
	)
		return false;

	let body;
	try {
		// This lookup includes current administrators without widening voice-handling permissions.
		const user = db
			.prepare(
				`SELECT u.id, u.role FROM users u
			JOIN telegram_registrations r ON r.user_id = u.id AND r.telegram_user_id = u.telegram_user_id
			WHERE u.telegram_user_id = ? AND r.step = 'approved'
			AND u.role IN ('admin', 'resident', 'attending', 'typist')`
			)
			.get(String(message.from.id));
		if (!user) {
			body =
				'Statistics require an approved Telegram registration linked to your current website account. Contact an administrator if access is unavailable.';
		} else {
			const params = parameters(message.text);
			body = params === null ? usage : summary(service(db, user, params, { now }));
		}
	} catch (error) {
		if (error.status === 400) body = `Invalid statistics date range or command.\n${usage}`;
		else if (error.status === 401 || error.status === 403)
			body = 'Statistics access is unavailable. Contact an administrator.';
		else body = 'Statistics are temporarily unavailable. Please try again later.';
	}
	await send(String(message.chat.id), body);
	return true;
}
