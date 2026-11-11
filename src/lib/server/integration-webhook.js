import { createHash } from 'node:crypto';

const STATE_KEY = 'integration_telegram_webhook_status';
const FAILURE = 'Telegram webhook could not be updated. Check the bot token and public HTTPS website, then retry.';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const tokenFingerprint = (env) => digest(env.TELEGRAM_BOT_TOKEN || '');
const fingerprint = (env) => digest(JSON.stringify([
	env.TELEGRAM_BOT_TOKEN || '', env.TELEGRAM_WEBHOOK_SECRET || '', env.TELEGRAM_WEBHOOK_BASE_URL || ''
]));

function webhookUrl(env) {
	try {
		const url = new URL(env.TELEGRAM_WEBHOOK_BASE_URL);
		if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
		return `${url.origin}/api/telegram/webhook`;
	} catch {
		throw new Error('Enter the public HTTPS website origin before registering its webhook.');
	}
}

export function createWebhookRegistration({ db, env = process.env, request = fetch, now = () => new Date().toISOString() }) {
	function read() {
		try {
			const value = db.prepare('SELECT value FROM application_settings WHERE key=?').get(STATE_KEY)?.value;
			if (!value) return null;
			const state = JSON.parse(value);
			if (!['pending', 'registered', 'removed', 'error'].includes(state.state) ||
				!Number.isFinite(Date.parse(state.updatedAt)) || !/^[a-f0-9]{64}$/.test(state.fingerprint) ||
				!/^[a-f0-9]{64}$/.test(state.botFingerprint)) throw new Error();
			return state;
		} catch { return { state: 'error' }; }
	}
	function write(state, snapshot) {
		db.prepare('INSERT INTO application_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
			.run(STATE_KEY, JSON.stringify({ state, updatedAt: now(), fingerprint: fingerprint(snapshot), botFingerprint: tokenFingerprint(snapshot) }));
	}
	function status() {
		const stored = read();
		const matches = stored?.fingerprint === fingerprint(env);
		if (stored?.state === 'removed' && stored.botFingerprint === tokenFingerprint(env))
			return { state: 'removed', updatedAt: stored.updatedAt };
		if (stored?.state === 'error' && (matches || !stored.fingerprint)) return { state: 'error', error: FAILURE };
		if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_BASE_URL || !env.TELEGRAM_WEBHOOK_SECRET)
			return { state: 'unconfigured' };
		let url;
		try { url = webhookUrl(env); } catch { return { state: 'error', error: FAILURE }; }
		return { state: matches ? stored.state : 'pending', url, ...(matches ? { updatedAt: stored.updatedAt } : {}) };
	}
	async function call(method, payload, snapshot) {
		if (!/^\d+:[A-Za-z0-9_-]+$/.test(snapshot.TELEGRAM_BOT_TOKEN || '')) throw new Error(FAILURE);
		try {
			const response = await request(`https://api.telegram.org/bot${snapshot.TELEGRAM_BOT_TOKEN}/${method}`, {
				method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify(payload)
			});
			const result = await response.json();
			if (!response.ok || result?.ok !== true || result.result !== true) throw new Error();
		} catch { throw new Error(FAILURE); }
	}
	return {
		status,
		async register() {
			const snapshot = { ...env };
			const url = webhookUrl(snapshot);
			if (!/^[A-Za-z0-9_-]{1,256}$/.test(snapshot.TELEGRAM_WEBHOOK_SECRET || '')) throw new Error('Configure a webhook secret before registration.');
			write('pending', snapshot);
			try {
				await call('setWebhook', { url, secret_token: snapshot.TELEGRAM_WEBHOOK_SECRET,
					allowed_updates: ['message', 'edited_message', 'callback_query'], drop_pending_updates: false }, snapshot);
				write('registered', snapshot);
			} catch {
				write('error', snapshot);
				throw new Error(FAILURE);
			}
			return status();
		},
		async remove() {
			const snapshot = { ...env };
			write('pending', snapshot);
			try {
				await call('deleteWebhook', { drop_pending_updates: false }, snapshot);
				write('removed', snapshot);
			} catch {
				write('error', snapshot);
				throw new Error(FAILURE);
			}
			return status();
		}
	};
}
