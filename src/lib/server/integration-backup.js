import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { encryptSecret, decryptSecret } from './storage-crypto.js';
import { INTEGRATION_FIELDS, normalizeIntegrationValue, resolveIntegrationSettings, saveIntegrationSettings,
	applyIntegrationSettings, integrationRestoreApplied } from './integration-settings.js';
import { createWebhookRegistration } from './integration-webhook.js';
import { getDb } from './db.js';

const ERROR = 'Integration restore could not be completed. Keep maintenance enabled, check the retained encryption key and integration configuration, then retry reopening maintenance.';
const SNAPSHOT = 'AIRadiologyReport/integration-backup/v1';
const PLAN = 'AIRadiologyReport/integration-restore/v1';
const LIMIT = 65536;
const KEYS = INTEGRATION_FIELDS.map(({ key }) => key);
const TELEGRAM = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_WEBHOOK_BASE_URL'];
const fail = () => { throw new Error(ERROR); };
const backupValid = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value);
function exact(value, keys) {
	if (!value || typeof value !== 'object' || Array.isArray(value) ||
		Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) fail();
}
function parse(text) {
	if (typeof text !== 'string' || Buffer.byteLength(text) > LIMIT) fail();
	const value = JSON.parse(text);
	// Records are canonical JSON; this also rejects duplicate or escaped duplicate property names.
	if (JSON.stringify(value) !== text) fail();
	return value;
}
function values(fields, keys = KEYS) {
	exact(fields, keys);
	return Object.fromEntries(keys.map(key => {
		const value = normalizeIntegrationValue(key, fields[key]);
		if (value !== fields[key]) fail();
		return [key, value];
	}));
}
function selected(fields) {
	if (!Array.isArray(fields) || fields.length > KEYS.length || new Set(fields).size !== fields.length || fields.some(key => !KEYS.includes(key))) fail();
	return [...fields];
}
function seal(payload, encrypt = encryptSecret) {
	const ciphertext = encrypt(JSON.stringify(payload));
	if (typeof ciphertext !== 'string' || !ciphertext || ciphertext.length > LIMIT / 1.1) fail();
	return JSON.stringify({ version: 1, ciphertext });
}
function unseal(text, decrypt = decryptSecret) {
	const record = parse(text);
	exact(record, ['version', 'ciphertext']);
	if (record.version !== 1 || typeof record.ciphertext !== 'string' || !record.ciphertext) fail();
	return parse(decrypt(record.ciphertext));
}
function guarded(operation) { try { return operation(); } catch { fail(); } }

