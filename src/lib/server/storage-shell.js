import { storageTimeoutMs } from './storage-settings.js';
import { abortStorageSession, assertStorageSession } from './storage-session.js';

const MAX_OUTPUT_BYTES = 16 * 1024;
const ignoreError = () => {};
const shellError = () => new Error('Storage shell operation failed.');

function quotePath(value) {
	if (
		typeof value !== 'string' ||
		!value.startsWith('/') ||
		Buffer.byteLength(value) > 4096 ||
		value.includes('\\') ||
		Array.from(value).some((character) => {
			const code = character.codePointAt(0);
			return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
		}) ||
		value
			.slice(1)
			.split('/')
			.some((part) => !part || part === '.' || part === '..')
	) {
		throw shellError();
	}
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function drain(channel, destroy) {
	// Retain error sinks: ssh2 may emit errors even after close or a late exec callback.
	for (const stream of [channel, channel?.stderr]) {
		try {
			stream?.on('error', ignoreError);
			stream?.resume();
		} catch {
			// Cleanup must not expose remote errors.
		}
	}
	if (destroy) {
		try {
			channel?.destroy();
		} catch {
			// Session termination remains the final fallback.
		}
	}
}

async function execute(
	client,
	command,
	settings,
	{ assertActive = () => {}, onProgress = () => {} },
	parse
) {
	try {
		const checkActive = () => {
			assertStorageSession(client);
			assertActive();
		};
		checkActive();
		const timeoutMs = storageTimeoutMs(settings, 'verificationTimeoutSeconds');
		if (typeof client?.client?.exec !== 'function' || typeof onProgress !== 'function')
			throw shellError();

		return await new Promise((resolve, reject) => {
			let settled = false;
			let channel;
			let exitCode;
			let exitSignal;
			let stdoutBytes = 0;
			let stderrBytes = 0;
			const stdout = [];
			const listeners = [];
			const timer = setTimeout(() => finish(false), timeoutMs);

			function finish(success, result) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				// Install sinks before removing our handlers or destroying the transport.
				drain(channel, false);
				for (const [stream, event, listener] of listeners) stream.removeListener(event, listener);
				if (!success) {
					abortStorageSession(client);
					drain(channel, true);
					reject(shellError());
				} else resolve(result);
			}

			function listen(stream, event, listener) {
				listeners.push([stream, event, listener]);
				stream.on(event, listener);
			}

			function guarded(action) {
				if (settled) return;
				try {
					checkActive();
					action();
				} catch {
					finish(false);
				}
			}

			function receive(chunk, stderr) {
				guarded(() => {
					const bytes = Buffer.from(chunk);
					if (stderr) stderrBytes += bytes.length;
					else stdoutBytes += bytes.length;
					if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) throw shellError();
					if (!stderr) stdout.push(bytes);
					if (bytes.length) onProgress(bytes.length);
					checkActive();
				});
			}

			try {
				checkActive();
				client.client.exec(command, (error, opened) => {
					if (settled) {
						drain(opened, true);
						return;
					}
					channel = opened;
					guarded(() => {
						if (error || !channel || !channel.stderr) throw shellError();
						// All lifecycle/error handlers precede data listeners, which start flowing.
						listen(channel, 'error', () => finish(false));
						listen(channel.stderr, 'error', () => finish(false));
						listen(channel, 'exit', (code, signal) => {
							guarded(() => {
								exitCode = code;
								exitSignal = signal;
								if (code !== 0 || signal) throw shellError();
							});
						});
						listen(channel, 'close', (code, signal) => {
							guarded(() => {
								if (signal || (code !== undefined && code !== 0)) throw shellError();
								if ((code ?? exitCode) !== 0 || exitSignal) throw shellError();
								const result = parse(Buffer.concat(stdout).toString('utf8'));
								checkActive();
								finish(true, result);
							});
						});
						listen(channel.stderr, 'data', (chunk) => receive(chunk, true));
						if (!settled) listen(channel, 'data', (chunk) => receive(chunk, false));
					});
				});
			} catch {
				finish(false);
			}
		});
	} catch {
		throw shellError();
	}
}

/**
 * Hash on an existing trusted, fingerprint-pinned SSH/SFTP session (no file download).
 * verificationTimeoutSeconds (default 20) is a total deadline, including exec open and close.
 * onProgress counts received command-output bytes, NOT hashed file bytes. Errors are sanitized.
 * Paths must be absolute POSIX file names without traversal, backslashes or control characters.
 * The caller supplies the trusted session and is responsible for remote symlink/race policy.
 */
export async function hashStorageFile(client, remotePath, settings = {}, options = {}) {
	try {
		assertStorageSession(client);
		options.assertActive?.();
		const command = `sha256sum -- ${quotePath(remotePath)}`;
		return await execute(client, command, settings, options, (output) => {
			const digest = output.slice(0, 64);
			if (!/^[a-fA-F0-9]{64}$/.test(digest) || output.slice(64) !== `  ${remotePath}\n`)
				throw shellError();
			return digest.toLowerCase();
		});
	} catch {
		throw shellError();
	}
}

/**
 * Create a same-filesystem hard link without overwrite, using the existing trusted session.
 * Resolves undefined; deadline, progress and path rules are the same as hashStorageFile.
 * Requires Linux ln/sha256sum. Existing destination directories must be excluded by the caller:
 * plain ln treats a directory target as a container. No atomic symlink/path checks are provided.
 */
export async function linkStorageFile(client, sourcePath, targetPath, settings = {}, options = {}) {
	try {
		assertStorageSession(client);
		options.assertActive?.();
		const command = `ln -- ${quotePath(sourcePath)} ${quotePath(targetPath)}`;
		return await execute(client, command, settings, options, (output) => {
			if (output !== '') throw shellError();
		});
	} catch {
		throw shellError();
	}
}
