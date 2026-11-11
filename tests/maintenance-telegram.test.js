import test from 'node:test';
import assert from 'node:assert/strict';
import {
	snapshotTelegramMaintenance, lockTelegramMaintenance, unlockTelegramMaintenance,
	createMaintenanceTelegramResponder, notifyTelegramMaintenance
} from '../src/lib/server/maintenance-telegram.js';

const env = { TELEGRAM_CHAT_ID: '-1001234567890', TELEGRAM_BOT_TOKEN: 'synthetic-maintenance-token' };
const original = {
	can_send_messages: true, can_send_audios: false, can_send_documents: true,
	can_send_photos: false, can_send_videos: true, can_send_video_notes: false,
	can_send_voice_notes: true, can_send_polls: false, can_send_other_messages: false,
	can_add_web_page_previews: false, can_change_info: false, can_invite_users: true,
	can_pin_messages: false, can_manage_topics: true
};
const snapshot = { chatId: env.TELEGRAM_CHAT_ID, permissions: original };
const maintenanceText = 'Website is updating. Messages are not processed during maintenance; please resend after service resumes.';

function api(results = {}) {
	const calls = [];
	return {
		calls,
		request: async (url, options) => {
			const method = url.split('/').at(-1);
			assert.equal(url, `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`);
			assert.equal(options.method, 'POST');
			assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
			assert.ok(options.signal instanceof AbortSignal);
			assert.equal(options.signal.aborted, false);
			const body = JSON.parse(options.body);
			calls.push({ method, body });
			const defaults = {
				getChat: { id: Number(env.TELEGRAM_CHAT_ID), type: 'supergroup', permissions: original },
				getMe: { id: 12345, is_bot: true },
				getChatMember: { status: 'administrator', can_restrict_members: true },
				setChatPermissions: true, sendMessage: { message_id: 1 }, answerCallbackQuery: true
			};
			const result = Object.hasOwn(results, method) ? results[method] : defaults[method];
			if (typeof result === 'function') return result(body);
			return { ok: true, json: async () => ({ ok: true, result }) };
		}
	};
}

function message(updateId = 1, chatId = 77, type = 'private') {
	return { update_id: updateId, message: { message_id: updateId, chat: { id: chatId, type }, from: { id: 77, is_bot: false }, text: 'Synthetic' } };
}

function callback(updateId = 1, chatId = 77, type = 'private') {
	const update = message(updateId, chatId, type);
	return { update_id: updateId, callback_query: { id: `callback-${updateId}`, from: update.message.from, message: update.message } };
}

// Every test uses a fetch-compatible synthetic API; accidental global networking fails immediately.
test.beforeEach((t) => {
	t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected network request'));
});

test('snapshot verifies configured group and bot rights, storing only independent original permissions', async () => {
	const mock = api();
	const saved = await snapshotTelegramMaintenance({ env, request: mock.request });
	assert.deepEqual(saved, snapshot);
	assert.notEqual(saved.permissions, original);
	assert.deepEqual(mock.calls.map((call) => call.method), ['getChat', 'getMe', 'getChatMember']);
	assert.deepEqual(mock.calls[2].body, { chat_id: env.TELEGRAM_CHAT_ID, user_id: '12345' });
	assert.doesNotMatch(JSON.stringify(saved), /token|https:|synthetic|"user_id"|"botId"/);
});

test('group creators and administrators with restrict rights can lock basic groups and supergroups', async () => {
	for (const type of ['group', 'supergroup']) {
		for (const member of [{ status: 'creator' }, { status: 'administrator', can_restrict_members: true }]) {
			const mock = api({ getChat: { id: snapshot.chatId, type, permissions: original }, getChatMember: member });
			assert.deepEqual(await snapshotTelegramMaintenance({ env, request: mock.request }), snapshot);
		}
	}
});

test('missing configuration is disabled only when both settings are absent; invalid IDs/config fail closed', async () => {
	assert.equal(await snapshotTelegramMaintenance({ env: {} }), null);
	for (const invalid of [
		{ TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID }, { TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN },
		{ ...env, TELEGRAM_BOT_TOKEN: ' ' }, { ...env, TELEGRAM_BOT_TOKEN: 'secret/path' },
		...['@group', '42', '-0', '-01', '-9007199254740992', '-1e4', ' -123'].map((chatId) => ({ ...env, TELEGRAM_CHAT_ID: chatId }))
	]) {
		await assert.rejects(snapshotTelegramMaintenance({ env: invalid }), /Telegram maintenance:/);
	}
	assert.equal(await lockTelegramMaintenance(null, { env: {} }), false);
	assert.equal(await unlockTelegramMaintenance(null, { env: {} }), false);
	assert.equal(await notifyTelegramMaintenance(null, { env: {}, enabled: true }), false);
	await assert.rejects(lockTelegramMaintenance(snapshot, { env: {} }), /configuration is required/);
});

