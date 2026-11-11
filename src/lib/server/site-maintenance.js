import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withIntegrationConfigurationLock } from './integration-coordination.js';
import { applyPendingIntegrationRestore } from './integration-backup.js';
import {
	snapshotTelegramMaintenance,
	lockTelegramMaintenance,
	unlockTelegramMaintenance,
	notifyTelegramMaintenance
} from './maintenance-telegram.js';

const PHASES = new Set(['off', 'enabling', 'enabled', 'disabling', 'error']);
const TELEGRAM_STATES = new Set(['disabled', 'pending', 'locked', 'error']);
const STATE_ERROR = 'Maintenance state needs administrator investigation. Service remains closed.';
const TELEGRAM_ERROR = 'Telegram permissions could not be updated. Maintenance remains enabled; check bot administrator permissions and retry.';

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
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(STATE_ERROR);
}

function syncDirectory(directory) {
	if (process.platform === 'win32') return;
	const fd = fs.openSync(directory, 'r');
	try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function validRecord(record) {
	if (!record || record.version !== 1 || typeof record.enabled !== 'boolean' ||
		!PHASES.has(record.phase) || !TELEGRAM_STATES.has(record.telegram?.status) ||
		typeof record.telegram.lockAttempted !== 'boolean' ||
		!Number.isSafeInteger(record.requestedBy) || record.requestedBy < 1 ||
		typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) return false;
	const snapshot = record.telegram.snapshot;
	if (snapshot !== null && (!snapshot || !['string', 'number'].includes(typeof snapshot.chatId) ||
		!/^-[1-9][0-9]*$/.test(String(snapshot.chatId)) ||
		!snapshot.permissions || typeof snapshot.permissions !== 'object' || Array.isArray(snapshot.permissions) ||
		Object.keys(snapshot.permissions).length > 32 ||
		Object.entries(snapshot.permissions).some(([key, value]) => !/^[a-z_]{1,64}$/.test(key) || typeof value !== 'boolean'))) return false;
	if (!record.enabled && (record.phase !== 'off' || record.telegram.status !== 'disabled' || record.telegram.lockAttempted || snapshot !== null)) return false;
	if (record.enabled && record.phase === 'off') return false;
	if (record.telegram.lockAttempted !== (snapshot !== null)) return false;
	if (snapshot !== null && record.telegram.status === 'disabled') return false;
	if (snapshot === null && !['disabled', 'error'].includes(record.telegram.status)) return false;
	if (record.phase === 'error' && record.telegram.status !== 'error') return false;
	return true;
}

export function createSiteMaintenance({
	cwd = process.cwd(), env = process.env,
	snapshot = snapshotTelegramMaintenance, lock = lockTelegramMaintenance,
	unlock = unlockTelegramMaintenance, notify = notifyTelegramMaintenance,
	afterUnlock = async () => {}
} = {}) {
	const directory = path.resolve(cwd, 'restore-staging', '.maintenance');
	const filename = path.join(directory, 'state.json');
	let serial = Promise.resolve();
	function read() {
		directorySafe(directory);
		let stat;
		try { stat = fs.lstatSync(filename); }
		catch (error) { if (error.code === 'ENOENT') return null; throw error; }
		if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error(STATE_ERROR);
		const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
		if (!validRecord(record)) throw new Error(STATE_ERROR);
		return record;
	}
	function write(record) {
		if (!validRecord(record)) throw new Error(STATE_ERROR);
		directorySafe(directory, true);
		const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
		let fd;
		try {
			fd = fs.openSync(temporary, 'wx', 0o600);
			fs.writeFileSync(fd, JSON.stringify(record));
			fs.fsyncSync(fd);
			fs.closeSync(fd);
			fd = undefined;
			fs.renameSync(temporary, filename);
			syncDirectory(directory);
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
			fs.rmSync(temporary, { force: true });
		}
	}
	function status() {
		try {
			const record = read();
			if (!record) return { enabled: false, phase: 'off', telegram: 'disabled' };
			return { enabled: record.enabled, phase: record.phase, telegram: record.telegram.status,
				updatedAt: record.updatedAt, requestedBy: record.requestedBy,
				...(record.phase === 'error' ? { error: TELEGRAM_ERROR } : {}) };
		} catch { return { enabled: true, phase: 'error', telegram: 'error', error: STATE_ERROR }; }
	}
	async function notice(record, enabled) {
		if (!record.telegram.snapshot) return;
		try { await notify(record.telegram.snapshot, { env, enabled }); }
		catch { console.warn('Telegram maintenance notice could not be delivered.'); }
	}
	async function setNow({ enabled, userId }) {
		if (typeof enabled !== 'boolean' || !Number.isSafeInteger(userId) || userId < 1) throw new Error('Administrator confirmation required.');
		let record;
		try { record = read(); } catch { throw new Error(STATE_ERROR); }
		if (!enabled && !record?.enabled) return status();
		if (enabled && record?.phase === 'enabled' &&
			(record.telegram.status === 'locked' || (record.telegram.status === 'disabled' && !env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_CHAT_ID))) return status();
		if (enabled) {
			const saved = record?.telegram.snapshot || await snapshot({ env });
			record = { version: 1, enabled: true, phase: 'enabling', updatedAt: new Date().toISOString(), requestedBy: userId,
				telegram: { snapshot: saved, status: saved ? 'pending' : 'disabled', lockAttempted: Boolean(saved) } };
			write(record);
			try {
				if (saved) await lock(saved, { env });
				record.phase = 'enabled';
				record.telegram.status = saved ? 'locked' : 'disabled';
				write(record);
			} catch {
				record.phase = 'error';
				record.telegram.status = 'error';
				write(record);
				throw new Error(TELEGRAM_ERROR);
			}
			await notice(record, true);
		} else {
			record.phase = 'disabling';
			record.updatedAt = new Date().toISOString();
			record.requestedBy = userId;
			write(record);
			try {
				if (record.telegram.lockAttempted) await unlock(record.telegram.snapshot, { env });
			} catch {
				record.phase = 'error';
				record.telegram.status = 'error';
				write(record);
				throw new Error(TELEGRAM_ERROR);
			}
			const previous = structuredClone(record);
			const originalToken = env.TELEGRAM_BOT_TOKEN;
			const originalChat = env.TELEGRAM_CHAT_ID;
			// Persist the completed unlock BEFORE restored credentials may replace the original bot.
			record.telegram = { snapshot: null, status: 'disabled', lockAttempted: false };
			write(record);
			try { await afterUnlock({ cwd, env }); }
			catch {
				record.phase = 'error';
				record.telegram.status = 'error';
				write(record);
				throw new Error('Integration restore could not be completed. Maintenance remains enabled; retry reopening maintenance.');
			}
			write({ version: 1, enabled: false, phase: 'off', updatedAt: new Date().toISOString(), requestedBy: userId,
				telegram: { snapshot: null, status: 'disabled', lockAttempted: false } });
			if (env.TELEGRAM_BOT_TOKEN === originalToken && env.TELEGRAM_CHAT_ID === originalChat) await notice(previous, false);
		}
		return status();
	}
	return {
		status,
		context() { try { return read()?.telegram.snapshot || null; } catch { return null; } },
		set(options) {
			const operation = serial.then(() => setNow(options));
			serial = operation.catch(() => {});
			return operation;
		}
	};
}

const siteMaintenance = createSiteMaintenance({ afterUnlock: applyPendingIntegrationRestore });
export const siteMaintenanceStatus = () => siteMaintenance.status();
export const isSiteMaintenanceEnabled = () => siteMaintenance.status().enabled;
export const maintenanceTelegramContext = () => siteMaintenance.context();
export const setSiteMaintenance = (options) => withIntegrationConfigurationLock(() => siteMaintenance.set(options));
