import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { deleteGeneratedStudyTopic } from '../src/lib/server/telegram.js';

function hasTable(db, name) {
	return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

export function generatedTopics(db, chatId) {
	if (!chatId || !/^-100\d+$/.test(String(chatId))) throw new Error('Configure TELEGRAM_CHAT_ID for the study supergroup.');
	if (!hasTable(db, 'telegram_index_topics')) return [];
	const topics = db.prepare(`SELECT DISTINCT message_thread_id FROM telegram_index_topics
		WHERE chat_id = ? AND message_thread_id IS NOT NULL ORDER BY message_thread_id`).all(String(chatId));
	if (topics.some(({ message_thread_id: id }) => !Number.isSafeInteger(id) || id <= 1))
		throw new Error('Refusing cleanup: stored topic IDs include General or an invalid topic.');
	return topics;
}

export async function removeGeneratedTopics(db, {
	chatId = process.env.TELEGRAM_CHAT_ID,
	remove = deleteGeneratedStudyTopic,
	wait = setTimeout
} = {}) {
	const topics = generatedTopics(db, chatId);
	let deleted = 0, failed = 0;
	for (const { message_thread_id: id } of topics) {
		let removed = false;
		for (let attempt = 0; attempt < 5; attempt++) {
			let delay = 3000;
			try {
				if (await remove(String(chatId), id) !== true) throw new Error('Telegram did not confirm deletion.');
				removed = true;
			} catch (error) {
				const code = error.telegram_error_code;
				if (code === 400 && /TOPIC_ID_INVALID|message thread not found|topic (?:was )?not found/i.test(error.message)) {
					removed = true;
				} else if (code === 429) {
					const seconds = Number(error.retry_after);
					delay = Number.isFinite(seconds) && seconds > 0 ? Math.max(3000, seconds * 1000) : 30000;
				} else if (code && code < 500) {
					break;
				} else {
					delay = Math.min(30000, 3000 * (2 ** attempt));
				}
			}
			await wait(delay);
			if (removed) break;
		}
		if (!removed) {
			failed++;
			continue;
		}
		db.transaction(() => {
			if (hasTable(db, 'telegram_index_pages'))
				db.prepare(`DELETE FROM telegram_index_pages WHERE chat_id = ? AND clinical_day IN
					(SELECT clinical_day FROM telegram_index_topics WHERE chat_id = ? AND message_thread_id = ?)`)
					.run(String(chatId), String(chatId), id);
			db.prepare('DELETE FROM telegram_index_topics WHERE chat_id = ? AND message_thread_id = ?').run(String(chatId), id);
		})();
		deleted++;
	}
	return { deleted, failed };
}

async function main() {
	const args = process.argv.slice(2);
	if (args.some((arg) => arg !== '--delete')) throw new Error('Usage: npm run telegram:remove-topics -- [--delete]');
	const db = new Database(resolve('db', 'pacs.db'), { fileMustExist: true });
	db.pragma('foreign_keys = ON');
	try {
		if (!hasTable(db, 'telegram_index_topics') || !db.prepare('SELECT 1 FROM telegram_index_topics WHERE message_thread_id IS NOT NULL LIMIT 1').get()) {
			console.log('No saved generated Telegram topics to remove.');
			return;
		}
		const count = generatedTopics(db, process.env.TELEGRAM_CHAT_ID).length;
		console.log(`${count} saved generated topic(s) in the configured group. General is excluded.`);
		if (!args.includes('--delete')) {
			console.log('Preview only. Stop old app instances, then rerun with --delete to permanently delete these topics and all their messages.');
			return;
		}
		if (count && !process.env.TELEGRAM_BOT_TOKEN) throw new Error('Configure TELEGRAM_BOT_TOKEN before deletion.');
		const result = await removeGeneratedTopics(db);
		console.log(`Deleted/already absent: ${result.deleted}. Failed: ${result.failed}. Failed IDs are retained for a rerun.`);
		if (result.failed) process.exitCode = 1;
	} finally {
		db.close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch(() => {
		console.error('Topic cleanup could not complete. Check configuration, database access and bot Manage Topics/Delete messages permissions. Saved IDs allow a safe rerun.');
		process.exitCode = 1;
	});
}