export function exportIntegrationBackup({ backupId, cwd = process.cwd(), env = process.env, encrypt = encryptSecret }) {
	return guarded(() => {
		if (!backupValid(backupId)) fail();
		const effective = resolveIntegrationSettings({ cwd, env });
		const fields = Object.fromEntries(KEYS.map(key => [key, normalizeIntegrationValue(key, effective[key])]));
		return seal({ scope: SNAPSHOT, backupId, fields }, encrypt);
	});
}
export function readIntegrationBackup(serialized, { backupId, decrypt = decryptSecret }) {
	return guarded(() => {
		const payload = unseal(serialized, decrypt);
		exact(payload, ['scope', 'backupId', 'fields']);
		if (!backupValid(backupId) || payload.backupId !== backupId || payload.scope !== SNAPSHOT) fail();
		return values(payload.fields);
	});
}
function syncDirectory(directory) {
	if (process.platform === 'win32') return;
	const fd = fs.openSync(directory, 'r');
	try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function directorySafe(directory, create = false) {
	const parent = path.dirname(directory);
	if (parent !== directory) directorySafe(parent, create);
	let stat;
	try { stat = fs.lstatSync(directory); }
	catch (error) {
		if (error.code !== 'ENOENT') throw error;
		if (!create) return;
		fs.mkdirSync(directory, { mode: 0o700 });
		syncDirectory(parent);
		stat = fs.lstatSync(directory);
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
}
function fileSafe(stat) {
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > LIMIT ||
		(process.platform !== 'win32' && (stat.mode & 0o077))) fail();
}
function readFile(filename) {
	directorySafe(path.dirname(filename));
	let stat;
	try { stat = fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
	fileSafe(stat);
	const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const opened = fs.fstatSync(fd);
		fileSafe(opened);
		if (opened.ino !== stat.ino || opened.dev !== stat.dev) fail();
		return fs.readFileSync(fd, 'utf8');
	} finally { fs.closeSync(fd); }
}
function remove(filename) {
	if (readFile(filename) === undefined) return;
	fs.unlinkSync(filename);
	syncDirectory(path.dirname(filename));
}
function writeFile(filename, text) {
	if (Buffer.byteLength(text) > LIMIT) fail();
	const directory = path.dirname(filename);
	directorySafe(directory, true);
	readFile(filename);
	const temporary = path.join(directory, `.integration-${randomUUID()}.pending`);
	let fd;
	try {
		fd = fs.openSync(temporary, 'wx', 0o600);
		fs.fchmodSync(fd, 0o600);
		fs.writeFileSync(fd, text);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		directorySafe(directory);
		readFile(filename);
		fs.renameSync(temporary, filename);
		syncDirectory(directory);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		fs.rmSync(temporary, { force: true });
	}
}
function snapshot(directory, backupId) {
	const text = readFile(path.resolve(directory, 'integration-settings.json'));
	return text === undefined ? undefined : readIntegrationBackup(text, { backupId });
}
export function integrationRestoreFields(directory, { backupId }) {
	return guarded(() => {
		if (!backupValid(backupId)) fail();
		const fields = snapshot(directory, backupId);
		return fields ? INTEGRATION_FIELDS.map(({ key, label }) => ({ key, label, configured: Boolean(fields[key]) })) : [];
	});
}
export function stageIntegrationRestore(directory, { backupId, fields }) {
	return guarded(() => {
		if (!backupValid(backupId)) fail();
		const keys = selected(fields);
		const filename = path.resolve(directory, 'db', 'integration-restore.json');
		if (!keys.length) { remove(filename); return; }
		const current = snapshot(directory, backupId);
		if (!current) fail();
		writeFile(filename, seal({ scope: PLAN, backupId, operationId: randomUUID(), fields: keys,
			values: Object.fromEntries(keys.map(key => [key, current[key]])), phase: 'pending', previous: null }));
	});
}
function pending(cwd, decrypt = decryptSecret) {
	const filename = path.resolve(cwd, 'db', 'integration-restore.json');
	const text = readFile(filename);
	if (text === undefined) return null;
	const plan = unseal(text, decrypt);
	exact(plan, ['scope', 'backupId', 'operationId', 'fields', 'values', 'phase', 'previous']);
	if (plan.scope !== PLAN || !backupValid(plan.backupId) || !/^[a-f0-9-]{36}$/.test(plan.operationId) ||
		!['pending', 'cleanup', 'ready', 'applied'].includes(plan.phase)) fail();
	const keys = selected(plan.fields);
	if (!keys.length) fail();
	values(plan.values, keys);
	if (plan.phase === 'pending') { if (plan.previous !== null) fail(); }
	else values(plan.previous, TELEGRAM);
	return { filename, plan };
}
export function pendingIntegrationRestoreStatus({ cwd = process.cwd() } = {}) {
	return guarded(() => {
		const value = pending(cwd);
		return value ? { pending: true, fields: value.plan.fields, backupId: value.plan.backupId } : { pending: false, fields: [] };
	});
}

/** Caller holds the shared integration lock. Discard never rolls back or changes live credentials. */
export function discardPendingIntegrationRestore({ cwd = process.cwd(), allowApplied = false } = {}) {
	let item;
	let applied;
	try {
		if (typeof allowApplied !== 'boolean') fail();
		item = pending(cwd);
		if (!item) return { discarded: false, applied: false, fields: [] };
		applied = integrationRestoreApplied(item.plan.operationId, { cwd });
	} catch { fail(); }
	if (applied && !allowApplied) {
		throw Object.assign(new Error('Restored integration settings have already been saved. Explicitly acknowledge keeping the applied settings before discarding their pending webhook retry.'),
			{ code: 'INTEGRATION_RESTORE_ALREADY_APPLIED' });
	}
	return guarded(() => {
		remove(item.filename);
		return { discarded: true, applied, fields: item.plan.fields };
	});
}

/** Caller holds the shared integration lock and has durably cleared the original group lock journal. */
export async function applyPendingIntegrationRestore({ cwd = process.cwd(), env = process.env,
	getDatabase = getDb, webhook = createWebhookRegistration, request = fetch,
	resolveSettings = resolveIntegrationSettings, saveSettings = saveIntegrationSettings,
	applySettings = applyIntegrationSettings, restoreApplied = integrationRestoreApplied,
	encrypt = encryptSecret, decrypt = decryptSecret } = {}) {
	try {
		const item = pending(cwd, decrypt);
		if (!item) return { pending: false, fields: [] };
		const { filename, plan } = item;
		const options = { cwd, env };
		const persist = () => writeFile(filename, seal(plan, encrypt));
		const relevant = plan.fields.some(key => TELEGRAM.includes(key));
		const registration = (configuration) => webhook({ db: getDatabase(), env: configuration, request });
		if (plan.phase === 'pending') {
			const current = resolveSettings(options);
			plan.previous = Object.fromEntries(TELEGRAM.map(key => [key, normalizeIntegrationValue(key, current[key])]));
			plan.phase = 'cleanup';
			persist();
		}
		if (plan.phase === 'cleanup') {
			const effective = { ...plan.previous, ...plan.values };
			if (relevant && effective.TELEGRAM_BOT_TOKEN && effective.TELEGRAM_WEBHOOK_BASE_URL &&
				!effective.TELEGRAM_WEBHOOK_SECRET &&
				!(plan.fields.includes('TELEGRAM_WEBHOOK_SECRET') && plan.values.TELEGRAM_WEBHOOK_SECRET === '')) fail();
			if (relevant && plan.previous.TELEGRAM_BOT_TOKEN &&
				(effective.TELEGRAM_BOT_TOKEN !== plan.previous.TELEGRAM_BOT_TOKEN ||
				!effective.TELEGRAM_WEBHOOK_BASE_URL || !effective.TELEGRAM_WEBHOOK_SECRET)) {
				await registration(plan.previous).remove();
			}
			plan.phase = 'ready';
			persist();
		}
		if (!restoreApplied(plan.operationId, options)) {
			saveSettings(plan.values, { ...options, restoreOperationId: plan.operationId });
		}
		applySettings(options);
		plan.phase = 'applied';
		persist();
		if (relevant && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_BASE_URL && env.TELEGRAM_WEBHOOK_SECRET) {
			await registration(env).register();
		}
		remove(filename);
		return { pending: false, fields: [] };
	} catch { fail(); }
}
