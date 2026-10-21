import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import { generatedTopics, removeGeneratedTopics } from '../scripts/remove-telegram-topics.mjs';
import { deleteGeneratedStudyTopic, sendStudyMessage } from '../src/lib/server/telegram.js';

const schema = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
const chatId = '-1001234567890';
const legacy = `CREATE TABLE telegram_index_topics(chat_id TEXT, clinical_day TEXT, message_thread_id INTEGER, PRIMARY KEY(chat_id,clinical_day));
	CREATE TABLE telegram_index_pages(chat_id TEXT, clinical_day TEXT, message_id INTEGER,
		FOREIGN KEY(chat_id,clinical_day) REFERENCES telegram_index_topics(chat_id,clinical_day) ON DELETE CASCADE);
	CREATE TABLE telegram_index_revision(id INTEGER PRIMARY KEY, version INTEGER);
	INSERT INTO telegram_index_revision VALUES(1,1);`;

function fixture(t) {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	db.exec(schema);
	db.exec(legacy);
	db.exec(`INSERT INTO studies(id,patient_code,exam_date_jalali,exam_time,telegram_message_id) VALUES(1,'SYNTHETIC','1405-07-29','09:00','42');
		INSERT INTO study_recordings(id,study_id,resident_checked,attending_checked) VALUES(1,1,1,1);`);
	for (const [chat, day, thread] of [[chatId, '1405-07-28', 100], [chatId, '1405-07-29', 200], ['-100999', '1405-07-29', 300]]) {
		db.prepare('INSERT INTO telegram_index_topics VALUES(?,?,?)').run(chat, day, thread);
		db.prepare('INSERT INTO telegram_index_pages VALUES(?,?,?)').run(chat, day, thread + 1);
	}
	t.after(() => db.close());
	return db;
}

const immediate = async () => {};

test('cleanup deletes only saved topics in the configured group and preserves General studies and signed recordings', async t => {
	const db = fixture(t);
	const before = db.prepare('SELECT * FROM studies').all();
	const recordings = db.prepare('SELECT * FROM study_recordings').all();
	const calls = [];
	const result = await removeGeneratedTopics(db, { chatId, wait: immediate, remove: async (...args) => { calls.push(args); return true; } });
	assert.deepEqual(result, { deleted: 2, failed: 0 });
	assert.deepEqual(calls, [[chatId, 100], [chatId, 200]]);
	assert.deepEqual(db.prepare('SELECT * FROM studies').all(), before);
	assert.deepEqual(db.prepare('SELECT * FROM study_recordings').all(), recordings);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_index_topics').get().n, 1);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_index_pages').get().n, 1);
	assert.deepEqual(await removeGeneratedTopics(db, { chatId, wait: immediate, remove: async () => assert.fail('Already removed') }), { deleted: 0, failed: 0 });
});

test('General or invalid stored IDs fail preflight before deleting any topic', async t => {
	for (const id of [1, 0, -1, 1.5, 'bad']) {
		const db = fixture(t);
		db.prepare('INSERT INTO telegram_index_topics VALUES(?,?,?)').run(chatId, 'invalid', id);
		await assert.rejects(removeGeneratedTopics(db, { chatId, wait: immediate, remove: async () => assert.fail('Unsafe deletion') }), /Refusing cleanup/);
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_index_topics').get().n, 4);
	}
});

test('already-deleted topics are checkpointed while permission failures keep their IDs for a safe rerun', async t => {
	const db = fixture(t);
	const result = await removeGeneratedTopics(db, { chatId, wait: immediate, remove: async (_, id) => {
		throw Object.assign(new Error(id === 100 ? 'Bad Request: TOPIC_ID_INVALID' : 'Forbidden'), { telegram_error_code: id === 100 ? 400 : 403 });
	} });
	assert.deepEqual(result, { deleted: 1, failed: 1 });
	assert.deepEqual(generatedTopics(db, chatId), [{ message_thread_id: 200 }]);
	assert.deepEqual(await removeGeneratedTopics(db, { chatId, wait: immediate, remove: async () => true }), { deleted: 1, failed: 0 });
});

test('rate limits are honored, temporary failures retry and exhausted failures remain resumable', async t => {
	const db = fixture(t);
	const waits = [];
	let attempts = 0;
	const result = await removeGeneratedTopics(db, { chatId, wait: async delay => waits.push(delay), remove: async (_, id) => {
		if (id === 200) throw new Error('Unavailable');
		attempts++;
		if (attempts === 1) throw Object.assign(new Error('Rate limit'), { telegram_error_code: 429, retry_after: 12 });
		return true;
	} });
	assert.deepEqual(result, { deleted: 1, failed: 1 });
	assert.equal(attempts, 2);
	assert.equal(waits[0], 12000);
	assert.deepEqual(generatedTopics(db, chatId), [{ message_thread_id: 200 }]);
});

