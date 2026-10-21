import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { trackStudyReply, telegramMessageLink, formatStudyReplyLinks } from '../src/lib/server/telegram-replies.js';
import { handleTelegramGroupMessage } from '../src/lib/server/telegram-group.js';
import { getStudyDetail } from '../src/lib/server/studies.js';
import { buildStudyMessage, editStudyMessage } from '../src/lib/server/telegram.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const chatId = -1001234567890;
const message = (id, parent = 42, extra = {}) => ({
	chat: { id: chatId, type: 'supergroup' }, message_id: id,
	from: { id: 200, first_name: 'Resident <One>' },
	reply_to_message: { message_id: parent }, voice: { file_id: `voice-${id}` }, ...extra
});

function fixture(t, source = schema) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	db.exec(source);
	db.exec(`INSERT INTO users(id,full_name,role,telegram_user_id) VALUES(2,'Resident','resident','200'),(3,'Typist','typist','300');
		INSERT INTO telegram_registrations(telegram_user_id,full_name,role,username,step,user_id) SELECT telegram_user_id,full_name,role,'synthetic-'||id,'approved',id FROM users;
		INSERT INTO studies(id,patient_code,patient_firstname,exam_date_jalali,exam_time,telegram_message_id) VALUES(1,'SYNTHETIC','Patient','1405-07-24','10:00','42');`);
	const original = process.env.TELEGRAM_CHAT_ID;
	process.env.TELEGRAM_CHAT_ID = String(chatId);
	t.after(() => { db.close(); if (original === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = original; });
	const removed = [], refreshed = [], notices = [];
	const dependencies = {
		remove: async (...args) => removed.push(args),
		refresh: async (study) => refreshed.push(study),
		notify: async (...args) => notices.push(args)
	};
	const handle = (msg) => handleTelegramGroupMessage(db, msg, dependencies);
	return { db, removed, refreshed, notices, dependencies, handle };
}

test('direct replies have separate lines and nested and sibling replies share the root line', async (t) => {
	const { db, handle, refreshed } = fixture(t);
	for (const msg of [message(43), message(44, 43), message(45, 44), message(46), message(47, 43)]) await handle(msg);
	const study = getStudyDetail(db, 1);
	assert.equal(study.telegram_replies.length, 5);
	const text = buildStudyMessage(study);
	const lines = text.split('\n').filter((line) => line.includes('https://t.me/c/'));
	assert.equal(lines.length, 2);
	for (const id of [43, 44, 45, 47]) assert.ok(lines[0].includes(`/1234567890/${id}"`));
	assert.ok(lines[1].includes('/1234567890/46"'));
	assert.match(lines[0], /Resident &lt;One&gt;/);
	assert.equal(refreshed.length, 5);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_voice').get().n, 5);
	db.exec('UPDATE studies SET needs_attention=1, description=\'Updated study\'');
	const updated = buildStudyMessage(getStudyDetail(db, 1));
	assert.match(updated, /Updated study/);
	assert.match(updated, /Needs attention: ⚠️ Yes/);
	assert.deepEqual(updated.split('\n').filter((line) => line.includes('https://t.me/c/')), lines);
});

test('cross-topic voice and audio replies resolve the original study instead of the topic starter', async (t) => {
	const { db, handle, removed, refreshed } = fixture(t);
	const crossTopic = (id, parent, extra = {}) => message(id, 900, {
		message_thread_id: 900, is_topic_message: true,
		external_reply: { origin: { type: 'user', date: 1, sender_user: { id: 1 } }, chat: { id: chatId }, message_id: parent },
		...extra
	});
	await handle(crossTopic(43, 42, { reply_to_message: undefined }));
	await handle(crossTopic(44, 43));
	await handle(crossTopic(45, 42, { voice: undefined, audio: { file_id: 'audio-45' } }));
	await handle(crossTopic(43, 42));
	const jobs = db.prepare('SELECT study_id, reply_message_id, parent_voice_job_id FROM pending_voice ORDER BY id').all();
	assert.equal(jobs.length, 3);
	assert.ok(jobs.every((job) => job.study_id === 1));
	assert.ok(jobs[1].parent_voice_job_id);
	const replies = getStudyDetail(db, 1).telegram_replies;
	assert.equal(replies.length, 3);
	assert.equal(replies.find((reply) => reply.message_id === 44).parent_message_id, 43);
	assert.equal(buildStudyMessage(refreshed.at(-1)).split('\n').filter((line) => line.includes('https://t.me/')).length, 2);
	assert.deepEqual(removed, []);
});

