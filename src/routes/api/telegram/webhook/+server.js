import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { downloadFile } from '$lib/server/telegram.js';
import path from 'node:path';
import fs from 'node:fs';

const SAVE_DIR = process.env.VOICE_SAVE_DIR || '/uploads/voices';

export const POST = async ({ request }) => {
  const update = await request.json().catch(() => ({}));
  const msg = update?.message;
  if (!msg) return json({ ok: true });

  // Only care about replies to our study posts
  const reply = msg.reply_to_message;
  if (!reply?.message_id || !msg.chat?.id) return json({ ok: true });

  const chat_id = String(msg.chat.id);
  const reply_to_message_id = Number(reply.message_id);

  // Find the study that owns the original post
  const db = getDb();
  const study = db
    .prepare(
      `SELECT id FROM studies WHERE telegram_chat_id = ? AND telegram_message_id = ?`
    )
    .get(chat_id, reply_to_message_id);

  if (!study?.id) return json({ ok: true }); // Not our thread

  // Accept Telegram "voice" (voice notes) and "audio" (regular audio files)
  const voice = msg.voice;       // .ogg opus, usually
  const audio = msg.audio;       // could be mp3/m4a/etc.

  const file_id =
    (voice && voice.file_id) ||
    (audio && audio.file_id) ||
    null;

  if (!file_id) {
    // Not audio → ignore (or delete if you want)
    return json({ ok: true });
  }

  // Ensure dir exists
  try { fs.mkdirSync(SAVE_DIR, { recursive: true }); } catch {}

  // Choose a filename
  const ext = voice ? '.ogg' : (audio?.file_name ? path.extname(audio.file_name) || '.bin' : '.bin');
  const filename = `study_${study.id}_reply_${msg.message_id}${ext}`;
  const dest = path.join(SAVE_DIR, filename);

  try {
    const savedPath = await downloadFile(file_id, dest);

    // Store path on the study (or into a separate attachments table if you prefer)
    db.prepare(
      `UPDATE studies SET audio_report_path = ? WHERE id = ?`
    ).run(savedPath, study.id);

    // Optional: you could send a small confirmation reply:
    // await sendReply(chat_id, '🎤 Voice saved.', msg.message_id);

  } catch (err) {
    console.error('Audio download failed:', err);
  }

  return json({ ok: true });
};
