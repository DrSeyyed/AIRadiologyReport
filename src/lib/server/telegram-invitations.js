import { getStudyGroupInviteLink, sendBotMessage } from './telegram.js';
import { getTelegramWebsiteUrl, validateWebsiteUrl } from './telegram-settings.js';
export { validateWebsiteUrl } from './telegram-settings.js';

export function validateInvitationUserIds(userIds) {
	if (!Array.isArray(userIds) || !userIds.length || userIds.some((id) => !Number.isSafeInteger(id) || id <= 0))
		throw Object.assign(new Error('Select valid users.'), { status: 400 });
	return [...new Set(userIds)];
}

const groupQueue = { table: 'telegram_group_invitations', linkColumn: 'invite_link', label: 'Study group', button: 'Join study group' };
const websiteQueue = { table: 'telegram_website_links', linkColumn: 'website_url', label: 'Radiology reporting website', button: 'Open website' };

export function queueGroupInvitations(db, userIds, getLink = getStudyGroupInviteLink) {
	return queueLinks(db, userIds, getLink, groupQueue);
}

export function queueWebsiteLinks(db, userIds, websiteUrl = getTelegramWebsiteUrl(db)) {
	const link = validateWebsiteUrl(websiteUrl);
	return queueLinks(db, userIds, async () => link, websiteQueue);
}

export function queueApprovalLinks(db, userId, telegramId) {
	const websiteUrl = getTelegramWebsiteUrl(db);
	db.prepare(`INSERT INTO telegram_group_invitations(user_id, telegram_user_id, invite_link)
		VALUES (?, ?, '')`).run(userId, telegramId);
	if (websiteUrl) db.prepare(`INSERT INTO telegram_website_links(user_id, telegram_user_id, website_url)
		VALUES (?, ?, ?)`).run(userId, telegramId, websiteUrl);
	return websiteUrl ? null : 'Website link was not queued: configure the saved website link in User Management.';
}

async function queueLinks(db, userIds, getLink, { table, linkColumn }) {
	const ids = validateInvitationUserIds(userIds);
	const getUser = db.prepare('SELECT telegram_user_id FROM users WHERE id = ?');
	const getJob = db.prepare(`SELECT status FROM ${table} WHERE user_id = ?`);
	const classify = () => {
		const candidates = [], skipped = [];
		let already_queued = 0;
		for (const id of ids) {
			const user = getUser.get(id);
			if (!user || !/^[1-9]\d*$/.test(user.telegram_user_id ?? '')) {
				skipped.push({ id, reason: user ? 'No Telegram account.' : 'User unavailable.' });
			} else if (getJob.get(id)?.status === 'pending') {
				already_queued++;
			} else {
				candidates.push({ id, telegram_user_id: user.telegram_user_id });
			}
		}
		return { candidates, skipped, already_queued };
	};
	const initial = classify();
	if (!initial.candidates.length)
		return { queued: 0, already_queued: initial.already_queued, skipped: initial.skipped };
	const link = await getLink();
	const enqueue = db.prepare(`
		INSERT INTO ${table}(user_id, telegram_user_id, ${linkColumn}) VALUES(?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET telegram_user_id = excluded.telegram_user_id,
		${linkColumn} = excluded.${linkColumn}, status = 'pending', attempts = 0,
		retry_at = 0, lease_until = 0, last_error = NULL, sent_at = NULL
	`);
	return db.transaction(() => {
		const current = classify();
		for (const user of current.candidates) enqueue.run(user.id, user.telegram_user_id, link);
		return { queued: current.candidates.length, already_queued: current.already_queued, skipped: current.skipped };
	})();
}

export function processGroupInvitation(db, send = sendBotMessage, now = Math.floor(Date.now() / 1000), getLink = getStudyGroupInviteLink) {
	return processLink(db, send, now, groupQueue, getLink);
}

export function processWebsiteLink(db, send = sendBotMessage, now = Math.floor(Date.now() / 1000)) {
	return processLink(db, send, now, websiteQueue);
}

async function processLink(db, send, now, { table, linkColumn, label, button }, getLink) {
	const lease = now + 60;
	const job = db.transaction(() => {
		const item = db.prepare(`
			SELECT * FROM ${table}
			WHERE status = 'pending' AND retry_at <= ? AND lease_until <= ?
			ORDER BY retry_at, user_id LIMIT 1
		`).get(now, now);
		if (!item) return null;
		db.prepare(`UPDATE ${table} SET lease_until = ? WHERE user_id = ?`).run(lease, item.user_id);
		return item;
	})();
	if (!job) return false;
	const finish = db.prepare(`
		UPDATE ${table} SET status = ?, lease_until = 0, last_error = ?, sent_at = ?
		WHERE user_id = ? AND status = 'pending' AND lease_until = ?
	`);
	const user = db.prepare('SELECT telegram_user_id FROM users WHERE id = ?').get(job.user_id);
	if (!user || user.telegram_user_id !== job.telegram_user_id) {
		finish.run('failed', 'Telegram account unavailable.', null, job.user_id, lease);
		return true;
	}
	try {
		if (!job[linkColumn] && getLink) {
			job[linkColumn] = await getLink();
			const updated = db.prepare(`UPDATE ${table} SET ${linkColumn} = ?
				WHERE user_id = ? AND status = 'pending' AND lease_until = ?`)
				.run(job[linkColumn], job.user_id, lease);
			if (!updated.changes) return true;
			const recipient = db.prepare('SELECT telegram_user_id FROM users WHERE id = ?').get(job.user_id);
			if (!recipient || recipient.telegram_user_id !== job.telegram_user_id) {
				finish.run('failed', 'Telegram account unavailable.', null, job.user_id, lease);
				return true;
			}
		}
		await send(job.telegram_user_id, `${label}: ${job[linkColumn]}`, undefined, {
			inline_keyboard: [[{ text: button, url: job[linkColumn] }]]
		});
		finish.run('sent', null, new Date(now * 1000).toISOString(), job.user_id, lease);
	} catch (error) {
		const attempts = job.attempts + 1;
		const permanent = [400, 401, 403].includes(error.telegram_error_code);
		const limited = error.telegram_error_code === 429;
		const retryAfter = Number(error.retry_after);
		const delay = limited && Number.isSafeInteger(retryAfter) && retryAfter > 0
			? Math.min(86400, retryAfter) : Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7));
		db.transaction(() => {
			db.prepare(`
				UPDATE ${table} SET status = ?, attempts = ?, retry_at = ?,
				lease_until = 0, last_error = 'Telegram delivery failed.'
				WHERE user_id = ? AND status = 'pending' AND lease_until = ?
			`).run(permanent || (!limited && attempts >= 5) ? 'failed' : 'pending', attempts, now + delay, job.user_id, lease);
			if (limited) for (const queue of [groupQueue, websiteQueue]) db.prepare(`
				UPDATE ${queue.table} SET retry_at = MAX(retry_at, ?) WHERE status = 'pending'
			`).run(now + delay);
		})();
	}
	return true;
}

let worker;
export function startGroupInvitationWorker(getDb) {
	if (worker || !process.env.TELEGRAM_BOT_TOKEN) return;
	let busy = false;
	worker = setInterval(async () => {
		if (busy) return;
		busy = true;
		try {
			await processGroupInvitation(getDb());
			await processWebsiteLink(getDb());
		} catch {
			console.warn('Telegram invitation queue unavailable; retrying later.');
		} finally {
			busy = false;
		}
	}, 1000);
	worker.unref();
}