test('cross-chat or unidentified external replies cannot attach to matching local message IDs', async (t) => {
	const { db, handle, removed } = fixture(t);
	for (const external_reply of [
		{ chat: { id: -100999 }, message_id: 42 },
		{ message_id: 42 },
		{ chat: { id: chatId } },
		{ chat: { id: chatId }, message_id: -1 }
	]) await handle(message(43, 42, { external_reply }));
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_voice').get().n, 0);
	assert.equal(getStudyDetail(db, 1).telegram_replies.length, 0);
	assert.deepEqual(removed, []);
});

test('cross-topic replies retain account approval and disabled-study restrictions without deleting audio', async (t) => {
	const { db, handle, removed, notices } = fixture(t);
	const external_reply = { chat: { id: chatId }, message_id: 42 };
	await handle(message(43, null, { reply_to_message: undefined, external_reply, from: { id: 999 } }));
	await handle(message(44, null, { reply_to_message: undefined, external_reply, from: { id: 300 } }));
	db.exec('UPDATE studies SET disabled=1');
	await handle(message(45, null, { reply_to_message: undefined, external_reply }));
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_voice').get().n, 0);
	assert.equal(notices.length, 3);
	assert.deepEqual(removed, []);
});

test('voice and audio hyperlinks work for public and private supergroups without unsafe URLs', () => {
	assert.equal(telegramMessageLink({ chat_id: chatId, message_id: 51 }), 'https://t.me/c/1234567890/51');
	assert.equal(telegramMessageLink({ chat_id: chatId, chat_username: 'Public_group', message_id: 51 }), 'https://t.me/Public_group/51');
	assert.equal(telegramMessageLink({ chat_id: chatId, chat_username: 'bad"link', message_id: 51 }), 'https://t.me/c/1234567890/51');
	assert.equal(telegramMessageLink({ chat_id: -123, message_id: 51 }), null);
	assert.equal(telegramMessageLink({ chat_id: chatId, message_id: -1 }), null);
});

