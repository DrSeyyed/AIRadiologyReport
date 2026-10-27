import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const run = promisify(execFile);
const SAMPLE_RATE = 16000;
export const MAX_DIRECT_AUDIO_SECONDS = 600;
const MAX_PCM_BYTES = MAX_DIRECT_AUDIO_SECONDS * SAMPLE_RATE * 2;

export async function prepareDirectAudio(parts, { transcription = false } = {}) {
	if (!parts?.length) throw new Error(transcription
		? 'No audio parts were provided for audio-model transcription.'
		: 'No audio parts were provided for direct reporting.');
	const directory = await mkdtemp(join(tmpdir(), 'radiology-audio-'));
	try {
		let bytes = 0;
		const buffers = [];
		for (const [index, part] of parts.entries()) {
			const output = join(directory, `part-${index}.pcm`);
			try {
				await run(
					process.env.FFMPEG_PATH || 'ffmpeg',
					[
						'-nostdin',
						'-hide_banner',
						'-loglevel',
						'error',
						'-y',
						'-protocol_whitelist',
						'file,pipe',
						'-format_whitelist',
						'wav,mp3,ogg,matroska,webm,mov,flac,aac',
						'-i',
						resolve(part.audio_report_path),
						'-map',
						'0:a:0',
						'-vn',
						'-ac',
						'1',
						'-ar',
						String(SAMPLE_RATE),
						'-c:a',
						'pcm_s16le',
						'-t',
						String(MAX_DIRECT_AUDIO_SECONDS + 1),
						'-f',
						's16le',
						output
					],
					{ timeout: 120000, maxBuffer: 65536, windowsHide: true }
				);
			} catch (error) {
				if (error.code === 'ENOENT')
					throw new Error(
						transcription
							? 'Audio-model transcription requires ffmpeg on the server. Install it or set FFMPEG_PATH, then try again.'
							: 'Direct audio reporting requires ffmpeg on the server. Install it or set FFMPEG_PATH, then try again.'
					);
				throw new Error(
					'Audio conversion failed. Check the recording and server ffmpeg configuration, then try again.'
				);
			}
			const size = (await stat(output)).size;
			if (!size || size % 2)
				throw new Error(transcription
					? 'A recording part contains no usable audio for audio-model transcription.'
					: 'A recording part contains no usable audio for direct reporting.');
			bytes += size;
			if (bytes > MAX_PCM_BYTES)
				throw new Error(
					transcription
						? 'Audio-model transcription supports at most 10 minutes per audio part. Select a dedicated transcription model for longer parts.'
						: 'Direct audio reporting supports at most 10 minutes of total audio. Use the transcription workflow for longer recordings.'
				);
			buffers.push(await readFile(output));
		}
		// Join decoded samples in order, not encoded containers, to retain every audio part in one valid WAV.
		const header = Buffer.alloc(44);
		header.write('RIFF', 0);
		header.writeUInt32LE(bytes + 36, 4);
		header.write('WAVEfmt ', 8);
		header.writeUInt32LE(16, 16);
		header.writeUInt16LE(1, 20);
		header.writeUInt16LE(1, 22);
		header.writeUInt32LE(SAMPLE_RATE, 24);
		header.writeUInt32LE(SAMPLE_RATE * 2, 28);
		header.writeUInt16LE(2, 32);
		header.writeUInt16LE(16, 34);
		header.write('data', 36);
		header.writeUInt32LE(bytes, 40);
		return Buffer.concat([header, ...buffers]).toString('base64');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