test('rejects missing restrict rights, non-groups, wrong chat and unusable bot identity', async () => {
	for (const member of [null, { status: 'member' }, { status: 'administrator' },
		{ status: 'administrator', can_restrict_members: false }, { status: 'administrator', can_restrict_members: 'true' }]) {
		const mock = api({ getChatMember: member });
		await assert.rejects(snapshotTelegramMaintenance({ env, request: mock.request }), /administrator rights/);
	}
	for (const chat of [null, { id: snapshot.chatId, type: 'channel' },
		{ id: '-999', type: 'group' }, { id: '-9007199254740992', type: 'group' }]) {
		const mock = api({ getChat: chat });
		await assert.rejects(snapshotTelegramMaintenance({ env, request: mock.request }), /Telegram maintenance:/);
	}
	for (const bot of [null, { id: 1, is_bot: false }, { id: 0, is_bot: true }, { id: 1.5, is_bot: true }]) {
		const mock = api({ getMe: bot });
		await assert.rejects(snapshotTelegramMaintenance({ env, request: mock.request }), /Telegram maintenance:/);
	}
});

test('lock disables every sending capability, preserves unrelated rights, restores EXACT originals repeatedly', async () => {
	const mock = api();
	const saved = Object.freeze({ chatId: snapshot.chatId, permissions: Object.freeze({ ...original }) });
	for (let attempt = 0; attempt < 2; attempt++) {
		assert.equal(await lockTelegramMaintenance(saved, { env, request: mock.request }), true);
		assert.equal(await unlockTelegramMaintenance(saved, { env, request: mock.request }), true);
	}
	assert.deepEqual(mock.calls[0], mock.calls[2]);
	assert.deepEqual(mock.calls[1], mock.calls[3]);
	const locked = mock.calls[0].body;
	for (const [key, flag] of Object.entries(locked.permissions)) {
		assert.equal(flag, key.startsWith('can_send_') || ['can_add_web_page_previews', 'can_react_to_messages'].includes(key) ? false : original[key]);
	}
	assert.equal(locked.use_independent_chat_permissions, true);
	assert.deepEqual(mock.calls[1].body, { chat_id: saved.chatId, permissions: original, use_independent_chat_permissions: true });
	assert.deepEqual(saved, snapshot);
});

test('current reaction/tag flags and legacy media permissions snapshot, lock and restore exactly', async () => {
	const current = { ...original, can_react_to_messages: true, can_edit_tag: true };
	for (const rights of [current, { ...current, can_send_media_messages: false },
		{ can_send_messages: true, can_send_media_messages: true }]) {
		const mock = api({ getChat: { id: snapshot.chatId, type: 'supergroup', permissions: rights } });
		const saved = await snapshotTelegramMaintenance({ env, request: mock.request });
		assert.deepEqual(saved.permissions, rights);
		await lockTelegramMaintenance(saved, { env, request: mock.request });
		await unlockTelegramMaintenance(saved, { env, request: mock.request });
		const mutations = mock.calls.filter(({ method }) => method === 'setChatPermissions');
		assert.equal(mutations[0].body.permissions.can_react_to_messages, false);
		assert.equal(mutations[0].body.permissions.can_send_media_messages, false);
		assert.equal(mutations[0].body.permissions.can_edit_tag, rights.can_edit_tag);
		assert.deepEqual(mutations[1].body.permissions, rights);
		assert.deepEqual(saved.permissions, rights);
	}
});

test('partial and already-muted boolean permissions restore without adding any rights', async () => {
	for (const rights of [{ can_send_messages: false }, { can_invite_users: false },
		Object.fromEntries(Object.keys(original).map((key) => [key, false]))]) {
		const mock = api();
		const saved = { chatId: snapshot.chatId, permissions: rights };
		await lockTelegramMaintenance(saved, { env, request: mock.request });
		await unlockTelegramMaintenance(saved, { env, request: mock.request });
		for (const key of Object.keys(original).filter((key) => key.startsWith('can_send_') || key === 'can_add_web_page_previews'))
			assert.equal(mock.calls[0].body.permissions[key], false);
		assert.deepEqual(mock.calls[1].body.permissions, rights);
	}
});

