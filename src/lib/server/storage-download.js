import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { storageTimeoutMs } from './storage-settings.js';

export async function downloadStorageFile(
	client,
	remote,
	local,
	settings = {},
	{ onProgress = () => {} } = {}
) {
	const timeoutMs = storageTimeoutMs(settings, 'verificationTimeoutSeconds');
	const source = client.createReadStream(remote);
	let timer;
	const arm = () => {
		clearTimeout(timer);
		timer = setTimeout(
			() => source.destroy(new Error('Storage download inactivity timeout.')),
			timeoutMs
		);
		timer.unref();
	};
	const progress = new Transform({
		transform(chunk, _encoding, callback) {
			try {
				arm();
				onProgress(chunk.length);
				callback(null, chunk);
			} catch (error) {
				callback(error);
			}
		}
	});
	try {
		arm();
		await pipeline(source, progress, createWriteStream(local, { flags: 'wx', mode: 0o600 }));
	} finally {
		clearTimeout(timer);
	}
}
