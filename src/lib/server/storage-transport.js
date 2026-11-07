import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { once } from 'node:events';
import { storageTimeoutMs } from './storage-settings.js';
import { abortStorageSession, assertStorageSession } from './storage-session.js';

const TIMEOUT_MS = 20_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_OPERATION_TIMEOUT_MS = 6 * DEFAULT_OPERATION_TIMEOUT_MS;

function operationTimeout(config) {
	const timeout =
		config.operationTimeoutMs === undefined
			? DEFAULT_OPERATION_TIMEOUT_MS
			: config.operationTimeoutMs;
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_OPERATION_TIMEOUT_MS) {
		throw storageError();
	}
	return timeout;
}

function hasControlCharacters(value) {
	return Array.from(value).some((character) => {
		const code = character.codePointAt(0);
		return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
	});
}

function unsafePathCharacters(value) {
	return value.includes('\\') || hasControlCharacters(value);
}

function storageError() {
	return new Error('Storage operation failed.');
}

function normalizedRoot(config) {
	const root = config?.root;
	if (
		typeof root !== 'string' ||
		!root.startsWith('/') ||
		unsafePathCharacters(root) ||
		root.split('/').some((part) => part === '.' || part === '..')
	) {
		throw new Error('Storage root must be an absolute POSIX directory without traversal.');
	}
	return path.posix.normalize(root);
}

/** Join a config object's root (or a root string) with safe, single-component POSIX names. */
export function storagePath(config, ...safeSegments) {
	const root = normalizedRoot(typeof config === 'string' ? { root: config } : config);
	for (const segment of safeSegments) {
		if (
			typeof segment !== 'string' ||
			!segment ||
			segment === '.' ||
			segment === '..' ||
			segment.includes('/') ||
			unsafePathCharacters(segment)
		) {
			throw new Error('Storage path segment is invalid.');
		}
	}
	return path.posix.join(root, ...safeSegments);
}

function connectionOptions(config) {
	const port = config?.port ?? 22;
	if (
		typeof config?.host !== 'string' ||
		!config.host ||
		/[\s/\\]/.test(config.host) ||
		hasControlCharacters(config.host) ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535
	) {
		throw new Error('Storage connection settings are invalid.');
	}
	return { host: config.host, port, readyTimeout: TIMEOUT_MS, retries: 0, tryKeyboard: false };
}

function parseFingerprint(value) {
	if (typeof value !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(value)) {
		throw new Error('Storage requires a pinned SHA256 host fingerprint.');
	}
	const encoded = value.slice(7).replace(/=$/, '');
	const digest = Buffer.from(encoded, 'base64');
	if (digest.length !== 32 || digest.toString('base64').replace(/=$/, '') !== encoded) {
		throw new Error('Storage requires a pinned SHA256 host fingerprint.');
	}
	return digest;
}

function attributeIs(attributes, name, type) {
	const value = attributes?.[name];
	return (
		value === true ||
		(typeof value === 'function' && value.call(attributes)) ||
		attributes?.type === type
	);
}

async function verifyRemotePath(client, remotePath, directory, signal) {
	const normalized = normalizedRoot({ root: remotePath });
	const components = normalized.split('/').filter(Boolean);
	for (let index = 0; index <= components.length; index += 1) {
		signal.throwIfAborted();
		const current = `/${components.slice(0, index).join('/')}`;
		const attributes = await client.lstat(current);
		signal.throwIfAborted();
		if (attributeIs(attributes, 'isSymbolicLink', 'l')) throw storageError();
		const mustBeDirectory = index < components.length || directory;
		if (
			!attributeIs(
				attributes,
				mustBeDirectory ? 'isDirectory' : 'isFile',
				mustBeDirectory ? 'd' : '-'
			)
		) {
			throw storageError();
		}
	}
}

function hostDigest(key) {
	if (!(key instanceof Uint8Array)) throw storageError();
	return createHash('sha256').update(key).digest();
}

async function defaultFactory() {
	const { default: SftpClient } = await import('ssh2-sftp-client');
	return new SftpClient();
}

async function bounded(operation, timeoutMs = TIMEOUT_MS, signal) {
	let timer;
	let stop;
	const controller = new AbortController();
	try {
		return await Promise.race([
			Promise.resolve().then(() => {
				controller.signal.throwIfAborted();
				return operation(controller.signal);
			}),
			new Promise((_, reject) => {
				stop = () => {
					controller.abort();
					reject(storageError());
				};
				timer = setTimeout(stop, timeoutMs);
				if (signal?.aborted) stop();
				else signal?.addEventListener('abort', stop, { once: true });
			})
		]);
	} finally {
		clearTimeout(timer);
		if (stop) signal?.removeEventListener('abort', stop);
		controller.abort();
	}
}