test('audio uploads are indexed, retries are idempotent and persisted links survive refresh', async (t) => {
	const { db, handle, refreshed } = fixture(t);
	const msg = message(43, 42, { voice: undefined, audio: { file_id: 'audio-43' } });
	await handle(msg); await handle(msg);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_voice').get().n, 1);
	assert.equal(getStudyDetail(db, 1).telegram_replies.length, 1);
	assert.match(buildStudyMessage(refreshed.at(-1)), />Audio 1 /);
	initializeSchema(db, schema); initializeSchema(db, schema);
	assert.match(buildStudyMessage(getStudyDetail(db, 1)), /t.me\/c\/1234567890\/43/);
	assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('all voice replies are linked without granting unapproved or typist accounts recording access', async (t) => {
	const { db, handle, notices, removed } = fixture(t);
	await handle(message(43, 42, { from: { id: 999, first_name: 'Unapproved' } }));
	await handle(message(44, 43, { from: { id: 300, first_name: 'Typist' } }));
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_voice').get().n, 0);
	assert.equal(getStudyDetail(db, 1).telegram_replies.length, 2);
	assert.equal(buildStudyMessage(getStudyDetail(db, 1)).split('\n').filter((line) => line.includes('https://t.me/')).length, 1);
	assert.equal(notices.length, 2);
	assert.equal(removed.length, 0);
});

test('non-audio messages are deleted everywhere in the configured group, including admin posts and unrelated messages', async (t) => {
	const { handle, removed } = fixture(t);
	for (const extra of [{ text: 'text' }, { photo: [{ file_id: 'photo' }] }, { document: { file_id: 'document' } }, { sticker: { file_id: 'sticker' } }, { video: { file_id: 'video' } }]) {
		await handle(message(50 + removed.length, 42, { voice: undefined, ...extra }));
	}
	await handle(message(60, null, { voice: undefined, reply_to_message: undefined, text: 'Admin standalone text', from: { id: 1 } }));
	assert.equal(removed.length, 6);
	assert.ok(removed.every((args) => args[1] === chatId));
});

test('study posts, private chats, other groups and unrelated voice/audio messages are not deleted', async (t) => {
	const { handle, removed, refreshed } = fixture(t);
	await handle(message(42, null, { voice: undefined, text: 'Study post' }));
	await handle(message(60, null, { chat: { id: 200, type: 'private' }, voice: undefined, text: '/register' }));
	await handle(message(61, null, { chat: { id: -100999, type: 'supergroup' }, voice: undefined, text: 'Other group' }));
	await handle(message(62, null, { reply_to_message: undefined }));
	await handle(message(63, 999));
	assert.deepEqual(removed, []);
	assert.deepEqual(refreshed, []);
});

test('failed Telegram deletions and edits propagate for webhook retry, without duplicate voice jobs', async (t) => {
	const { db, dependencies, handle } = fixture(t);
	await assert.rejects(handleTelegramGroupMessage(db, message(43, 42, { voice: undefined, text: 'text' }), {
		...dependencies, remove: async () => { throw new Error('Missing delete permission'); }
	}), /Missing delete permission/);
	await assert.rejects(handleTelegramGroupMessage(db, message(44), {
		...dependencies, refresh: async () => { throw new Error('Telegram unavailable'); }
	}), /Telegram unavailable/);
	await handle(message(44));
	assert.equal(getStudyDetail(db, 1).telegram_replies.length, 1);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_voice').get().n, 1);
});

test('disabled studies stay read-only while new voices still get navigation links and deletion tracking', async (t) => {
	const { db, handle, removed, notices } = fixture(t);
	db.exec('UPDATE studies SET disabled=1');
	await handle(message(43));
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_voice').get().n, 0);
	assert.match(buildStudyMessage(getStudyDetail(db, 1)), /DISABLED[\s\S]*t.me\/c\/1234567890\/43/);
	assert.equal(notices.length, 1);
	assert.equal(removed.length, 0);
});

test('long reply indexes retain recent links, preserve thread grouping and report omitted links within Telegram limits', () => {
	const rows = Array.from({ length: 150 }, (_, index) => ({ chat_id: String(chatId), message_id: 100 + index, parent_message_id: index % 3 ? 100 + index - index % 3 : null, sender_name: 'Synthetic <name> & sender', message_kind: 'voice' }));
	const text = buildStudyMessage({ patient_code: 'TEST', telegram_replies: rows });
	assert.ok(text.length <= 4096);
	assert.match(text, /\/249"/);
	assert.doesNotMatch(text, /\/100"/);
	assert.match(text, /… \d+ more replies/);
	for (const line of text.split('\n').filter((line) => line.includes('https://t.me/'))) {
		const ids = [...line.matchAll(/\/(\d+)"/g)].map((match) => Number(match[1]));
		assert.ok(ids.every((id) => Math.floor((id - 100) / 3) === Math.floor((ids[0] - 100) / 3)));
	}
	assert.equal(formatStudyReplyLinks(rows, 3), '');
	const long = buildStudyMessage({ description: 'x'.repeat(500), patient_fullname: 'n'.repeat(3500), disabled: true, telegram_replies: rows });
	assert.ok(long.length <= 4096);
	assert.match(long, /more replies/);
	assert.ok(long.endsWith('</s>'));
});

test('deleted voice links disappear and study deletion cascades the index', (t) => {
	const { db } = fixture(t);
	trackStudyReply(db, message(43));
	db.exec('UPDATE study_telegram_voices SET deleted=1');
	assert.doesNotMatch(buildStudyMessage(getStudyDetail(db, 1)), /https:\/\/t.me/);
	db.exec('DELETE FROM studies WHERE id=1');
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM study_telegram_voices').get().n, 0);
});

test('migration backfills previously tracked reply ancestry without resetting deletion markers', (t) => {
	const previousSchema = schema.replace('  parent_message_id INTEGER,\n', '').replace("  sender_name TEXT NOT NULL DEFAULT '',\n", '').replace("  message_kind TEXT NOT NULL DEFAULT 'voice' CHECK (message_kind IN ('voice', 'audio')),\n", '').replace("  chat_username TEXT NOT NULL DEFAULT '',\n", '');
	const { db } = fixture(t, previousSchema);
	db.prepare('INSERT INTO pending_voice(id,study_id,chat_id,reply_message_id,parent_voice_job_id,file_id,process_at) VALUES(1,1,?,43,NULL,?,0),(2,1,?,44,1,?,0)').run(String(chatId), 'file-43', String(chatId), 'file-44');
	db.prepare('INSERT INTO study_telegram_voices(study_id,chat_id,message_id,deleted) VALUES(1,?,43,0),(1,?,44,1)').run(String(chatId), String(chatId));
	initializeSchema(db, schema); initializeSchema(db, schema);
	const rows = db.prepare('SELECT * FROM study_telegram_voices ORDER BY message_id').all();
	assert.equal(rows[1].parent_message_id, 43);
	assert.equal(rows[1].deleted, 1);
	assert.equal(rows[0].parent_message_id, null);
	assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('study message edits use inline HTML hyperlinks rather than keyboard buttons', async (t) => {
	const original = process.env.TELEGRAM_BOT_TOKEN;
	process.env.TELEGRAM_BOT_TOKEN = 'synthetic-test-token';
	t.after(() => { if (original === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = original; });
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true, result: {} }) }; });
	await editStudyMessage({ telegram_message_id: 42, telegram_replies: [{ chat_id: String(chatId), message_id: 43 }] }, chatId);
	assert.equal(calls[0].parse_mode, 'HTML');
	assert.match(calls[0].text, /<a href="https:\/\/t.me\/c\/1234567890\/43">/);
	assert.equal(calls[0].reply_markup, undefined);
});

test('webhook authenticates before moderation and handles edited messages without touching private registration', async (t) => {
	const { db } = fixture(t);
	const key = `telegramReplyDb_${randomUUID()}`;
	globalThis[key] = db;
	const previous = { token: process.env.TELEGRAM_BOT_TOKEN, secret: process.env.TELEGRAM_WEBHOOK_SECRET };
	process.env.TELEGRAM_BOT_TOKEN = 'synthetic-test-token';
	process.env.TELEGRAM_WEBHOOK_SECRET = 'synthetic-webhook-secret';
	t.after(() => {
		delete globalThis[key];
		for (const [name, value] of [['TELEGRAM_BOT_TOKEN', previous.token], ['TELEGRAM_WEBHOOK_SECRET', previous.secret]]) {
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
	});
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls.push({ endpoint: url.split('/').at(-1), ...JSON.parse(options.body) });
		return { ok: true, json: async () => ({ ok: true, result: {} }) };
	});
	const source = readFileSync(new URL('../src/routes/api/telegram/webhook/+server.js', import.meta.url), 'utf8')
		.replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
			const resolved = specifier === '$lib/server/db'
				? `data:text/javascript,${encodeURIComponent(`export function getDb(){return globalThis[${JSON.stringify(key)}]}`)}`
				: specifier.startsWith('$lib/') ? new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href
					: import.meta.resolve(specifier);
			return `from ${JSON.stringify(resolved)}`;
		});
	const { POST } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
	const invoke = (update, secret = process.env.TELEGRAM_WEBHOOK_SECRET) => POST({ request: new Request('http://localhost/api/telegram/webhook', {
		method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(update)
	}) });
	const text = message(60, null, { voice: undefined, text: 'Group text' });
	assert.equal((await invoke({ message: text }, 'wrong-secret')).status, 401);
	assert.deepEqual(calls, []);
	assert.equal((await invoke({ edited_message: text })).status, 200);
	assert.equal(calls.at(-1).endpoint, 'deleteMessage');
	assert.equal(calls.at(-1).message_id, 60);
	calls.length = 0;
	const privateMessage = { chat: { id: 999, type: 'private' }, from: { id: 999 }, message_id: 61, text: '/register' };
	assert.equal((await invoke({ message: privateMessage })).status, 200);
	assert.ok(calls.some((call) => call.endpoint === 'sendMessage' && String(call.chat_id) === '999'));
	assert.ok(calls.every((call) => call.endpoint !== 'deleteMessage'));
	calls.length = 0;
	assert.equal((await invoke({ edited_message: privateMessage })).status, 200);
	assert.deepEqual(calls, []);
	assert.equal((await invoke({ message: message(43) })).status, 200);
	assert.ok(calls.some((call) => call.endpoint === 'editMessageText' && call.text.includes('/1234567890/43')));
});
