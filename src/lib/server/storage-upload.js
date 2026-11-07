import { createReadStream } from 'node:fs';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { storageTimeoutMs } from './storage-settings.js';

class StorageUpload extends PassThrough {
	constructor(activity, path) {
		super({ autoDestroy: false, highWaterMark: 64 * 1024 });
		this.activity = activity;
		this.path = path;
	}

	read(size) {
		const chunk = super.read(size);
		// Observe consumption, not prebuffering, without putting an unread stream into flowing mode.
		if (chunk !== null) this.activity();
		return chunk;
	}
}

export async function uploadStorageFile(
	client,
	local,
	remote,
	settings = {},
	{ assertActive = () => {}, onProgress = () => {} } = {}
) {
	const timeoutMs = storageTimeoutMs(settings, 'uploadTimeoutSeconds');
	let timer;
	const source = createReadStream(local);
	const upload = new StorageUpload(() => {
		try {
			assertActive();
			onProgress();
			arm();
		} catch (error) {
			upload.destroy(error);
		}
	}, local);
	const arm = () => {
		clearTimeout(timer);
		timer = setTimeout(
			() => upload.destroy(new Error(`Storage upload stalled for ${timeoutMs / 1000} seconds.`)),
			timeoutMs
		);
		timer.unref();
	};
	source.on('error', (error) => upload.destroy(error));
	const sourceClosed = finished(source, { cleanup: true }).catch(() => {});
	const uploadClosed = finished(upload, { cleanup: true }).catch(() => {});
	try {
		assertActive();
		arm();
		const pending = client.put(upload, remote);
		source.pipe(upload);
		await pending;
	} finally {
		clearTimeout(timer);
		source.destroy();
		upload.destroy();
		await Promise.all([sourceClosed, uploadClosed]);
	}
}
