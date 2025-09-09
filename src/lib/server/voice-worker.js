import { getDb } from '$lib/server/db';
import { downloadFile } from '$lib/server/telegram.js';
import { editStudyMessage } from '$lib/server/telegram.js';
import fs from 'node:fs';
import path from 'node:path';

const SAVE_DIR = process.env.VOICE_SAVE_DIR || '/uploads/voices';

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
          const detail = db
              .prepare(
                `
                    SELECT
                      s.id AS study_id,
                      s.exam_date_jalali,
                      s.exam_time,
                      s.modality_id,
                      s.exam_type_id,
                      p.firstname  AS patient_firstname,
                      p.lastname AS patient_lastname,
                      p.patient_code AS patient_code,
                      r.full_name AS resident_fullname,
                      a.full_name AS attending_fullname,
                      m.code AS modality_code,
                      m.name AS modality_name,
                      e.code AS exam_type_code,
                      e.name AS exam_type_name,
                      s.exam_details AS exam_details,
                s.resident_checked,
                s.attending_checked,
                      s.telegram_message_id,
                      s.audio_report_path,
                      s.text_report_path
                    FROM studies s
                    JOIN patients p ON p.id = s.patient_id
                    LEFT JOIN users r ON r.id = s.corresponding_resident_id
                    LEFT JOIN users a ON a.id = s.corresponding_attending_id
                    LEFT JOIN modalities m ON m.id = s.modality_id
                    LEFT JOIN exam_types e ON e.id = s.exam_type_id
                    WHERE s.id = ?
                  `
              )
              .get(job.study_id);
              if(detail)
                await editStudyMessage(detail)
        } catch (err) {
          console.error('Voice download failed:', err);
        }
      }
    } catch (err) {
      console.error('Voice worker tick error:', err);
    }
  }, 30 * 1000); // check every 30s
}