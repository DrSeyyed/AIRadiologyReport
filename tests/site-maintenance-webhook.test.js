import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

test('maintenance webhook authenticates before responding and never processes bot commands, registration or study updates', async (t) => {
	const key = randomUUID();
	const oldToken = process.env.TELEGRAM_BOT_TOKEN;
	process.env.TELEGRAM_BOT_TOKEN = 'synthetic-token';
	const state = { enabled: true, authenticated: 0, database: 0, notices: [], registrations: 0, groups: 0, fail: false };
	globalThis[key] = state;
	t.after(() => {
		delete globalThis[key];
		if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
		else process.env.TELEGRAM_BOT_TOKEN = oldToken;
	});
	const access = `globalThis[${JSON.stringify(key)}]`;
	const source = readFileSync(new URL('../src/routes/api/telegram/webhook/+server.js', import.meta.url), 'utf8')
		.replace(/from (['"])([^'"]+)\1/g, (_match, _quote, specifier) => {
			let body;
			if (specifier === '@sveltejs/kit') body = 'export function json(value,options={}){return Response.json(value,options);}';
			else if (specifier === '$lib/server/db') body = `export function getDb(){${access}.database++;return {};}`;
			else if (specifier === '$lib/server/telegram-registration.js') body = `export function validateTelegramWebhook(headers){${access}.authenticated++;if(headers.get('x-telegram-bot-api-secret-token')!=='synthetic-secret')throw Object.assign(new Error('Forbidden'),{status:403});}export function handleTelegramRegistration(){${access}.registrations++;}`;
			else if (specifier === '$lib/server/telegram-group.js') body = `export function handleTelegramGroupMessage(){${access}.groups++;}`;
			else if (specifier === '$lib/server/site-maintenance.js') body = `export function isSiteMaintenanceEnabled(){return ${access}.enabled;}export function maintenanceTelegramContext(){return {chatId:'-100123',permissions:{can_send_messages:true}};}`;
			else if (specifier === '$lib/server/maintenance-telegram.js') body = `export function createMaintenanceTelegramResponder(){return async(update,snapshot)=>{if(${access}.fail)throw new Error('synthetic-token');${access}.notices.push({update,snapshot});};}`;
			else throw new Error(`Unexpected import ${specifier}`);
			return `from ${JSON.stringify(`data:text/javascript,${encodeURIComponent(body)}`)}`;
		});
	const { POST } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
	const call = (update, secret = 'synthetic-secret') => POST({ request: new Request('http://localhost/api/telegram/webhook', {
		method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(update)
	}) });
	const privateMessage = { update_id: 1, message: { message_id: 1, text: '/start', chat: { type: 'private', id: 7 } } };
	assert.equal((await call(privateMessage, 'wrong')).status, 403);
	assert.equal(state.notices.length, 0);
	for (const update of [privateMessage, { update_id: 2, message: { text: '/delete', chat: { type: 'supergroup', id: -100123 } } },
		{ update_id: 3, callback_query: { id: 'callback' } }]) assert.equal((await call(update)).status, 200);
	assert.equal(state.notices.length, 3);
	assert.equal(state.database, 0);
	assert.equal(state.registrations, 0);
	assert.equal(state.groups, 0);
	state.fail = true;
	const failed = await call(privateMessage);
	assert.equal(failed.status, 500);
	assert.doesNotMatch(await failed.text(), /synthetic-token/);
	state.fail = false;
	state.enabled = false;
	assert.equal((await call(privateMessage)).status, 200);
	assert.equal(state.registrations, 1);
	assert.equal((await call({ message: { chat: { type: 'supergroup', id: -100123 } } })).status, 200);
	assert.equal(state.groups, 1);
	assert.equal(state.database, 2);
});