test('new installations have no topic tables; upgrading removes old triggers without losing cleanup IDs or studies', t => {
	const db = fixture(t);
	for (const [name, table] of [['studies_insert', 'studies'], ['studies_delete', 'studies'], ['studies_update', 'studies'], ['attending_name', 'users'], ['modality', 'modalities']])
		db.exec(`CREATE TRIGGER telegram_index_${name} AFTER INSERT ON ${table} BEGIN UPDATE telegram_index_revision SET version=version+1; END;`);
	const before = db.prepare('SELECT * FROM studies').all();
	initializeSchema(db, schema);
	initializeSchema(db, schema);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'telegram_index_%'").get().n, 0);
	assert.deepEqual(db.prepare('SELECT * FROM studies').all(), before);
	assert.equal(generatedTopics(db, chatId).length, 2);
	const fresh = new Database(':memory:');
	t.after(() => fresh.close());
	fresh.exec(schema);
	assert.equal(fresh.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'telegram_index_%'").get().n, 0);
	assert.deepEqual(generatedTopics(fresh, chatId), []);
	assert.throws(() => generatedTopics(fresh, ''), /Configure TELEGRAM_CHAT_ID/);
});

test('Telegram uses deleteForumTopic only for non-General topics; normal study posts still omit a topic', async t => {
	const previous = process.env.TELEGRAM_BOT_TOKEN;
	process.env.TELEGRAM_BOT_TOKEN = 'synthetic';
	t.after(() => { if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = previous; });
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls.push({ method: url.split('/').at(-1), body: JSON.parse(options.body) });
		return { ok: true, json: async () => ({ ok: true, result: url.endsWith('/deleteForumTopic') ? true : { message_id: 42 } }) };
	});
	await assert.rejects(deleteGeneratedStudyTopic(chatId, 1), /Refusing/);
	assert.equal(await deleteGeneratedStudyTopic(chatId, 100), true);
	await sendStudyMessage({ id: 1, patient_code: 'SYNTHETIC' }, chatId);
	assert.deepEqual(calls[0], { method: 'deleteForumTopic', body: { chat_id: chatId, message_thread_id: 100 } });
	assert.equal(calls[1].method, 'sendMessage');
	assert.equal(calls[1].body.message_thread_id, undefined);
	assert.equal(calls.length, 2);
});

test('startup cleanup safely skips fresh databases and completed cleanups without Telegram configuration', t => {
	const script = fileURLToPath(new URL('../scripts/remove-telegram-topics.mjs', import.meta.url));
	for (const hasLegacyTables of [false, true]) {
		const directory = mkdtempSync(join(tmpdir(), 'telegram-topic-startup-'));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		mkdirSync(join(directory, 'db'));
		const db = new Database(join(directory, 'db', 'pacs.db'));
		if (hasLegacyTables) db.exec(legacy);
		db.close();
		const result = spawnSync(process.execPath, [script, '--delete'], {
			cwd: directory, env: { ...process.env, TELEGRAM_CHAT_ID: '', TELEGRAM_BOT_TOKEN: '' }, encoding: 'utf8'
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /No saved generated Telegram topics/);
	}
});

test('Docker startup runs cleanup before starting the app and stops on cleanup failure', () => {
	const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
	const line = dockerfile.split('\n').find((value) => value.startsWith('CMD '));
	const [shell, option, command] = JSON.parse(line.slice(4));
	assert.equal(shell, 'sh');
	assert.equal(option, '-lc');
	assert.deepEqual(command.split(' && ').map((value) => value.trim()), [
		'npm run db:init', 'npm run db:seed', 'npm run telegram:remove-topics -- --delete',
		'node build --host 0.0.0.0 --port ${PORT:-5173}'
	]);
});

test('CLI defaults to preview and refuses deletion without a bot token, retaining saved IDs', t => {
	const directory = mkdtempSync(join(tmpdir(), 'telegram-topic-removal-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	mkdirSync(join(directory, 'db'));
	const file = join(directory, 'db', 'pacs.db');
	const db = new Database(file);
	db.exec(legacy);
	db.prepare('INSERT INTO telegram_index_topics VALUES(?,?,?)').run(chatId, '1405-07-29', 100);
	db.close();
	const script = fileURLToPath(new URL('../scripts/remove-telegram-topics.mjs', import.meta.url));
	const env = { ...process.env, TELEGRAM_CHAT_ID: chatId, TELEGRAM_BOT_TOKEN: '' };
	const preview = spawnSync(process.execPath, [script], { cwd: directory, env, encoding: 'utf8' });
	assert.equal(preview.status, 0, preview.stderr);
	assert.match(preview.stdout, /1 saved generated topic/);
	assert.match(preview.stdout, /Preview only/);
	const deletion = spawnSync(process.execPath, [script, '--delete'], { cwd: directory, env, encoding: 'utf8' });
	assert.equal(deletion.status, 1);
	const check = new Database(file);
	try { assert.equal(generatedTopics(check, chatId).length, 1); } finally { check.close(); }
});
