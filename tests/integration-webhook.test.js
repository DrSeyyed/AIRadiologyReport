import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createWebhookRegistration } from '../src/lib/server/integration-webhook.js';
import { setWebhook } from '../src/lib/server/telegram.js';

test('legacy webhook helper also retains edited/callback updates and queued messages', async (t) => {
	const originalFetch = globalThis.fetch;
	const originalToken = process.env.TELEGRAM_BOT_TOKEN;
	const originalSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
	t.after(() => {
		globalThis.fetch = originalFetch;
		if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
		else process.env.TELEGRAM_BOT_TOKEN = originalToken;
		if (originalSecret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
		else process.env.TELEGRAM_WEBHOOK_SECRET = originalSecret;
	});
	process.env.TELEGRAM_BOT_TOKEN = '12345:synthetic_bot';
	process.env.TELEGRAM_WEBHOOK_SECRET = 'synthetic_secret';
	globalThis.fetch = async (url, options) => {
		assert.equal(url, 'https://api.telegram.org/bot12345:synthetic_bot/setWebhook');
		assert.deepEqual(JSON.parse(options.body), { url: 'https://site.example/api/telegram/webhook', secret_token: 'synthetic_secret',
			allowed_updates: ['message', 'edited_message', 'callback_query'], drop_pending_updates: false });
		return Response.json({ ok: true, result: true });
	};
	assert.equal(await setWebhook('https://site.example/api/telegram/webhook'), true);
});

function fixture(t, overrides = {}) {
	const db = new Database(':memory:');
	db.exec('CREATE TABLE application_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
	t.after(() => db.close());
	const env = { TELEGRAM_BOT_TOKEN: '12345:synthetic_bot_token', TELEGRAM_WEBHOOK_SECRET: 'synthetic_webhook_secret', TELEGRAM_WEBHOOK_BASE_URL: 'https://pacs.example.com' };
	const requests = [];
	const webhook = createWebhookRegistration({ db, env, request: async (url, options) => {
		requests.push({ url, options, payload: JSON.parse(options.body) });
		return Response.json({ ok: true, result: true });
	}, ...overrides });
	return { db, env, requests, webhook };
}

test('webhook registers only through official Telegram API with secret, supported updates and retained pending messages', async (t) => {
	const f = fixture(t);
	assert.equal(f.webhook.status().state, 'pending');
	const registered = await f.webhook.register();
	assert.equal(registered.state, 'registered');
	assert.equal(registered.url, 'https://pacs.example.com/api/telegram/webhook');
	assert.equal(f.requests[0].url, 'https://api.telegram.org/bot12345:synthetic_bot_token/setWebhook');
	assert.deepEqual(f.requests[0].payload, { url: registered.url, secret_token: f.env.TELEGRAM_WEBHOOK_SECRET,
		allowed_updates: ['message', 'edited_message', 'callback_query'], drop_pending_updates: false });
	assert.ok(f.requests[0].options.signal instanceof AbortSignal);
	const persisted = f.db.prepare('SELECT value FROM application_settings').get().value;
	assert.doesNotMatch(persisted, /synthetic_bot_token|synthetic_webhook_secret/);
	assert.doesNotMatch(JSON.stringify(registered), /synthetic_bot_token|synthetic_webhook_secret/);
	f.env.TELEGRAM_WEBHOOK_SECRET = 'rotated_secret';
	assert.equal(f.webhook.status().state, 'pending');
});

test('removal preserves queued updates and status remains removed until explicitly re-registered', async (t) => {
	const f = fixture(t);
	await f.webhook.register();
	assert.equal((await f.webhook.remove()).state, 'removed');
	assert.deepEqual(f.requests[1].payload, { drop_pending_updates: false });
	assert.match(f.requests[1].url, /\/deleteWebhook$/);
	assert.equal(createWebhookRegistration({ db: f.db, env: f.env }).status().state, 'removed');
	assert.equal((await f.webhook.register()).state, 'registered');
});

test('Telegram, timeout, malformed and HTTP failures are sanitized and retryable', async (t) => {
	for (const request of [
		async () => { throw new Error('synthetic_bot_token in https://api.telegram.org/private'); },
		async () => Response.json({ ok: false, description: 'synthetic_webhook_secret' }, { status: 401 }),
		async () => new Response('synthetic_bot_token', { status: 502 }),
		async () => Response.json({ ok: true, result: true }, { status: 500 })
	]) {
		const f = fixture(t, { request });
		await assert.rejects(f.webhook.register(), /could not be updated/);
		assert.equal(f.webhook.status().state, 'error');
		assert.doesNotMatch(JSON.stringify(f.webhook.status()), /synthetic_bot_token|synthetic_webhook_secret|api.telegram.org/);
	}
});

test('webhook origins reject insecure URLs, credentials, paths, fragments and queries without outbound requests', async (t) => {
	const f = fixture(t);
	for (const base of ['http://pacs.example.com', 'https://user:password@pacs.example.com', 'https://pacs.example.com/path', 'https://pacs.example.com?query=1', 'https://pacs.example.com#fragment', 'invalid']) {
		f.env.TELEGRAM_WEBHOOK_BASE_URL = base;
		await assert.rejects(f.webhook.register(), /HTTPS/);
	}
	assert.equal(f.requests.length, 0);
});

test('corrupt status never exposes stored data and changed bots do not inherit previous registration', async (t) => {
	const f = fixture(t);
	await f.webhook.register();
	f.env.TELEGRAM_BOT_TOKEN = '54321:different_bot';
	assert.equal(f.webhook.status().state, 'pending');
	f.db.prepare('UPDATE application_settings SET value=?').run('synthetic_bot_token');
	assert.deepEqual(f.webhook.status(), { state: 'error', error: 'Telegram webhook could not be updated. Check the bot token and public HTTPS website, then retry.' });
});
