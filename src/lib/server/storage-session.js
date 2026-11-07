const stopped = new WeakSet();

export function assertStorageSession(client) {
	if (stopped.has(client)) throw new Error('Storage session stopped.');
}

export function abortStorageSession(client) {
	if (!client || stopped.has(client)) return;
	stopped.add(client);
	try {
		// end() is graceful and can itself wait for the unresponsive SFTP server.
		if (typeof client.client?.destroy === 'function') client.client.destroy();
		else if (typeof client.destroy === 'function') client.destroy();
	} catch {
		// Termination must not replace the operation's error or expose connection details.
	}
}

export async function storageRequest(client, operation, timeoutMs = 20_000) {
	assertStorageSession(client);
	let timer;
	try {
		return await Promise.race([
			Promise.resolve().then(() => {
				assertStorageSession(client);
				return operation();
			}),
			new Promise((_, reject) => {
				timer = setTimeout(() => {
					reject(new Error('Storage request timed out.'));
					abortStorageSession(client);
				}, timeoutMs);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}
