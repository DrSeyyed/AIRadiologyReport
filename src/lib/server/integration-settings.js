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

function normalize(key, value) {
	const field = INTEGRATION_FIELDS.find((field) => field.key === key);
	if (
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

function location(cwd) {
	// Deployment configuration intentionally lives outside the restored application database.
	const directory = path.resolve(cwd, 'restore-staging', '.integrations');
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

function fileSafe(stat) {
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.nlink !== 1 ||
		stat.size > 65536 ||
		(process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
	)
		throw new Error(READ_ERROR);
}

function readRecord(cwd) {
	const { directory, filename } = location(cwd);
	directorySafe(directory);
	if (process.platform !== 'win32') {
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
	fileSafe(stat);
	const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const opened = fs.fstatSync(fd);
		fileSafe(opened);
		if (stat.ino !== opened.ino || stat.dev !== opened.dev) throw new Error(READ_ERROR);
		return JSON.parse(fs.readFileSync(fd, 'utf8'));
	} finally {
		fs.closeSync(fd);
	}
}

function savedSettings(cwd) {
	try {
		const record = readRecord(cwd);
		if (record === undefined) return new Map();
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
			Object.keys(payload).length !== 2 ||
			!payload.fields ||
			typeof payload.fields !== 'object' ||
			Array.isArray(payload.fields) ||
			Object.keys(payload.fields).some((key) => !keys.has(key))
		)
			throw invalid();
		const saved = new Map();
		for (const [key, value] of Object.entries(payload.fields)) {
			saved.set(key, normalize(key, value));
		}
		return saved;
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

/** Atomic partial updates. Empty strings are encrypted overrides, not deletions. Never applies env. */
export function saveIntegrationSettings(updates, { env = process.env, cwd = process.cwd() } = {}) {
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
			return [key, normalize(key, property.value)];
		});
	} catch {
		throw invalid();
	}
	try {
		assertStorageKey();
		// Authenticate the existing file before permitting updates with a different master key.
		const saved = savedSettings(cwd);
		for (const [key, value] of normalized) saved.set(key, value);
		const ciphertext = encryptSecret(
			JSON.stringify({
				scope: 'AIRadiologyReport/integrations/v1',
				fields: Object.fromEntries(saved)
			})
		);
		writeRecord(cwd, { version: 1, ciphertext });
	} catch {
		throw new Error(WRITE_ERROR);
	}
	return readIntegrationSettings({ env, cwd });
}
