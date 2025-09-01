import { getDb } from '$lib/server/db';
import { downloadFile } from '$lib/server/telegram.js';
import fs from 'node:fs';
import path from 'node:path';

const SAVE_DIR = process.env.VOICE_SAVE_DIR || '/data/voices';

export function startVoiceWorker() {
  fs.mkdirSync(SAVE_DIR, { recursive: true });

  setInterval(async () => {
    try {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);

      const jobs = db.prepare(
        `SELECT * FROM pending_voice WHERE done = 0 AND process_at <= ? ORDER BY id LIMIT 10`
      ).all(now);

      for (const job of jobs) {
        try {
          const filename = `study_${job.study_id}_reply_${job.reply_message_id}.ogg`;
          const dest = path.join(SAVE_DIR, filename);

          const savedPath = await downloadFile(job.file_id, dest);

          db.prepare(
            `UPDATE studies SET audio_report_path = ? WHERE id = ?`
          ).run(savedPath, job.study_id);

          db.prepare(`UPDATE pending_voice SET done = 1 WHERE id = ?`).run(job.id);
        } catch (err) {
          console.error('Voice download failed:', err);
        }
      }
    } catch (err) {
      console.error('Voice worker tick error:', err);
    }
  }, 30 * 1000); // check every 30s
}