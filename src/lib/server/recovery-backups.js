import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Self-contained, encrypted recovery snapshots (v1). No dependency on an earlier full backup.
 * Database backups include every snapshot-referenced audio/report; full backups also walk uploads
 * and include EVERY storage_audio row captured by the SQLite snapshot, even unreferenced archives.
 * Archive plaintext, encrypted remote bytes, and live archive metadata are rechecked at publication.
 * Full publication rejects new live archive rows with archived_at <= now that were not captured.
 * options.owned is an optional sync/async boolean lease callback; false/throw aborts publication.
 * Parent must maintain/renew the lease across the final SFTP rename and recording job success.
 * A later archive version created after completion in the SAME Unix second must not inherit that
 * backup's coverage: eviction needs unchanged archive identity or a strict earlier-than fence.
 * Custom VOICE_SAVE_DIR is the only additional allowed root and restores under voice/.
 * Restored recording paths are app-root-relative (even originally absolute ones), so db/uploads/
 * voice may be promoted together. storage_audio rows are deleted: no source-archive dependency.
 * Restores disable storage/archive/backups, delete storage job history and worker leases, and
 * preserve connection settings/encrypted credentials for explicit operator review before enabling.
 * .env and environment.json contain ONLY APP_ENV_KEYS, never provider credentials or the storage key.
 * Retention deletes completed indexes/manifests only. Shared objects are intentionally retained:
 * safe reference-counted garbage collection is not implemented, so pruning does not reclaim objects.
 * Inject transport/crypto functions as the fourth argument for offline testing. Local options:
 * cwd, voiceSaveDir, env, destination. now is Unix seconds. Errors never include source paths.
 */
export const APP_ENV_KEYS = Object.freeze([
	'NODE_ENV',
	'ORIGIN',
	'HOST',
	'PORT',
	'PROTOCOL_HEADER',
	'HOST_HEADER',
	'ADDRESS_HEADER',
	'XFF_DEPTH',
	'BODY_SIZE_LIMIT',
	'VOICE_SAVE_DIR',
	'TZ'
]);
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^\d+-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const INDEX = /^(\d+-[a-f0-9-]{36})\.(database|full)\.json$/;
const ARCHIVE_FIELDS = [
	'path',
	'object_key',
	'sha256',
	'remote_sha256',
	'bytes',
	'archived_at',
	'evicted_at',
	'destination'
];
const REFERENCES = [
	['recording_audio_parts', 'audio_report_path', 'audio'],
	['study_recordings', 'audio_report_path', 'audio'],
	['study_recordings', 'text_report_path', 'report']
];

export function recoveryDestination(connection) {
	return createHash('sha256')
		.update(
			JSON.stringify([
				connection.host.toLowerCase(),
				Number(connection.port || 22),
				connection.username,
				connection.root,
				connection.fingerprint
			])
		)
		.digest('hex');
}

async function dependencies(injected = {}, remote = true) {
	const crypto =
		injected.encryptFile && injected.decryptFile && injected.assertStorageKey
			? injected
			: await import('./storage-crypto.js');
	const transport =
		!remote || (injected.withStorage && injected.storagePath && injected.hashRemote)
			? {}
			: await import('./storage-transport.js');
	return { ...crypto, ...transport, ...injected };
}

async function sha256(file) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest('hex');
}

function safeRelative(value) {
	if (
		typeof value !== 'string' ||
		!value ||
		/[\\<>:"|?*]/.test(value) ||
		Array.from(value).some((character) => character.charCodeAt(0) < 32) ||
		value.startsWith('/') ||
		value
			.split('/')
			.some(
				(s) => !s || /[. ]$/.test(s) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)
			)
	) {
		throw new Error('Invalid recovery path.');
	}
	return value;
}

function within(root, file) {
	const relative = path.relative(root, file);
	return (
		relative &&
		relative !== '..' &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

async function noLinks(file, allowMissing = false) {
	const absolute = path.resolve(file);
	const parsed = path.parse(absolute);
	let current = parsed.root;
	for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Unsafe recovery source.');
		} catch (error) {
			if (allowMissing && error.code === 'ENOENT') return;
			throw error;
		}
	}
}

async function workDirectory(cwd) {
	await noLinks(cwd);
	const directory = path.join(cwd, `.recovery-work-${randomUUID()}`);
	await fs.mkdir(directory, { mode: 0o700 });
	return directory;
}