test('malformed permissions and snapshots never make a mutation request', async () => {
	for (const rights of [undefined, null, [], {}, 'all', { can_send_messages: 1 },
		{ can_send_messages: 'false' }, { can_send_messages: true, unknown_permission: true },
		{ can_send_messages: true, token: 'secret' }, { can_send_media_messages: 'true' },
		{ can_react_to_messages: 1 }, { can_edit_tag: null }]) {
		const mock = api({ getChat: { id: snapshot.chatId, type: 'group', permissions: rights } });
		await assert.rejects(snapshotTelegramMaintenance({ env, request: mock.request }), {
			message: 'Telegram maintenance: invalid permissions.', code: 'TELEGRAM_MAINTENANCE_INVALID_PERMISSIONS'
		});
		for (const operation of [lockTelegramMaintenance, unlockTelegramMaintenance])
			await assert.rejects(operation({ chatId: snapshot.chatId, permissions: rights }, { env, request: mock.request }), /invalid permissions/);
		assert.deepEqual(mock.calls.map((call) => call.method), ['getChat']);
	}
	for (const saved of [undefined, {}, [], { ...snapshot, token: 'secret' }, { ...snapshot, chatId: '@group' }]) {
		await assert.rejects(unlockTelegramMaintenance(saved, { env }), /Telegram maintenance:/);
	}
});

test('restoration and notices use snapshotted group even when configured group changes', async () => {
	const mock = api();
	await unlockTelegramMaintenance(snapshot, { env: { ...env, TELEGRAM_CHAT_ID: '-999' }, request: mock.request });
	for (const enabled of [true, false])
		assert.equal(await notifyTelegramMaintenance(snapshot, { enabled, env, request: mock.request }), true);
	assert.ok(mock.calls.every((call) => call.body.chat_id === snapshot.chatId));
	assert.match(mock.calls[1].body.text, /locked/);
	assert.match(mock.calls[2].body.text, /restored/);
	assert.ok(mock.calls.slice(1).every((call) => !Object.hasOwn(call.body, 'parse_mode')));
	await assert.rejects(notifyTelegramMaintenance(snapshot, { env, request: mock.request }), /enabled must be a boolean/);
});

