import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';

const moduleUrl = (source) =>
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function fixture(t) {
	const db = new Database(':memory:');
	initializeSchema(db, readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
	db.exec(`INSERT INTO users(id,full_name,role,telegram_user_id) VALUES(1,'Synthetic admin','admin','101');
		INSERT INTO telegram_registrations(telegram_user_id,user_id,role,step) VALUES('101',1,'resident','approved');`);
	const key = `statisticsWebhook_${randomUUID()}`;
	const state = { db, dbCalls: 0, maintenance: false, maintenanceCalls: [], groups: [] };
	globalThis[key] = state;
	const previous = {
		TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
		TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET
	};
	process.env.TELEGRAM_BOT_TOKEN = 'synthetic-token';
	process.env.TELEGRAM_WEBHOOK_SECRET = 'synthetic-secret';
	t.after(() => {
		delete globalThis[key];
		db.close();
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	const sends = [];
	t.mock.method(globalThis, 'fetch', async (_url, options) => {
		sends.push(JSON.parse(options.body));
		return { ok: true, json: async () => ({ ok: true, result: {} }) };
	});
	const shared = `const state=globalThis[${JSON.stringify(key)}];`;
	const stubs = {
		'$lib/server/db': `${shared} export function getDb(){state.dbCalls++;return state.db;}`,
		'$lib/server/site-maintenance.js': `${shared} export function isSiteMaintenanceEnabled(){return state.maintenance;} export function maintenanceTelegramContext(){return {synthetic:true};}`,
		'$lib/server/maintenance-telegram.js': `${shared} export function createMaintenanceTelegramResponder(){return async(update,context)=>state.maintenanceCalls.push({update,context});}`,
		'$lib/server/telegram-group.js': `${shared} export async function handleTelegramGroupMessage(db,message,options){state.groups.push({message,options});}`
	};
	const source = readFileSync(
		new URL('../src/routes/api/telegram/webhook/+server.js', import.meta.url),
		'utf8'
	).replace(/from (['"])([^'"]+)\1/g, (_statement, _quote, specifier) => {
		const resolved = stubs[specifier]
			? moduleUrl(stubs[specifier])
			: specifier.startsWith('$lib/')
				? new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href
				: import.meta.resolve(specifier);
		return `from ${JSON.stringify(resolved)}`;
	});
	const { POST } = await import(moduleUrl(source));
	const invoke = (update, secret = process.env.TELEGRAM_WEBHOOK_SECRET) =>
		POST({
			request: new Request('http://localhost/api/telegram/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
				body: JSON.stringify(update)
			})
		});
	const message = (text = '/stats', id = 101) => ({
		message_id: 11,
		chat: { id, type: 'private' },
		from: { id, is_bot: false },
		text
	});
	return { db, state, sends, invoke, message };
}

test('webhook authenticates and gates maintenance before accessing statistics or database', async (t) => {
	const { state, sends, invoke, message } = await fixture(t);
	state.maintenance = true;
	assert.equal((await invoke({ message: message() }, 'wrong')).status, 401);
	assert.deepEqual(state.maintenanceCalls, []);
	assert.equal(state.dbCalls, 0);
	assert.equal((await invoke({ message: message() })).status, 200);
	assert.equal(state.maintenanceCalls.length, 1);
	assert.equal(state.dbCalls, 0);
	assert.deepEqual(sends, []);
});

test('new private statistics route before registration; unknown commands retain registration routing', async (t) => {
	const { db, state, sends, invoke, message } = await fixture(t);
	assert.equal((await invoke({ message: message() })).status, 200);
	assert.match(sends.at(-1).text, /Study statistics\nScope: All studies/);
	assert.equal(String(sends.at(-1).chat_id), '101');
	assert.equal((await invoke({ message: message('/stats help', 202) })).status, 200);
	assert.match(sends.at(-1).text, /approved Telegram registration/);
	assert.equal(
		db
			.prepare("SELECT count(*) AS n FROM telegram_registrations WHERE telegram_user_id='202'")
			.get().n,
		0
	);
	assert.equal((await invoke({ message: message('/register', 202) })).status, 200);
	assert.match(sends.at(-1).text, /Send your full name/);
	assert.equal(
		db.prepare("SELECT step FROM telegram_registrations WHERE telegram_user_id='202'").get().step,
		'name'
	);
	assert.equal((await invoke({ message: message('/unknown', 303) })).status, 200);
	assert.match(sends.at(-1).text, /Send \/register to begin/);
	assert.equal((await invoke({ message: message('/statsx', 303) })).status, 200);
	assert.match(sends.at(-1).text, /Send \/register to begin/);
	assert.deepEqual(state.groups, []);
});

test('statistics query and delivery failures do not expose internal details through the webhook', async (t) => {
	const { db, sends, invoke, message } = await fixture(t);
	db.exec('DROP TABLE studies');
	assert.equal((await invoke({ message: message() })).status, 200);
	assert.equal(
		sends.at(-1).text,
		'Statistics are temporarily unavailable. Please try again later.'
	);
	t.mock.method(globalThis, 'fetch', async () => {
		throw new Error('synthetic credential and database schema details');
	});
	const response = await invoke({ message: message() });
	assert.equal(response.status, 500);
	assert.deepEqual(await response.json(), { error: 'Telegram update could not be processed.' });
});

test('edited and forged direct messages never send statistics; group routing remains unchanged', async (t) => {
	const { state, sends, invoke, message } = await fixture(t);
	for (const update of [
		{ edited_message: message() },
		{ message: { ...message(), from: { id: 202, is_bot: false } } },
		{ message: { ...message(), from: { id: 101, is_bot: true } } },
		{ message: { ...message(), chat: { id: '101', type: 'private' } } }
	])
		assert.equal((await invoke(update)).status, 200);
	assert.deepEqual(sends, []);
	const group = { ...message(), chat: { id: -100, type: 'supergroup' } };
	assert.equal((await invoke({ message: group })).status, 200);
	assert.equal((await invoke({ edited_message: group })).status, 200);
	assert.deepEqual(state.groups, [
		{ message: group, options: { allowDelete: true } },
		{ message: group, options: { allowDelete: false } }
	]);
	assert.deepEqual(sends, []);
});
