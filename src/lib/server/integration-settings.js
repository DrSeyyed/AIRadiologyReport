import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { assertStorageKey, decryptSecret, encryptSecret } from './storage-crypto.js';

/** Only non-secret fields expose their value in administrator status responses. */
export const INTEGRATION_FIELDS = Object.freeze(
	[
		['OPENAI_API_KEY', 'OpenAI API key', true, 2048],
		['ELEVENLABS_API_KEY', 'ElevenLabs API key', true, 2048],
		['GEMINI_API_KEY', 'Gemini API key', true, 2048],
		['TELEGRAM_BOT_TOKEN', 'Telegram bot token', true, 2048],
		['TELEGRAM_CHAT_ID', 'Telegram group chat ID', false, 32],
		['TELEGRAM_WEBHOOK_SECRET', 'Telegram webhook secret', true, 256],
		['TELEGRAM_WEBHOOK_BASE_URL', 'Telegram webhook base URL', false, 2048]
	].map(([key, label, secret, maxLength]) => Object.freeze({ key, label, secret, maxLength }))
);

const startupEnvironments = new WeakMap();
const keys = new Set(INTEGRATION_FIELDS.map(({ key }) => key));
const reservedIPv6 = new BlockList();
reservedIPv6.addSubnet('2001::', 23, 'ipv6');
reservedIPv6.addSubnet('2001:db8::', 32, 'ipv6');
reservedIPv6.addSubnet('2002::', 16, 'ipv6');
reservedIPv6.addSubnet('3fff::', 20, 'ipv6');
const READ_ERROR =
	'Unable to read encrypted integration settings. Check the server encryption key and deployment settings file.';
const WRITE_ERROR =
	'Unable to save encrypted integration settings. Check the server encryption key and deployment settings directory.';

function invalid() {
	return Object.assign(new Error('Invalid integration settings.'), { status: 400 });
}

function publicHostname(hostname) {
	const host = hostname.toLowerCase().replace(/\.$/, '');
	if (host.startsWith('[') && host.endsWith(']')) {
		const address = host.slice(1, -1);
		return (
			isIP(address) === 6 &&
			/^[23][0-9a-f]{3}:/.test(address) &&
			!reservedIPv6.check(address, 'ipv6')
		);
	}
	if (isIP(host) === 4) {
		const [a, b, c] = host.split('.').map(Number);
		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
			(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
			(a === 203 && b === 0 && c === 113)
		);
	}
	// DNS validation is syntactic, not a network request; local/reserved namespaces are excluded.
	return (
		host.length <= 253 &&
		host.includes('.') &&
		!/(^|\.)(localhost|local|internal|test|invalid|example|onion|home|lan)$/.test(host) &&
		host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
		/[a-z]/.test(host.split('.').at(-1))
	);
}

