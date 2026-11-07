import { createHash } from 'node:crypto';
import { assertStorageKey, encryptSecret, decryptSecret } from './storage-crypto.js';

export const MAX_STORAGE_PARALLEL_CONNECTIONS = 16;

export const DEFAULT_STORAGE_SETTINGS = Object.freeze({
	enabled: false,
	archiveEnabled: false,
	backupsEnabled: false,
	host: '',
	port: 22,
	username: '',
	root: '',
	fingerprint: '',
	localRetentionDays: 30,
	databaseIntervalHours: 1,
	fileBackupHour: 2,
	fullBackupHours: Object.freeze([0, 12]),
	integrityAuditDays: 7,
	parallelConnections: 4,
	hourlyRetention: 48,
	dailyRetention: 30,
	monthlyRetention: 12,
	uploadTimeoutSeconds: 30,
	verificationTimeoutSeconds: 20
});
const fields = Object.keys(DEFAULT_STORAGE_SETTINGS);
const limits = {
	port: [1, 65535],
	localRetentionDays: [1, 3650],
	databaseIntervalHours: [1, 168],
	fileBackupHour: [0, 23],
	integrityAuditDays: [1, 365],
	parallelConnections: [1, MAX_STORAGE_PARALLEL_CONNECTIONS],
	hourlyRetention: [1, 8760],
	dailyRetention: [1, 3650],
	monthlyRetention: [1, 120],
	uploadTimeoutSeconds: [1, 600],
	verificationTimeoutSeconds: [1, 600]
};

export function storageParallelConnections(settings) {
	const value =
		settings?.parallelConnections === undefined
			? DEFAULT_STORAGE_SETTINGS.parallelConnections
			: settings.parallelConnections;
	if (!Number.isInteger(value) || value < 1 || value > MAX_STORAGE_PARALLEL_CONNECTIONS)
		throw new Error('Choose 1–16 parallel storage connections.');
	return value;
}

export function storageTimeoutMs(settings, field) {
	if (!['uploadTimeoutSeconds', 'verificationTimeoutSeconds'].includes(field))
		throw new Error('Invalid storage inactivity timeout.');
	const seconds =
		settings?.[field] === undefined ? DEFAULT_STORAGE_SETTINGS[field] : settings[field];
	const [min, max] = limits[field];
	if (!Number.isInteger(seconds) || seconds < min || seconds > max)
		throw new Error('Invalid storage inactivity timeout.');
	return seconds * 1000;
}

export function normalizeStorageSettings(value) {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !fields.includes(key))
	)
		throw new Error('Invalid storage settings.');
	const settings = { ...DEFAULT_STORAGE_SETTINGS, ...value };
	const hours = Object.hasOwn(value, 'fullBackupHours')
		? value.fullBackupHours
		: Object.hasOwn(value, 'fileBackupHour')
			? [value.fileBackupHour]
			: DEFAULT_STORAGE_SETTINGS.fullBackupHours;
	if (
		!Array.isArray(hours) ||
		hours.length < 1 ||
		hours.length > 24 ||
		!Array.from(hours).every((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23) ||
		new Set(hours).size !== hours.length
	)
		throw new Error('Choose 1–24 unique UTC full backup hours from 0 to 23.');
	settings.fullBackupHours = [...hours].sort((a, b) => a - b);
	for (const field of ['enabled', 'archiveEnabled', 'backupsEnabled'])
		if (typeof settings[field] !== 'boolean') throw new Error('Invalid storage switch.');
	for (const [key, [min, max]] of Object.entries(limits))
		if (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max)
			throw new Error('Invalid storage connection limit, timeout, backup period or retention.');
	for (const field of ['host', 'username', 'root', 'fingerprint'])
		if (
			typeof settings[field] !== 'string' ||
			settings[field].length > 512 ||
			[...settings[field]].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
		)
			throw new Error('Invalid storage connection information.');
	if (settings.host && !/^[a-zA-Z0-9.:_-]+$/.test(settings.host))
		throw new Error('Enter a hostname or IP address, without a URL.');
	if (
		settings.root &&
		(!settings.root.startsWith('/') ||
			settings.root === '/' ||
			settings.root.includes('\\') ||
			settings.root.split('/').some((part) => part === '.' || part === '..'))
	)
		throw new Error('Choose a dedicated absolute remote folder, not the server root.');
	settings.root = settings.root.replace(/\/+$/, '');
	if (settings.fingerprint && !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(settings.fingerprint))
		throw new Error('Enter a SHA256 SSH host fingerprint.');
	settings.fingerprint = settings.fingerprint.replace(/=$/, '');
	if (
		settings.enabled &&
		(!settings.host || !settings.username || !settings.root || !settings.fingerprint)
	)
		throw new Error('Complete the storage connection and verified host fingerprint first.');
	return settings;
}