async function cleanupRecovery(database, work) {
	let failed = false;
	try {
		if (database) database.close();
	} catch {
		failed = true;
	}
	try {
		if (work) await fs.rm(work, { recursive: true, force: true });
	} catch {
		failed = true;
	}
	if (failed) throw new Error('Recovery cleanup failed.');
}

function hasColumn(db, table, column) {
	return db
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.some((row) => row.name === column);
}

function pauseRestoredStorage(db) {
	if (
		hasColumn(db, 'application_settings', 'key') &&
		hasColumn(db, 'application_settings', 'value')
	) {
		const row = db
			.prepare("SELECT value FROM application_settings WHERE key = 'storage_settings'")
			.get();
		const settings = row ? JSON.parse(row.value) : {};
		if (!settings || typeof settings !== 'object' || Array.isArray(settings))
			throw new Error('Invalid storage settings.');
		settings.enabled = false;
		settings.archiveEnabled = false;
		settings.backupsEnabled = false;
		db.prepare(
			'INSERT INTO application_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
		).run('storage_settings', JSON.stringify(settings));
	}
	for (const table of [
		'storage_job_cancellations',
		'storage_restore_requests',
		'storage_jobs',
		'storage_worker_lock'
	]) {
		if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
			db.prepare(`DELETE FROM ${table}`).run();
		}
	}
}

function archiveRows(db) {
	return hasColumn(db, 'storage_audio', 'path')
		? db.prepare('SELECT * FROM storage_audio').all()
		: [];
}

function archiveIdentity(row) {
	return JSON.stringify(ARCHIVE_FIELDS.map((field) => row[field]));
}

function validateArchive(row, destination) {
	if (
		row.destination !== destination ||
		!DIGEST.test(row.sha256) ||
		!DIGEST.test(row.remote_sha256) ||
		!Number.isSafeInteger(row.bytes) ||
		row.bytes < 0 ||
		!Number.isSafeInteger(row.archived_at) ||
		!/^[a-f0-9-]{36}\.enc$/.test(row.object_key)
	)
		throw new Error('Invalid recovery archive.');
}

function referencedFiles(db) {
	const files = new Map();
	for (const [table, column, role] of REFERENCES) {
		if (!hasColumn(db, table, column)) continue;
		for (const row of db
			.prepare(
				`SELECT DISTINCT ${column} AS file FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`
			)
			.all()) {
			if (!files.has(row.file)) files.set(row.file, role);
		}
	}
	return files;
}

async function walk(directory) {
	await noLinks(directory, true);
	let entries;
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error.code === 'ENOENT') return [];
		throw error;
	}
	const files = [];
	for (const entry of entries) {
		const file = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error('Unsafe recovery source.');
		if (entry.isDirectory()) files.push(...(await walk(file)));
		else if (entry.isFile()) files.push(file);
		else throw new Error('Unsafe recovery source.');
	}
	return files;
}

function sameFileState(a, b) {
	return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.ino === b.ino;
}

async function copyStable(source, target, initial) {
	await noLinks(source);
	const before = await fs.stat(source, { bigint: true });
	if (!before.isFile() || (initial && !sameFileState(initial, before)))
		throw new Error('Unsafe recovery source.');
	await fs.copyFile(source, target);
	await fs.chmod(target, 0o600);
	const digest = await sha256(target);
	const after = await fs.stat(source, { bigint: true });
	if (!sameFileState(before, after) || digest !== (await sha256(source)))
		throw new Error('Recovery source changed.');
	await noLinks(source);
	return { sha256: digest, bytes: Number(before.size) };
}

function closingQuote(value, quote, start = 0) {
	for (let i = start; i < value.length; i++) {
		if (value[i] === '\\' && quote === '"') i++;
		else if (value[i] === quote) return i;
	}
	return -1;
}

