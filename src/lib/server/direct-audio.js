import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_GPT_AUDIO_SETTINGS, MAX_GPT_AUDIO_LIMIT_SECONDS } from '../gpt-audio-settings.js';

const run = promisify(execFile);
const SAMPLE_RATE = 16000;
export const MAX_DIRECT_AUDIO_SECONDS = DEFAULT_GPT_AUDIO_SETTINGS.limitSeconds;

export class AudioDurationLimitError extends Error {
	constructor(limitSeconds) {
		const duration = limitSeconds % 60 === 0
			? `${limitSeconds / 60} minute${limitSeconds === 60 ? '' : 's'}`
			: `${limitSeconds} second${limitSeconds === 1 ? '' : 's'}`;
		super(`GPT Audio supports at most ${duration} of total recording audio under the administrator's settings. Select a substitute transcription model in Reporting settings for longer recordings.`);
		this.name = 'AudioDurationLimitError';
	}
}

function encodeWave(buffers, bytes) {
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
}

export async function prepareDirectAudio(parts, { transcription = false, limitSeconds = MAX_DIRECT_AUDIO_SECONDS, splitParts = false } = {}) {
	if (!Number.isSafeInteger(limitSeconds) || limitSeconds < 1 || limitSeconds > MAX_GPT_AUDIO_LIMIT_SECONDS)
		throw new Error('Select a valid GPT Audio time limit in seconds.');
	const maxPcmBytes = limitSeconds * SAMPLE_RATE * 2;
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
						String((maxPcmBytes - bytes) / (SAMPLE_RATE * 2) + 1),
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
			if (bytes > maxPcmBytes) throw new AudioDurationLimitError(limitSeconds);
			buffers.push(await readFile(output));
		}
		// Check the entire recording before any part can be sent to GPT Audio.
		if (splitParts) return buffers.map((buffer) => encodeWave([buffer], buffer.length));
		return encodeWave(buffers, bytes);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
