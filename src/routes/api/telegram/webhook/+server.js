import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';

export const POST = async ({ request }) => {
  const update = await request.json().catch(() => ({}));
  const msg = update?.message;
  if (!msg) return json({ ok: true });

  const reply = msg.reply_to_message;
  if (!reply?.message_id || !msg.chat?.id) return json({ ok: true });

  const chat_id = String(msg.chat.id);
  const reply_to_message_id = Number(reply.message_id);

  const db = getDb();
  const study = db
    .prepare(
      `SELECT id FROM studies WHERE telegram_chat_id = ? AND telegram_message_id = ?`
    )
    .get(chat_id, reply_to_message_id);

  if (!study?.id) return json({ ok: true });

  const file_id = msg.voice?.file_id || msg.audio?.file_id;
  if (!file_id) return json({ ok: true });

  const process_at = Math.floor(Date.now() / 1000) + 5 * 60; // 5 min delay
  db.prepare(
    `INSERT INTO pending_voice (study_id, chat_id, reply_message_id, file_id, process_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(study.id, chat_id, msg.message_id, file_id, process_at);

  return json({ ok: true });
};