function filteredEnvironment(content) {
	const result = {};
	let multilineQuote;
	for (const line of content.split(/\r?\n/)) {
		if (multilineQuote) {
			if (closingQuote(line, multilineQuote) !== -1) multilineQuote = undefined;
			continue;
		}
		const match = /^\s*(?:export\s+)?([A-Z_][A-Z_0-9]*)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		let value = match[2].trim();
		if (value.startsWith('"') || value.startsWith("'")) {
			const quote = value[0];
			const end = closingQuote(value, quote, 1);
			if (end === -1) {
				multilineQuote = quote;
				continue;
			}
			if (!/^\s*(?:#.*)?$/.test(value.slice(end + 1))) continue;
			const quoted = value.slice(0, end + 1);
			value = value.slice(1, end);
			if (quote === '"') {
				try {
					value = JSON.parse(quoted);
				} catch {
					/* Ordinary dotenv quoting is also accepted. */
				}
			}
		} else value = value.split('#')[0].trim();
		if (APP_ENV_KEYS.includes(match[1])) result[match[1]] = value;
	}
	return result;
}

function serializeEnvironment(values) {
	return (
		Object.entries(values)
			.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
			.join('\n') + '\n'
	);
}

function validateManifest(manifest) {
	if (
		manifest?.version !== 1 ||
		!ID.test(manifest.id) ||
		!['full', 'database'].includes(manifest.kind) ||
		!Number.isSafeInteger(manifest.createdAt) ||
		!Array.isArray(manifest.files) ||
		!Array.isArray(manifest.references)
	) {
		throw new Error('Invalid recovery manifest.');
	}
	if (
		manifest.voiceDirectory !== undefined &&
		!(
			manifest.voiceDirectory === 'voice' ||
			manifest.voiceDirectory === 'uploads' ||
			manifest.voiceDirectory.startsWith('uploads/')
		)
	)
		throw new Error('Invalid recovery voice root.');
	if (manifest.voiceDirectory !== undefined) safeRelative(manifest.voiceDirectory);
	const paths = new Set();
	const canonicalPaths = new Set();
	let databases = 0;
	for (const entry of manifest.files) {
		safeRelative(entry.path);
		if (
			canonicalPaths.has(entry.path.toLowerCase()) ||
			!DIGEST.test(entry.sha256) ||
			!DIGEST.test(entry.remoteSha256) ||
			entry.object !== `${entry.remoteSha256}.enc` ||
			!Number.isSafeInteger(entry.bytes) ||
			entry.bytes < 0
		) {
			throw new Error('Invalid recovery manifest.');
		}
		paths.add(entry.path);
		canonicalPaths.add(entry.path.toLowerCase());
		if (entry.role === 'database') {
			if (entry.path !== 'db/pacs.db') throw new Error('Invalid recovery database.');
			databases++;
		} else if (!(
			entry.path.startsWith('uploads/') ||
			entry.path.startsWith('voice/') ||
			entry.path === '.env' ||
			entry.path === 'environment.json'
		))
			throw new Error('Invalid recovery path.');
	}
	if (databases !== 1) throw new Error('Invalid recovery database.');
	for (const reference of manifest.references) {
		if (typeof reference.original !== 'string' || !paths.has(reference.path))
			throw new Error('Invalid recovery reference.');
	}
	return manifest;
}

export { validateManifest as validateRecoveryManifest };

async function readManifest(client, connection, snapshot, work, deps) {
	const encrypted = path.join(work, `${randomUUID()}.enc`);
	const plain = path.join(work, `${randomUUID()}.json`);
	try {
		await client.get(
			deps.storagePath(connection, 'backups', 'manifests', `${snapshot.id}.enc`),
			encrypted
		);
		await deps.decryptFile(encrypted, plain);
		const manifest = validateManifest(JSON.parse(await fs.readFile(plain, 'utf8')));
		if (
			manifest.id !== snapshot.id ||
			manifest.kind !== snapshot.kind ||
			manifest.createdAt !== snapshot.createdAt
		) {
			throw new Error('Invalid recovery index.');
		}
		return manifest;
	} finally {
		await fs.rm(encrypted, { force: true });
		await fs.rm(plain, { force: true });
	}
}

async function indexes(client, connection, deps) {
	const directory = deps.storagePath(connection, 'backups', 'indexes');
	let entries;
	try {
		entries = await client.list(directory);
	} catch (error) {
		if (error.code === 2 || error.code === 'ENOENT') return [];
		throw error;
	}
	return entries
		.filter((entry) => entry.type === '-')
		.flatMap((entry) => {
			const match = INDEX.exec(entry.name);
			if (!match || !ID.test(match[1])) return [];
			const createdAt = Number(match[1].split('-')[0]);
			return Number.isSafeInteger(createdAt) ? [{ id: match[1], kind: match[2], createdAt }] : [];
		})
		.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

export async function listRecovery(connection, injected = {}) {
	try {
		const deps = await dependencies(injected);
		return await deps.withStorage(connection, (client) => indexes(client, connection, deps));
	} catch {
		throw new Error('Recovery listing failed.');
	}
}

export async function backupRecovery(db, connection, options = {}, injected = {}) {
	let work;
	let snapshot;
	try {
		const deps = await dependencies(injected);
		await deps.assertStorageKey();
		async function assertOwned() {
			if (
				options.owned !== undefined &&
				(typeof options.owned !== 'function' || (await options.owned()) !== true)
			) {
				throw new Error('Recovery lease lost.');
			}
		}
		await assertOwned();
		const kind = options.kind || 'database';
		const now = options.now ?? Math.floor(Date.now() / 1000);
		if (!['database', 'full'].includes(kind) || !Number.isSafeInteger(now) || now < 0)
			throw new Error();
		const cwd = path.resolve(options.cwd || process.cwd());
		const env = options.env || process.env;
		const voice = path.resolve(
			cwd,
			options.voiceSaveDir || env.VOICE_SAVE_DIR || path.join('uploads', 'audio')
		);
		if (voice === cwd || within(voice, cwd)) throw new Error('Unsafe voice root.');
		const uploads = path.join(cwd, 'uploads');
		const destination = options.destination || recoveryDestination(connection);
		const id = `${now}-${randomUUID()}`;
		work = await workDirectory(cwd);
		const databaseFile = path.join(work, 'database.sqlite');
		await db.backup(databaseFile);
		await fs.chmod(databaseFile, 0o600);
		snapshot = new Database(databaseFile, { readonly: true });
		if (snapshot.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error();
		const references = referencedFiles(snapshot);
		const snapshotArchives = new Map(archiveRows(snapshot).map((row) => [row.path, row]));
		const archivesUsed = new Map();
		const catalog = new Map();
		function locate(original) {
			const absolute = path.resolve(cwd, original);
			const root = within(uploads, absolute) ? uploads : within(voice, absolute) ? voice : null;
			if (!root) throw new Error('Source is outside allowed roots.');
			const relative = safeRelative(
				`${root === uploads ? 'uploads' : 'voice'}/${path.relative(root, absolute).split(path.sep).join('/')}`
			);
			return { absolute, relative };
		}
		for (const [original, role] of references) {
			const { absolute, relative } = locate(original);
			catalog.set(relative, { source: absolute, original, role });
		}
		if (kind === 'full') {
			// Cover every saved archive, including rows no longer referenced by a recording.
			for (const archive of snapshotArchives.values()) {
				const { absolute, relative } = locate(archive.path);
				catalog.set(relative, { source: absolute, original: archive.path, role: 'audio' });
			}
			const extras = [...(await walk(uploads))];
			if (!within(uploads, voice) && voice !== uploads) extras.push(...(await walk(voice)));
			for (const source of extras) {
				const { relative } = locate(source);
				if (!catalog.has(relative)) catalog.set(relative, { source, role: 'attachment' });
			}
		}
		const initialSources = new Map();
		for (const entry of catalog.values()) {
			const archive = snapshotArchives.get(entry.original);
			if (archive) {
				validateArchive(archive, destination);
				archivesUsed.set(archive.path, archive);
			}
			await noLinks(entry.source, true);
			try {
				initialSources.set(entry.source, await fs.stat(entry.source, { bigint: true }));
			} catch (error) {
				if (error.code !== 'ENOENT' || entry.role !== 'audio') throw error;
			}
		}
		const voiceDirectory =
			voice === uploads
				? 'uploads'
				: within(uploads, voice)
					? `uploads/${path.relative(uploads, voice).split(path.sep).join('/')}`
					: 'voice';
		const manifest = {
			version: 1,
			id,
			kind,
			createdAt: now,
			voiceDirectory,
			files: [],
			references: []
		};
		for (const original of references.keys())
			manifest.references.push({ original, path: locate(original).relative });
		function assertArchiveCatalog() {
			if (!archivesUsed.size && kind !== 'full') return;
			const live = new Map(archiveRows(db).map((row) => [row.path, row]));
			for (const [original, archive] of archivesUsed) {
				if (
					!live.has(original) ||
					archiveIdentity(live.get(original)) !== archiveIdentity(archive)
				) {
					throw new Error('Recovery archive changed.');
				}
			}
			if (kind === 'full')
				for (const row of live.values()) {
					if (row.archived_at <= now && !archivesUsed.has(row.path))
						throw new Error('Recovery archive changed.');
				}
		}
		let uploadedObjects = 0;
		let reusedObjects = 0;
		await deps.withStorage(connection, async (client) => {
			for (const folder of ['objects', 'manifests', 'indexes'])
				await client.mkdir(deps.storagePath(connection, 'backups', folder), true);
			const reusable = new Map();
			for (const previous of await indexes(client, connection, deps)) {
				const old = await readManifest(client, connection, previous, work, deps);
				for (const entry of old.files)
					if (!reusable.has(entry.sha256)) reusable.set(entry.sha256, entry);
			}
			async function addFile(source, relative, role, expected) {
				const plain = path.join(work, `${randomUUID()}.plain`);
				const encrypted = path.join(work, `${randomUUID()}.enc`);
				try {
					const info = await copyStable(source, plain, initialSources.get(source));
					if (expected && (info.sha256 !== expected.sha256 || info.bytes !== expected.bytes))
						throw new Error();
					const existing = reusable.get(info.sha256);
					let object;
					let remoteSha256;
					if (existing) {
						object = existing.object;
						remoteSha256 = existing.remoteSha256;
						if (
							(await deps.hashRemote(
								client,
								deps.storagePath(connection, 'backups', 'objects', object)
							)) !== remoteSha256
						)
							throw new Error();
						reusedObjects++;
					} else {
						await deps.encryptFile(plain, encrypted);
						remoteSha256 = await sha256(encrypted);
						object = `${remoteSha256}.enc`;
						const target = deps.storagePath(connection, 'backups', 'objects', object);
						await client.put(encrypted, target);
						if ((await deps.hashRemote(client, target)) !== remoteSha256) throw new Error();
						uploadedObjects++;
						reusable.set(info.sha256, { object, remoteSha256 });
					}
					manifest.files.push({ path: relative, role, ...info, object, remoteSha256 });
				} finally {
					await fs.rm(plain, { force: true });
					await fs.rm(encrypted, { force: true });
				}
			}
			await addFile(databaseFile, 'db/pacs.db', 'database');
			for (const [relative, entry] of catalog) {
				await noLinks(entry.source, true);
				try {
					await fs.lstat(entry.source);
				} catch (error) {
					if (
						error.code !== 'ENOENT' ||
						entry.role !== 'audio' ||
						!hasColumn(snapshot, 'storage_audio', 'path')
					)
						throw error;
					const archive = archivesUsed.get(entry.original);
					if (!archive) throw new Error();
					const archived = path.join(work, `${randomUUID()}.archive`);
					const plain = path.join(work, `${randomUUID()}.audio`);
					const remote = deps.storagePath(connection, 'audio', archive.object_key);
					await client.get(remote, archived);
					if ((await sha256(archived)) !== archive.remote_sha256) throw new Error();
					await deps.decryptFile(archived, plain);
					await addFile(plain, relative, entry.role, archive);
					await fs.rm(archived, { force: true });
					await fs.rm(plain, { force: true });
					continue;
				}
				await addFile(entry.source, relative, entry.role, archivesUsed.get(entry.original));
			}
			const runtime = Object.fromEntries(
				APP_ENV_KEYS.filter((key) => typeof env[key] === 'string').map((key) => [key, env[key]])
			);
			const environment = path.join(work, 'environment.json');
			await fs.writeFile(environment, JSON.stringify(runtime, null, 2), { mode: 0o600 });
			await addFile(environment, 'environment.json', 'environment');
			const envFile = path.join(cwd, '.env');
			await noLinks(envFile, true);
			let envContent;
			try {
				envContent = await fs.readFile(envFile, 'utf8');
			} catch (error) {
				if (error.code !== 'ENOENT') throw error;
			}
			if (envContent !== undefined) {
				const local = path.join(work, 'app.env');
				await fs.writeFile(local, serializeEnvironment(filteredEnvironment(envContent)), {
					mode: 0o600
				});
				await addFile(local, '.env', 'environment');
			}
			async function verifyCollection() {
				await assertOwned();
				for (const [relative, entry] of catalog)
					if (initialSources.has(entry.source)) {
						await noLinks(entry.source);
						const captured = manifest.files.find((file) => file.path === relative);
						if (
							!sameFileState(
								initialSources.get(entry.source),
								await fs.stat(entry.source, { bigint: true })
							) ||
							(await sha256(entry.source)) !== captured.sha256
						)
							throw new Error('Recovery source changed.');
					}
				for (const archive of archivesUsed.values()) {
					if (
						(await deps.hashRemote(
							client,
							deps.storagePath(connection, 'audio', archive.object_key)
						)) !== archive.remote_sha256
					) {
						throw new Error('Recovery archive changed.');
					}
				}
				await assertOwned();
				assertArchiveCatalog();
			}
			await verifyCollection();
			validateManifest(manifest);
			const json = path.join(work, 'manifest.json');
			const encrypted = path.join(work, 'manifest.enc');
			await fs.writeFile(json, JSON.stringify(manifest), { mode: 0o600 });
			await deps.encryptFile(json, encrypted);
			const target = deps.storagePath(connection, 'backups', 'manifests', `${id}.enc`);
			await client.put(encrypted, target);
			if ((await deps.hashRemote(client, target)) !== (await sha256(encrypted))) throw new Error();
			// Publication is last and atomic: an index is the sole completed-snapshot marker.
			const publicIndex = path.join(work, 'index.json');
			await fs.writeFile(publicIndex, JSON.stringify({ id, kind, createdAt: now }), {
				mode: 0o600
			});
			const pending = deps.storagePath(connection, 'backups', 'indexes', `${id}.pending`);
			await client.put(publicIndex, pending);
			await verifyCollection();
			await client.rename(
				pending,
				deps.storagePath(connection, 'backups', 'indexes', `${id}.${kind}.json`)
			);
		});
		return {
			id,
			kind,
			createdAt: now,
			files: manifest.files.length,
			archivedFiles: archivesUsed.size,
			bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
			uploadedObjects,
			reusedObjects
		};
	} catch {
		throw new Error('Recovery backup failed.');
	} finally {
		await cleanupRecovery(snapshot, work);
	}
}

/** Keep newest snapshot in each UTC hour/day/month bucket within its configured window. */
export async function pruneRecovery(
	connection,
	retention = {},
	now = Math.floor(Date.now() / 1000),
	injected = {}
) {
	try {
		const deps = await dependencies(injected);
		const limits = [
			retention.hourlyRetention ?? 48,
			retention.dailyRetention ?? 30,
			retention.monthlyRetention ?? 12
		];
		if (
			!Number.isSafeInteger(now) ||
			now < 0 ||
			limits.some((n) => !Number.isSafeInteger(n) || n < 0)
		)
			throw new Error();
		return await deps.withStorage(connection, async (client) => {
			const all = await indexes(client, connection, deps);
			const keep = new Set();
			const buckets = [new Set(), new Set(), new Set()];
			const current = new Date(now * 1000);
			const currentMonth = current.getUTCFullYear() * 12 + current.getUTCMonth();
			for (const snapshot of all) {
				if (snapshot.createdAt > now) {
					keep.add(snapshot.id);
					continue;
				}
				const date = new Date(snapshot.createdAt * 1000);
				const keys = [
					Math.floor(snapshot.createdAt / 3600),
					Math.floor(snapshot.createdAt / 86400),
					date.getUTCFullYear() * 12 + date.getUTCMonth()
				];
				const ages = [
					Math.floor(now / 3600) - keys[0],
					Math.floor(now / 86400) - keys[1],
					currentMonth - keys[2]
				];
				for (let i = 0; i < 3; i++) {
					if (ages[i] < limits[i] && !buckets[i].has(keys[i])) {
						buckets[i].add(keys[i]);
						keep.add(snapshot.id);
					}
				}
			}
			// Daily/monthly full snapshots preserve uploads extras that database-only snapshots omit.
			for (let i = 1; i < 3; i++) {
				const fullBuckets = new Set();
				for (const snapshot of all.filter((item) => item.kind === 'full')) {
					const date = new Date(snapshot.createdAt * 1000);
					const bucket =
						i === 1
							? Math.floor(snapshot.createdAt / 86400)
							: date.getUTCFullYear() * 12 + date.getUTCMonth();
					const age = (i === 1 ? Math.floor(now / 86400) : currentMonth) - bucket;
					if (age >= 0 && age < limits[i] && !fullBuckets.has(bucket)) {
						fullBuckets.add(bucket);
						keep.add(snapshot.id);
					}
				}
			}
			// Preserve the newest recovery point AND newest full file catalog even with zero limits.
			if (all.length) keep.add(all[0].id);
			const latestFull = all.find((snapshot) => snapshot.kind === 'full');
			if (latestFull) keep.add(latestFull.id);
			let pruned = 0;
			for (const snapshot of all)
				if (!keep.has(snapshot.id)) {
					await client.delete(
						deps.storagePath(
							connection,
							'backups',
							'indexes',
							`${snapshot.id}.${snapshot.kind}.json`
						)
					);
					await client.delete(
						deps.storagePath(connection, 'backups', 'manifests', `${snapshot.id}.enc`)
					);
					pruned++;
				}
			return { kept: keep.size, pruned, objectsRetained: true };
		});
	} catch {
		throw new Error('Recovery retention failed.');
	}
}

/** Offline restore only. objectsDirectory contains downloaded backups/objects/*.enc. */
export async function restoreRecovery(
	{ manifestFile, objectsDirectory, outputDirectory },
	injected = {}
) {
	let work;
	let database;
	try {
		const deps = await dependencies(injected, false);
		await deps.assertStorageKey();
		const output = path.resolve(outputDirectory);
		await noLinks(output, true);
		try {
			if ((await fs.readdir(output)).length) throw new Error();
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
		work = await workDirectory(path.dirname(output));
		await noLinks(manifestFile);
		await noLinks(objectsDirectory);
		const plainManifest = path.join(work, 'manifest.json');
		await deps.decryptFile(manifestFile, plainManifest);
		const manifest = validateManifest(JSON.parse(await fs.readFile(plainManifest, 'utf8')));
		const restored = path.join(work, 'restored');
		await fs.mkdir(restored, { mode: 0o700 });
		for (const entry of manifest.files) {
			const object = path.join(objectsDirectory, entry.object);
			await noLinks(object);
			if ((await sha256(object)) !== entry.remoteSha256) throw new Error();
			const target = path.join(restored, ...entry.path.split('/'));
			await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
			await deps.decryptFile(object, target);
			await fs.chmod(target, 0o600);
			if ((await fs.stat(target)).size !== entry.bytes || (await sha256(target)) !== entry.sha256)
				throw new Error();
		}
		database = new Database(path.join(restored, 'db', 'pacs.db'));
		if (database.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error();
		const remap = database.transaction(() => {
			for (const reference of manifest.references) {
				const target = reference.path;
				for (const [table, column] of REFERENCES)
					if (hasColumn(database, table, column)) {
						database
							.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`)
							.run(target, reference.original);
					}
			}
			// Restored audio is local and independent of the source archive and its destination.
			if (hasColumn(database, 'storage_audio', 'path'))
				database.prepare('DELETE FROM storage_audio').run();
			pauseRestoredStorage(database);
		});
		remap();
		if (database.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error();
		database.close();
		database = undefined;
		// Custom roots are deliberately relocated. Operators can choose a new deployment path later.
		const runtimePath = path.join(restored, 'environment.json');
		try {
			const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));
			if (manifest.voiceDirectory) runtime.VOICE_SAVE_DIR = manifest.voiceDirectory;
			await fs.writeFile(runtimePath, JSON.stringify(runtime, null, 2), { mode: 0o600 });
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
		const restoredEnv = path.join(restored, '.env');
		try {
			const values = filteredEnvironment(await fs.readFile(restoredEnv, 'utf8'));
			if (manifest.voiceDirectory) values.VOICE_SAVE_DIR = manifest.voiceDirectory;
			await fs.writeFile(restoredEnv, serializeEnvironment(values), { mode: 0o600 });
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
		await fs.rmdir(output).catch((error) => {
			if (error.code !== 'ENOENT') throw error;
		});
		await fs.rename(restored, output);
		return {
			id: manifest.id,
			kind: manifest.kind,
			createdAt: manifest.createdAt,
			files: manifest.files.length
		};
	} catch {
		throw new Error('Recovery restore failed. Output was not published.');
	} finally {
		await cleanupRecovery(database, work);
	}
}
