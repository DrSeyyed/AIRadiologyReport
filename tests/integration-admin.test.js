import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationAdmin } from '../src/lib/server/integration-admin.js';
import { withIntegrationConfigurationLock } from '../src/lib/server/integration-coordination.js';

const keys = ['OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'GEMINI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_WEBHOOK_BASE_URL'];
const admin = { user: { id: 1, role: 'admin' } };
function fixture(overrides = {}) {
	const env = { OPENAI_API_KEY: 'legacy-openai' };
	const saved = {};
	const calls = [];
	const state = { maintenance: false, webhook: 'unconfigured', failWebhook: false };
	const options = { env,
		resolveSettings: () => ({ ...env, ...saved }),
		readSettings: () => ({ encryptionConfigured: true, fields: Object.fromEntries(keys.map(key => [key, {
			configured: Boolean(saved[key] ?? env[key]), source: Object.hasOwn(saved, key) ? 'admin' : env[key] ? 'environment' : 'unset',
			...(['TELEGRAM_CHAT_ID', 'TELEGRAM_WEBHOOK_BASE_URL'].includes(key) ? { value: saved[key] ?? env[key] ?? '' } : {})
		}])) }),
		saveSettings: (updates) => { calls.push(['save', { ...updates }]); Object.assign(saved, updates); },
		applySettings: () => { calls.push(['apply']); Object.assign(env, saved); },
		maintenanceStatus: () => ({ enabled: state.maintenance }),
		getDatabase: () => { calls.push(['database']); return {}; },
		webhook: () => ({ status: () => ({ state: state.webhook }), register: async () => {
			calls.push(['register']); if (state.failWebhook) throw new Error('private-token'); state.webhook = 'registered';
		}, remove: async () => { calls.push(['remove']); state.webhook = 'removed'; } }),
		generateSecret: () => 'generated_secret', ...overrides };
	const route = createIntegrationAdmin(options);
	async function action(name, values = {}, locals = admin) {
		const body = values instanceof URLSearchParams ? values : new URLSearchParams(values);
		return route.actions[name]({ locals, request: new Request('http://localhost/admin/integrations', { method: 'POST', body }) });
	}
	return { env, saved, state, calls, route, action };
}

test('all integration data and actions require administrator before reading database, settings or forms', async () => {
	const f = fixture();
	for (const locals of [{}, { user: { id: 2, role: 'resident' } }]) {
		assert.throws(() => f.route.load({ locals }), cause => cause.status === (locals.user ? 403 : 302));
		for (const name of Object.keys(f.route.actions)) await assert.rejects(f.route.actions[name]({ locals, request: { formData() { assert.fail('must authenticate first'); } } }), cause => cause.status === (locals.user ? 403 : 302));
	}
	assert.deepEqual(f.calls, []);
	const loaded = f.route.load({ locals: admin });
	assert.doesNotMatch(JSON.stringify(loaded), /legacy-openai/);
	assert.equal(loaded.settings.fields.OPENAI_API_KEY.configured, true);
});

test('provider blanks retain keys, explicit clears override environment, and updates apply immediately', async () => {
	const f = fixture();
	assert.equal((await f.action('saveProviders', { OPENAI_API_KEY: '', ELEVENLABS_API_KEY: 'new-elevenlabs' })).success, true);
	assert.deepEqual(f.saved, { ELEVENLABS_API_KEY: 'new-elevenlabs' });
	assert.equal(f.env.OPENAI_API_KEY, 'legacy-openai');
	assert.equal(f.env.ELEVENLABS_API_KEY, 'new-elevenlabs');
	await f.action('saveProviders', { clear_OPENAI_API_KEY: 'on' });
	assert.equal(f.env.OPENAI_API_KEY, '');
	f.state.maintenance = true;
	assert.equal((await f.action('saveProviders', { GEMINI_API_KEY: 'new-gemini' })).success, true);
});

test('forms reject duplicates, master key fields, nonstandard checkbox values and clear/replacement conflicts', async () => {
	for (const fields of [new URLSearchParams([['OPENAI_API_KEY', 'one'], ['OPENAI_API_KEY', 'two']]),
		{ STORAGE_ENCRYPTION_KEY: 'never-managed' }, { clear_OPENAI_API_KEY: 'true' }, { OPENAI_API_KEY: 'new', clear_OPENAI_API_KEY: 'on' }]) {
		const f = fixture();
		assert.equal((await f.action('saveProviders', fields)).status, 400);
		assert.deepEqual(f.saved, {});
	}
});

test('saving bot and website generates a protected secret and automatically registers webhook only after persistence and apply', async () => {
	const f = fixture();
	const result = await f.action('saveTelegram', { TELEGRAM_BOT_TOKEN: '12345:synthetic', TELEGRAM_CHAT_ID: '-100123', TELEGRAM_WEBHOOK_BASE_URL: 'https://pacs.example.com', TELEGRAM_WEBHOOK_SECRET: '' });
	assert.equal(result.success, true);
	assert.match(result.message, /automatically/);
	assert.equal(f.saved.TELEGRAM_WEBHOOK_SECRET, 'generated_secret');
	assert.equal(f.env.TELEGRAM_BOT_TOKEN, '12345:synthetic');
	assert.deepEqual(f.calls.map(call => call[0]), ['save', 'apply', 'database', 'register']);
	assert.doesNotMatch(JSON.stringify(result), /synthetic|generated_secret/);
});

test('webhook failures report saved-but-not-registered without rolling back credentials, allowing retry', async () => {
	const f = fixture();
	f.state.failWebhook = true;
	const result = await f.action('saveTelegram', { TELEGRAM_BOT_TOKEN: '12345:synthetic', TELEGRAM_WEBHOOK_BASE_URL: 'https://pacs.example.com' });
	assert.equal(result.success, true);
	assert.ok(result.webhookError);
	assert.equal(f.env.TELEGRAM_WEBHOOK_SECRET, 'generated_secret');
	assert.doesNotMatch(JSON.stringify(result), /private-token|generated_secret/);
	assert.equal((await f.action('registerWebhook')).status, 503);
	f.state.failWebhook = false;
	assert.equal((await f.action('registerWebhook')).success, true);
});

test('Telegram changes and remote mutations are blocked during maintenance, including queued configuration operations', async () => {
	const f = fixture();
	f.state.maintenance = true;
	for (const name of ['saveTelegram', 'registerWebhook', 'removeWebhook', 'importEnvironment']) assert.equal((await f.action(name)).status, 409);
	assert.deepEqual(f.calls, []);
	f.state.maintenance = false;
	let release;
	let started;
	const active = new Promise(resolve => { started = resolve; });
	const blocker = withIntegrationConfigurationLock(async () => { started(); await new Promise(resolve => { release = resolve; }); f.state.maintenance = true; });
	await active;
	const waiting = f.action('saveTelegram', { TELEGRAM_CHAT_ID: '-100456' });
	release();
	await blocker;
	assert.equal((await waiting).status, 409);
	assert.deepEqual(f.saved, {});
});

test('replacing bot requires explicit removal of original webhook and never drops pending messages', async () => {
	const f = fixture();
	f.env.TELEGRAM_BOT_TOKEN = '12345:old_bot';
	f.state.webhook = 'registered';
	assert.equal((await f.action('saveTelegram', { TELEGRAM_BOT_TOKEN: '54321:new_bot' })).status, 409);
	assert.equal((await f.action('removeWebhook', { confirmation: 'wrong' })).status, 400);
	assert.equal((await f.action('removeWebhook', { confirmation: 'REMOVE WEBHOOK' })).success, true);
	assert.equal((await f.action('saveTelegram', { TELEGRAM_BOT_TOKEN: '54321:new_bot' })).success, true);
	assert.equal(f.env.TELEGRAM_BOT_TOKEN, '54321:new_bot');
});

test('explicit emergency replacement recovers from an inaccessible old bot and rotates its webhook secret', async () => {
	const f = fixture();
	f.env.TELEGRAM_BOT_TOKEN = '12345:revoked_bot';
	f.env.TELEGRAM_WEBHOOK_SECRET = 'retired_secret';
	f.env.TELEGRAM_WEBHOOK_BASE_URL = 'https://site.example';
	f.state.webhook = 'error';
	assert.equal((await f.action('saveTelegram', { TELEGRAM_BOT_TOKEN: '54321:new_bot', replaceBotConfirmation: 'wrong' })).status, 400);
	assert.equal((await f.action('saveTelegram', { TELEGRAM_BOT_TOKEN: '54321:new_bot' })).status, 409);
	const result = await f.action('saveTelegram', { TELEGRAM_BOT_TOKEN: '54321:new_bot', replaceBotConfirmation: 'REPLACE BOT' });
	assert.equal(result.success, true);
	assert.match(result.message, /old bot webhook was not removed/);
	assert.equal(f.env.TELEGRAM_BOT_TOKEN, '54321:new_bot');
	assert.equal(f.env.TELEGRAM_WEBHOOK_SECRET, 'generated_secret');
	assert.equal(f.calls.some(([name]) => name === 'remove'), false);
});

test('rotation is explicit, secret blanks preserve current value, and secret/provider failures never echo inputs', async () => {
	const f = fixture();
	f.env.TELEGRAM_WEBHOOK_SECRET = 'old-secret';
	await f.action('saveTelegram', { TELEGRAM_WEBHOOK_SECRET: '' });
	assert.equal(f.env.TELEGRAM_WEBHOOK_SECRET, 'old-secret');
	assert.equal((await f.action('saveTelegram', { rotateWebhookSecret: 'on', TELEGRAM_WEBHOOK_SECRET: 'typed-secret' })).status, 400);
	await f.action('saveTelegram', { rotateWebhookSecret: 'on' });
	assert.equal(f.env.TELEGRAM_WEBHOOK_SECRET, 'generated_secret');
	const broken = fixture({ saveSettings: () => { throw new Error('provider-private-secret'); } });
	const result = await broken.action('saveProviders', { OPENAI_API_KEY: 'provider-private-secret' });
	assert.equal(result.status, 400);
	assert.doesNotMatch(JSON.stringify(result), /provider-private-secret/);
});

test('migration imports configured legacy environment keys without overwriting existing admin settings or master key', async () => {
	const f = fixture();
	f.saved.GEMINI_API_KEY = 'already-saved';
	f.env.STORAGE_ENCRYPTION_KEY = 'server-only';
	assert.equal((await f.action('importEnvironment', { confirmation: 'IMPORT SETTINGS' })).success, true);
	assert.equal(f.saved.OPENAI_API_KEY, 'legacy-openai');
	assert.equal(f.saved.GEMINI_API_KEY, 'already-saved');
	assert.equal(Object.hasOwn(f.saved, 'STORAGE_ENCRYPTION_KEY'), false);
});