export function normalizeIntegrationValue(key, value) {
	const field = INTEGRATION_FIELDS.find((field) => field.key === key);
	if (
		!field ||
		typeof value !== 'string' ||
		value.length > field.maxLength ||
		/[\p{Cc}\p{Cf}]/u.test(value)
	) {
		throw invalid();
	}
	if (value === '') return value;
	if (key === 'TELEGRAM_BOT_TOKEN' && !/^[1-9][0-9]*:[A-Za-z0-9_-]{35}$/.test(value))
		throw invalid();
	if (key === 'TELEGRAM_CHAT_ID' && !/^-[1-9][0-9]*$/.test(value)) throw invalid();
	if (key === 'TELEGRAM_WEBHOOK_SECRET' && !/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw invalid();
	if (key === 'TELEGRAM_WEBHOOK_BASE_URL') {
		try {
			if (!/^https:\/\/[^/?#\s\\]+\/?$/i.test(value)) throw invalid();
			const url = new URL(value);
			if (url.username || url.password || !publicHostname(url.hostname)) throw invalid();
			return url.origin;
		} catch {
			throw invalid();
		}
	}
	return value;
}

function location(cwd, legacy = false) {
	// Deployment configuration intentionally lives outside all clinical restore roots.
	const directory = legacy
		? path.resolve(cwd, 'restore-staging', '.integrations')
		: path.resolve(cwd, 'config');
	return { directory, filename: path.join(directory, 'settings.json') };
}

function syncDirectory(directory) {
	// Windows does not support opening directories for fsync through this API.
	if (process.platform === 'win32') return;
	const fd = fs.openSync(directory, 'r');
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function directorySafe(directory, create = false) {
	const parent = path.dirname(directory);
	if (parent !== directory) directorySafe(parent, create);
	let stat;
	try {
		stat = fs.lstatSync(directory);
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
		if (!create) return;
		fs.mkdirSync(directory, { mode: 0o700 });
		syncDirectory(parent);
		stat = fs.lstatSync(directory);
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(READ_ERROR);
}

function fileSafe(stat, legacy = false) {
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.nlink !== 1 ||
		stat.size > 65536 ||
		(!legacy && process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
	)
		throw new Error(READ_ERROR);
}

function readRecord(cwd, legacy = false) {
	const { directory, filename } = location(cwd, legacy);
	directorySafe(directory);
	if (!legacy && process.platform !== 'win32') {
		try {
			if ((fs.lstatSync(directory).mode & 0o077) !== 0) throw new Error(READ_ERROR);
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
	let stat;
	try {
		stat = fs.lstatSync(filename);
	} catch (error) {
		if (error.code === 'ENOENT') return undefined;
		throw error;
	}
	fileSafe(stat, legacy);
	const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const opened = fs.fstatSync(fd);
		fileSafe(opened, legacy);
		if (stat.ino !== opened.ino || stat.dev !== opened.dev) throw new Error(READ_ERROR);
		const buffer = Buffer.alloc(65537);
		let length = 0;
		while (length < buffer.length) {
			const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
			if (!count) break;
			length += count;
		}
		fileSafe(fs.fstatSync(fd), legacy);
		if (length > 65536) throw new Error(READ_ERROR);
		return JSON.parse(buffer.toString('utf8', 0, length));
	} finally {
		fs.closeSync(fd);
	}
}

function decodeRecord(record) {
	assertStorageKey();
	if (
		!record ||
		record.version !== 1 ||
		Object.keys(record).length !== 2 ||
		typeof record.ciphertext !== 'string'
	)
		throw invalid();
	const payload = JSON.parse(decryptSecret(record.ciphertext));
	if (
		!payload ||
		payload.scope !== 'AIRadiologyReport/integrations/v1' ||
		Object.keys(payload).some((key) => !['scope', 'fields', 'restoreOperationId'].includes(key)) ||
		(payload.restoreOperationId !== undefined &&
			!/^[a-f0-9-]{36}$/.test(payload.restoreOperationId)) ||
		!payload.fields ||
		typeof payload.fields !== 'object' ||
		Array.isArray(payload.fields) ||
		Object.keys(payload.fields).some((key) => !keys.has(key))
	)
		throw invalid();
	const saved = new Map();
	for (const [key, value] of Object.entries(payload.fields)) {
		saved.set(key, normalizeIntegrationValue(key, value));
	}
	saved.restoreOperationId = payload.restoreOperationId;
	return saved;
}

function savedSettings(cwd) {
	try {
		const record = readRecord(cwd);
		if (record !== undefined) return decodeRecord(record);
		// Reads must not silently fall back to environment values before legacy migration.
		if (readRecord(cwd, true) !== undefined) throw new Error(READ_ERROR);
		return new Map();
	} catch {
		throw new Error(READ_ERROR);
	}
}

function writeRecord(cwd, record) {
	const { directory, filename } = location(cwd);
	directorySafe(directory, true);
	if (process.platform !== 'win32' && (fs.lstatSync(directory).mode & 0o077) !== 0)
		throw new Error(WRITE_ERROR);
	const pending = path.join(directory, `.settings-${randomUUID()}.pending`);
	let fd;
	let created = false;
	try {
		fd = fs.openSync(pending, 'wx', 0o600);
		created = true;
		fs.fchmodSync(fd, 0o600);
		fileSafe(fs.fstatSync(fd));
		fs.writeFileSync(fd, JSON.stringify(record));
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		directorySafe(directory);
		try {
			fileSafe(fs.lstatSync(filename));
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
		fs.renameSync(pending, filename);
		syncDirectory(directory);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		if (created) fs.rmSync(pending, { force: true });
	}
}

/** Run before application/database startup; never changes or deletes the legacy ciphertext. */
export function initializeIntegrationSettings({ cwd = process.cwd() } = {}) {
	try {
		const { directory } = location(cwd);
		directorySafe(directory, true);
		if (process.platform !== 'win32') {
			const before = fs.lstatSync(directory);
			const fd = fs.openSync(
				directory,
				fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0)
			);
			try {
				const opened = fs.fstatSync(fd);
				if (!opened.isDirectory() || before.ino !== opened.ino || before.dev !== opened.dev)
					throw invalid();
				fs.fchmodSync(fd, 0o700);
				if ((fs.fstatSync(fd).mode & 0o777) !== 0o700) throw invalid();
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
		}
		const current = readRecord(cwd);
		if (current !== undefined) {
			decodeRecord(current);
			return { migrated: false };
		}
		// Legacy mounts may ignore chmod. Only authenticate and copy their bounded encrypted file.
		const legacy = readRecord(cwd, true);
		if (legacy === undefined) return { migrated: false };
		decodeRecord(legacy);
		writeRecord(cwd, legacy);
		savedSettings(cwd);
		return { migrated: true };
	} catch {
		throw Object.assign(
			new Error(
				'Private integration configuration initialization failed. Check config volume permissions, the retained server encryption key and legacy settings. No credentials were reset.'
			),
			{ code: 'INTEGRATION_CONFIGURATION_INIT_FAILED' }
		);
	}
}

function fallbackEnvironment(env) {
	return startupEnvironments.get(env) ?? env;
}

/** Server-only effective values. An encrypted empty value explicitly disables an environment default. */
export function resolveIntegrationSettings({ env = process.env, cwd = process.cwd() } = {}) {
	const saved = savedSettings(cwd);
	const fallback = fallbackEnvironment(env);
	return Object.fromEntries(
		INTEGRATION_FIELDS.map(({ key }) => [
			key,
			saved.has(key) ? saved.get(key) : (fallback[key] ?? '')
		])
	);
}

/** Capture the original environment once, so later saves/removals never reuse previously applied secrets. */
export function applyIntegrationSettings({ env = process.env, cwd = process.cwd() } = {}) {
	const resolved = resolveIntegrationSettings({ env, cwd });
	if (!startupEnvironments.has(env)) {
		startupEnvironments.set(
			env,
			Object.fromEntries(INTEGRATION_FIELDS.map(({ key }) => [key, env[key]]))
		);
	}
	for (const { key } of INTEGRATION_FIELDS) env[key] = resolved[key];
	return resolved;
}

/** Safe administrator response; never return secrets or ciphertext. Reads create no files or directories. */
export function readIntegrationSettings({ env = process.env, cwd = process.cwd() } = {}) {
	const saved = savedSettings(cwd);
	const fallback = fallbackEnvironment(env);
	let encryptionConfigured = false;
	try {
		assertStorageKey();
		encryptionConfigured = true;
	} catch {
		// Existing environment-only deployments may inspect status before provisioning a master key.
	}
	const fields = Object.fromEntries(
		INTEGRATION_FIELDS.map(({ key, secret }) => {
			const value = saved.has(key) ? saved.get(key) : (fallback[key] ?? '');
			const source = saved.has(key) ? 'admin' : value ? 'environment' : 'unset';
			return [key, { configured: Boolean(value), source, ...(!secret ? { value } : {}) }];
		})
	);
	return { fields, encryptionConfigured };
}

/** Receipt shares the vault's atomic write, so crash retries never overwrite subsequent edits. */
export function integrationRestoreApplied(operationId, { cwd = process.cwd() } = {}) {
	return savedSettings(cwd).restoreOperationId === operationId;
}

/** Atomic partial updates. Empty strings are encrypted overrides, not deletions. Never applies env. */
export function saveIntegrationSettings(
	updates,
	{ env = process.env, cwd = process.cwd(), restoreOperationId } = {}
) {
	let normalized;
	try {
		if (
			!updates ||
			typeof updates !== 'object' ||
			![Object.prototype, null].includes(Object.getPrototypeOf(updates)) ||
			Reflect.ownKeys(updates).some((key) => !keys.has(key))
		)
			throw invalid();
		normalized = Reflect.ownKeys(updates).map((key) => {
			const property = Object.getOwnPropertyDescriptor(updates, key);
			if (!property || !Object.hasOwn(property, 'value')) throw invalid();
			return [key, normalizeIntegrationValue(key, property.value)];
		});
	} catch {
		throw invalid();
	}
	try {
		assertStorageKey();
		// Authenticate the existing file before permitting updates with a different master key.
		const saved = savedSettings(cwd);
		if (restoreOperationId !== undefined && !/^[a-f0-9-]{36}$/.test(restoreOperationId))
			throw invalid();
		if (restoreOperationId && saved.restoreOperationId === restoreOperationId)
			return readIntegrationSettings({ env, cwd });
		for (const [key, value] of normalized) saved.set(key, value);
		const ciphertext = encryptSecret(
			JSON.stringify({
				scope: 'AIRadiologyReport/integrations/v1',
				fields: Object.fromEntries(saved),
				...(restoreOperationId || saved.restoreOperationId
					? { restoreOperationId: restoreOperationId || saved.restoreOperationId }
					: {})
			})
		);
		writeRecord(cwd, { version: 1, ciphertext });
	} catch {
		throw new Error(WRITE_ERROR);
	}
	return readIntegrationSettings({ env, cwd });
}