async function close(client, signal) {
	if (!client) return;
	try {
		await bounded(() => client.end(), TIMEOUT_MS, signal);
	} catch {
		abortStorageSession(client);
		// Cleanup errors must not expose connection details or mask the operation's result.
	}
}

/**
 * Run callback(client) on a password-only, explicitly pinned SFTP connection.
 * factory, when supplied, is an async or sync () => standard SftpClient for testing.
 * Connection/cleanup are bounded to 20 seconds each; the client is closed or force-aborted.
 * config.operationTimeoutMs bounds root checks plus callback: integer 1..21,600,000 ms,
 * default 3,600,000 ms (one hour). Optional config.signal aborts the active connection
 * without waiting for a stalled request or graceful close; callers must guard late callback work.
 * root and every ancestor must already exist as real directories (checked with lstat).
 * Resolves to the callback result; failures are sanitized, including callback errors.
 */
export async function withStorage(config, callback, factory = defaultFactory) {
	let client;
	try {
		normalizedRoot(config);
		const options = connectionOptions(config);
		const pin = parseFingerprint(config.fingerprint);
		const timeoutMs = operationTimeout(config);
		if (
			typeof config.username !== 'string' ||
			!config.username ||
			hasControlCharacters(config.username) ||
			typeof config.password !== 'string' ||
			!config.password ||
			typeof callback !== 'function'
		) {
			throw storageError();
		}
		let verified = false;
		config.signal?.throwIfAborted();
		client = await factory();
		config.signal?.throwIfAborted();
		await bounded(
			() =>
				client.connect({
					...options,
					username: config.username,
					password: config.password,
					authHandler: ['password'],
					hostVerifier(key) {
						try {
							verified = timingSafeEqual(pin, hostDigest(key));
							return verified;
						} catch {
							return false;
						}
					}
				}),
			TIMEOUT_MS,
			config.signal
		);
		if (!verified) throw storageError();
		return await bounded(
			async (signal) => {
				await verifyRemotePath(client, config.root, true, signal);
				signal.throwIfAborted();
				return callback(client);
			},
			timeoutMs,
			config.signal
		);
	} catch {
		abortStorageSession(client);
		throw storageError();
	} finally {
		if (config?.signal?.aborted) abortStorageSession(client);
		else await close(client, config?.signal);
	}
}

/** Discover an untrusted OpenSSH SHA256 fingerprint; never accept the key or send a password. */
export async function probeStorageHost(config, factory = defaultFactory) {
	let client;
	let fingerprint;
	try {
		const options = connectionOptions(config);
		client = await factory();
		try {
			await bounded(() =>
				client.connect({
					...options,
					username: 'storage-host-probe',
					authHandler: () => false,
					hostVerifier(key) {
						try {
							fingerprint = `SHA256:${hostDigest(key).toString('base64').replace(/=$/, '')}`;
						} catch {
							fingerprint = undefined;
						}
						return false;
					}
				})
			);
		} catch {
			// Refusing the host key intentionally terminates the handshake before authentication.
		}
		if (!fingerprint) throw storageError();
		return fingerprint;
	} catch {
		throw storageError();
	} finally {
		await close(client);
	}
}

/**
 * Stream the remote file over SFTP and return its lowercase SHA256 hex digest.
 * Path checks have a 20-second bound; each read uses the configured inactivity timeout.
 * The read bound defaults to 20 seconds, not a total-transfer limit.
 * onProgress receives the byte count of each nonempty chunk read for verification.
 * Best-effort lstat checks reject symlinks in the absolute file path before opening it.
 * SFTP cannot make the check/open sequence atomic against concurrent remote replacement.
 */
export async function hashRemote(
	client,
	remotePath,
	{ onProgress = () => {}, verificationTimeoutSeconds } = {}
) {
	let stream;
	try {
		assertStorageSession(client);
		const readTimeoutMs = storageTimeoutMs(
			{ verificationTimeoutSeconds },
			'verificationTimeoutSeconds'
		);
		await bounded((signal) => verifyRemotePath(client, remotePath, false, signal));
		stream = client.createReadStream(remotePath);
		// ssh2 disables emitClose but emits CLOSE acknowledgements manually, so finished() is insufficient.
		const closed = once(stream, 'close');
		closed.catch(() => {});
		const iterator = stream[Symbol.asyncIterator]();
		const hash = createHash('sha256');
		while (true) {
			const { done, value } = await bounded(() => iterator.next(), readTimeoutMs);
			if (done) break;
			hash.update(value);
			if (value.length) onProgress(value.length);
		}
		await bounded(() => closed, readTimeoutMs);
		return hash.digest('hex');
	} catch {
		abortStorageSession(client);
		throw storageError();
	} finally {
		stream?.destroy();
	}
}