export function storageDestination(connection) {
	return createHash('sha256')
		.update(
			JSON.stringify([
				connection.host.toLowerCase(),
				connection.port,
				connection.username,
				connection.root,
				connection.fingerprint
			])
		)
		.digest('hex');
}

export function getStorageSettings(db) {
	const row = db
		.prepare("SELECT value FROM application_settings WHERE key = 'storage_settings'")
		.get();
	if (!row) return normalizeStorageSettings({});
	try {
		return normalizeStorageSettings(JSON.parse(row.value));
	} catch {
		throw new Error('Saved storage settings are invalid. Storage jobs are paused until repaired.');
	}
}

export function storagePasswordConfigured(db) {
	return Boolean(
		db.prepare("SELECT value FROM application_settings WHERE key = 'storage_password'").get()?.value
	);
}

export function getStorageConnection(db) {
	const settings = getStorageSettings(db);
	const row = db
		.prepare("SELECT value FROM application_settings WHERE key = 'storage_password'")
		.get();
	if (!row) throw new Error('Save a storage password first.');
	assertStorageKey();
	return { ...settings, password: decryptSecret(row.value) };
}

export function saveStorageSettings(db, input, password = '') {
	const settings = normalizeStorageSettings(input);
	if (typeof password !== 'string' || password.length > 4096 || password.includes('\0'))
		throw new Error('Invalid storage password.');
	assertStorageKey();
	return db.transaction(() => {
		const existing = getStorageSettings(db);
		if (
			db
				.prepare(
					`SELECT 1 FROM storage_reset_requests r JOIN storage_jobs j ON j.id=r.job_id
			WHERE j.status IN ('pending','running') OR (j.status='failed' AND j.attempts<8) LIMIT 1`
				)
				.get()
		)
			throw new Error('Wait for the storage reset to finish before changing settings.');
		const syncedFilesInUse = ['storage_file_objects', 'storage_file_catalog'].some(
			(table) =>
				db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) &&
				db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
		);
		const inUse =
			syncedFilesInUse ||
			db.prepare('SELECT 1 FROM storage_audio LIMIT 1').get() ||
			db
				.prepare(
					"SELECT 1 FROM storage_jobs WHERE status = 'succeeded' AND kind IN ('database','full') LIMIT 1"
				)
				.get();
		if (inUse && storageDestination(existing) !== storageDestination(settings))
			throw new Error(
				'Storage destination is in use. Migrate synchronized files, archived audio and recovery backups before changing it. Password and schedules can still be changed.'
			);
		if (db.prepare("SELECT 1 FROM storage_jobs WHERE status = 'running' LIMIT 1").get())
			throw new Error('Wait for the running storage job before changing settings.');
		if (settings.enabled && !password && !storagePasswordConfigured(db))
			throw new Error('Enter a storage password before enabling jobs.');
		const put = db.prepare(
			'INSERT INTO application_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
		);
		if (password) put.run('storage_password', encryptSecret(password));
		put.run('storage_settings', JSON.stringify(settings));
		return settings;
	})();
}
