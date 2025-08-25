import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { existsSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, extname } from 'node:path';

const AUDIO_DIR = 'uploads/audio';

export async function POST({ params, request, locals }) {
  try {
    if (!locals.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const id = Number(params.id);
    if (!Number.isFinite(id)) {
      return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });
    }

    const form = await request.formData();
    const file = form.get('file');

    if (!(file instanceof File)) {
      return new Response(JSON.stringify({ error: 'No file provided (expecting form field "file")' }), { status: 400 });
    }

    if (!existsSync(AUDIO_DIR)) mkdirSync(AUDIO_DIR, { recursive: true });

    const safeExt = extname(file.name || '').toLowerCase() || '.mp3';
    const filename = `study_${id}_${Date.now()}${safeExt}`;
    const fullPath = join(AUDIO_DIR, filename);

    // Simple write (loads into memory). OK for small files:
    const buf = Buffer.from(await file.arrayBuffer());
    writeFileSync(fullPath, buf);

    // For large files, use streaming instead:
    // const stream = file.stream(); // web ReadableStream
    // const writable = createWriteStream(fullPath);
    // await new Response(stream).body.pipeTo(writable as any);

    const db = getDb();
    db.prepare('UPDATE studies SET audio_report_path = ? WHERE id = ?').run(fullPath, id);

    return json({ ok: true, path: fullPath });
  } catch (e) {
    console.error('Audio upload error:', e);
    return new Response(JSON.stringify({ error: e?.message || 'Server error' }), { status: 500 });
  }
}