test('transport, HTTP, JSON, API and false mutation responses are sanitized', async () => {
	const sensitive = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sensitive-description`;
	for (const response of [
		async () => { throw new Error(sensitive); },
		async () => ({ ok: false, json: async () => ({ description: sensitive }) }),
		async () => ({ json: async () => { throw new Error(sensitive); } }),
		async () => ({ json: async () => ({ ok: false, description: sensitive }) }),
		async () => ({ json: async () => ({ ok: true, result: false }) }),
		async () => ({ json: async () => ({ ok: true }) })
	]) {
		const mock = api({ setChatPermissions: response });
		await assert.rejects(lockTelegramMaintenance(snapshot, { env, request: mock.request }), (error) => {
			assert.equal(error.message, 'Telegram maintenance: setChatPermissions request failed.');
			assert.doesNotMatch(String(error.stack), /synthetic-maintenance-token|sensitive-description|https:/);
			assert.equal(error.cause, undefined);
			return true;
		});
	}
});

test('requests use precisely a fifteen-second abort signal including injected fetch', async (t) => {
	const durations = [];
	const native = AbortSignal.timeout.bind(AbortSignal);
	t.mock.method(AbortSignal, 'timeout', (duration) => { durations.push(duration); return native(duration); });
	const mock = api();
	await snapshotTelegramMaintenance({ env, request: mock.request });
	await lockTelegramMaintenance(snapshot, { env, request: mock.request });
	assert.deepEqual(durations, [15_000, 15_000, 15_000, 15_000]);
});

test('responder handles new private and configured/snapshotted group messages with plain text', async () => {
	const mock = api();
	const respond = createMaintenanceTelegramResponder({ env, request: mock.request });
	assert.equal(await respond(message()), true);
	assert.equal(await respond(message(2, Number(snapshot.chatId), 'supergroup')), true);
	assert.equal(await respond(message(3, -999, 'group'), { ...snapshot, chatId: '-999' }), true);
	assert.equal(mock.calls.length, 3);
	assert.ok(mock.calls.every((call) => call.method === 'sendMessage' && call.body.text === maintenanceText && !call.body.parse_mode));
});

test('responder ignores bots, edits, unrelated groups, channels and malformed updates', async () => {
	const mock = api();
	const respond = createMaintenanceTelegramResponder({ env, request: mock.request });
	const bot = message(); bot.message.from.is_bot = true;
	const edited = message(); edited.edited_message = edited.message; delete edited.message;
	const editDate = message(); editDate.message.edit_date = 20;
	const botCallback = callback(); botCallback.callback_query.from.is_bot = true;
	const missingSender = message(); delete missingSender.message.from;
	const badCallback = callback(); badCallback.callback_query.id = '';
	for (const update of [undefined, {}, bot, edited, editDate, botCallback, missingSender, badCallback,
		message(1, -999, 'supergroup'), message(1, -999, 'channel'), message(1, 0), message(-1),
		{ ...message(), update_id: '1' }, { update_id: 1, callback_query: { id: 'inline', from: { id: 77 } } }])
		assert.equal(await respond(update), false);
	assert.equal(mock.calls.length, 0);
	assert.equal(await createMaintenanceTelegramResponder({ env: {} })(message()), false);
});

test('responder rate-limits each chat to one notice/minute and suppresses duplicate updates', async () => {
	let clock = 0;
	const mock = api();
	const respond = createMaintenanceTelegramResponder({ env, request: mock.request, now: () => clock });
	assert.equal(await respond(message(1)), true);
	assert.equal(await respond(message(1)), true);
	assert.equal(await respond(message(2)), true);
	assert.equal(await respond(message(3, 88)), true);
	clock = 59_999;
	await respond(message(4));
	assert.equal(mock.calls.length, 2);
	clock = 60_000;
	await respond(message(1));
	await respond(message(2));
	assert.equal(mock.calls.length, 2);
	await respond(message(5));
	assert.equal(mock.calls.length, 3);
	clock = 10 * 60_000;
	await respond(message(1));
	assert.equal(mock.calls.length, 4);
});

test('failed notices and callback answers are retryable without marking duplicates or consuming rate limit', async () => {
	for (const make of [message, callback]) {
		let attempts = 0;
		const request = async () => {
			attempts++;
			if (attempts === 1) throw new Error(`secret ${env.TELEGRAM_BOT_TOKEN}`);
			return { json: async () => ({ ok: true, result: true }) };
		};
		const respond = createMaintenanceTelegramResponder({ env, request });
		await assert.rejects(respond(make()), /request failed/);
		assert.equal(await respond(make()), true);
		assert.equal(await respond(make()), true);
		assert.equal(attempts, 2);
	}
});

test('applicable callbacks answer plain maintenance text and unrelated group callbacks are ignored', async () => {
	const mock = api();
	const respond = createMaintenanceTelegramResponder({ env, request: mock.request });
	const editedBotMessage = callback();
	editedBotMessage.callback_query.message.from = { id: 12345, is_bot: true };
	editedBotMessage.callback_query.message.edit_date = 50;
	assert.equal(await respond(editedBotMessage), true);
	assert.equal(await respond(callback(2, Number(snapshot.chatId), 'supergroup')), true);
	assert.equal(await respond(callback(3, -999, 'supergroup')), false);
	assert.deepEqual(mock.calls.map((call) => call.method), ['answerCallbackQuery', 'answerCallbackQuery']);
	assert.deepEqual(mock.calls[0].body, { callback_query_id: 'callback-1', text: maintenanceText });
});

test('concurrent updates in one chat produce only one in-flight notice, failures still permit retry', async () => {
	let rejectRequest;
	let attempts = 0;
	const request = async () => {
		attempts++;
		if (attempts === 1) return new Promise((resolve, reject) => { rejectRequest = reject; });
		return { json: async () => ({ ok: true, result: true }) };
	};
	const respond = createMaintenanceTelegramResponder({ env, request });
	const pending = respond(message());
	assert.equal(await respond(message()), true);
	assert.equal(await respond(message(2)), true);
	assert.equal(attempts, 1);
	rejectRequest(new Error('synthetic failure'));
	await assert.rejects(pending, /request failed/);
	assert.equal(await respond(message()), true);
	assert.equal(attempts, 2);
});

test('deduplication and chat memory are bounded even with many independent chats', async () => {
	const mock = api();
	const respond = createMaintenanceTelegramResponder({ env, request: mock.request, now: () => 0 });
	for (let index = 1; index <= 1025; index++) await respond(message(index, index));
	await respond(message(1, 1));
	assert.equal(mock.calls.length, 1026);
});
