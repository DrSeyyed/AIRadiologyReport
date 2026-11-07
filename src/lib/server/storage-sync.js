import path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as transport from './storage-transport.js';
import * as crypto from './storage-crypto.js';
import { storageDestination } from './storage-settings.js';
import { archiveAudio, audioReferences } from './storage-audio.js';
import { storageRequest } from './storage-session.js';
import { uploadStorageFile } from './storage-upload.js';
import { hashStorageFile, linkStorageFile } from './storage-shell.js';
import { storageFilePool } from './storage-file-pool.js';
import {
	ensureStorageFileState,
	fileState,
	noFileLinks,
	storageFileLocation,
	storageFileDigest,
	discoverStorageFiles
} from './storage-file-state.js';

const digestPattern = /^[a-f0-9]{64}$/;
function isType(value, method, type) {
	return (
		value &&
		(value.type === type ||
			value[method] === true ||
			(typeof value[method] === 'function' && value[method]()))
	);
}
export async function remoteFileStat(client, target, missing = false) {
	try {
		const info = await storageRequest(client, () => client.lstat(target));
		if (
			isType(info, 'isSymbolicLink', 'l') ||
			!isType(info, 'isFile', '-') ||
			!Number.isSafeInteger(info.size) ||
			info.size < 0
		)
			throw new Error('Unsafe storage object.');
		return info;
	} catch (error) {
		if (missing && (error.code === 2 || error.code === 'ENOENT')) return null;
		throw error;
	}
}
export async function ensureFileDirectory(client, target) {
	await storageRequest(client, () => client.mkdir(target, true));
	const info = await storageRequest(client, () => client.lstat(target));
	if (isType(info, 'isSymbolicLink', 'l') || !isType(info, 'isDirectory', 'd'))
		throw new Error('Unsafe storage directory.');
}
function syncProgress(observer = () => {}) {
	const state = {
		copied: 0,
		evicted: 0,
		preparing: 0,
		uploading: 0,
		verifying: 0,
		verificationBytes: 0,
		lastActivityAt: Math.floor(Date.now() / 1000)
	};
	let failure;
	const activity = () => {
		state.lastActivityAt = Math.floor(Date.now() / 1000);
	};
	const report = () => {
		try {
			observer({ ...state });
		} catch (error) {
			failure ||= error;
		}
	};
	const timer = setInterval(report, 2000);
	timer.unref();
	report();
	return {
		state,
		activity,
		assert() {
			if (failure) throw failure;
		},
		async track(field, fn) {
			state[field]++;
			activity();
			try {
				return await fn();
			} finally {
				state[field]--;
				activity();
			}
		},
		finish() {
			clearInterval(timer);
			report();
		}
	};
}
export async function syncStorageData(db, connection, options = {}, injected = {}) {
	const deps = { ...transport, ...crypto, hashStorageFile, linkStorageFile, ...injected };
	const now = options.now ?? Math.floor(Date.now() / 1000);
	const cwd = path.resolve(options.cwd || process.cwd());
	const voice = path.resolve(
		cwd,
		options.voiceSaveDir ||
			(options.env ?? process.env).VOICE_SAVE_DIR ||
			path.join('uploads', 'audio')
	);
	const rel = path.relative(voice, cwd);
	if (
		voice === cwd ||
		(rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
	)
		throw new Error('Unsafe voice root.');
	const destination = storageDestination(connection);
	const progress = syncProgress(options.onProgress);
	let work;
	const assertActive = () => {
		progress.assert();
		if (
			options.owned !== undefined &&
			(typeof options.owned !== 'function' || options.owned() !== true)
		)
			throw new Error('Storage synchronization cancelled.');
	};
	try {
		ensureStorageFileState(db);
		await deps.assertStorageKey();
		await assertActive();
		const files = await discoverStorageFiles(cwd, voice);
		const archives = new Map();
		if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='storage_audio'").get())
			for (const row of db.prepare('SELECT * FROM storage_audio').all()) {
				const located = storageFileLocation(cwd, voice, row.path);
				archives.set(located.relative, row);
				if (!files.has(located.relative) && row.evicted_at)
					files.set(located.relative, { original: located.absolute, state: null, archive: row });
			}
		const enqueue = db.prepare(
			`INSERT INTO storage_file_queue(path,queued_at,deleted) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET queued_at=excluded.queued_at,deleted=excluded.deleted,revision=storage_file_queue.revision+1`
		);
		const catalog = db.prepare('SELECT * FROM storage_file_catalog WHERE path=?');
		db.transaction(() => {
			for (const [relative, entry] of files) {
				const saved = catalog.get(relative);
				if (saved && saved.destination !== destination)
					throw new Error('Storage destination changed.');
				db.prepare(
					`INSERT INTO storage_file_catalog(path,original,destination) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET original=excluded.original`
				).run(relative, entry.original, destination);
				if (!saved || saved.deleted_at || saved.state !== entry.state || !saved.object_key)
					enqueue.run(relative, now, 0);
			}
			for (const saved of db
				.prepare('SELECT * FROM storage_file_catalog WHERE deleted_at IS NULL')
				.all())
				if (!files.has(saved.path)) enqueue.run(saved.path, now, 1);
		})();
		work = path.join(cwd, `.storage-sync-work-${randomUUID()}`);
		await noFileLinks(cwd);
		await fs.mkdir(work, { mode: 0o700 });
		const limit = options.forceAll ? Number.MAX_SAFE_INTEGER : 100;
		const queue = db
			.prepare('SELECT * FROM storage_file_queue ORDER BY queued_at,path LIMIT ?')
			.all(limit);
		async function register(item, entry, object, state) {
			await assertActive();
			if (state !== null) {
				await noFileLinks(entry.original);
				if (fileState(await fs.stat(entry.original, { bigint: true })) !== state)
					throw new Error('Storage source changed.');
			}
			db.transaction(() => {
				db.prepare(
					'UPDATE storage_file_catalog SET object_key=?,state=?,synced_at=?,deleted_at=NULL WHERE path=? AND destination=?'
				).run(object.object_key, state, now, item.path, destination);
				db.prepare('DELETE FROM storage_file_queue WHERE path=? AND revision=?').run(
					item.path,
					item.revision
				);
			})();
			progress.state.copied++;
			progress.activity();
		}
		const getObject = db.prepare(
			'SELECT * FROM storage_file_objects WHERE destination=? AND object_key=?'
		);
		async function saveObject(object) {
			await assertActive();
			db.prepare(
				`INSERT INTO storage_file_objects(destination,object_key,sha256,remote_sha256,bytes,encrypted_bytes,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(destination,object_key) DO UPDATE SET verified_at=excluded.verified_at`
			).run(
				destination,
				object.object_key,
				object.sha256,
				object.remote_sha256,
				object.bytes,
				object.encrypted_bytes,
				now,
				now
			);
			return getObject.get(destination, object.object_key);
		}
		await deps.withStorage(connection, async (client) => {
			await ensureFileDirectory(client, deps.storagePath(connection, 'files'));
			await ensureFileDirectory(client, deps.storagePath(connection, 'files', 'objects'));
			await ensureFileDirectory(client, deps.storagePath(connection, 'audio'));
			await storageFilePool(
				deps,
				connection,
				queue,
				async (worker, item) => {
					await assertActive();
					const entry = files.get(item.path);
					if (item.deleted) {
						const saved = catalog.get(item.path);
						await noFileLinks(saved.original, true);
						try {
							await fs.lstat(saved.original);
							throw new Error('Storage source changed.');
						} catch (error) {
							if (error.code !== 'ENOENT') throw error;
						}
						await assertActive();
						db.transaction(() => {
							db.prepare('UPDATE storage_file_catalog SET deleted_at=? WHERE path=?').run(
								now,
								item.path
							);
							db.prepare('DELETE FROM storage_file_queue WHERE path=? AND revision=?').run(
								item.path,
								item.revision
							);
						})();
						return;
					}
					if (!entry) throw new Error('Storage source changed.');
					const token = randomUUID();
					const plain = path.join(work, `${token}.plain`);
					const encrypted = path.join(work, `${token}.enc`);
					try {
						let sha;
						let bytes;
						let state = entry.state;
						let archived = entry.archive || archives.get(item.path);
						if (state !== null)
							await progress.track('preparing', async () => {
								await noFileLinks(entry.original);
								const before = await fs.stat(entry.original, { bigint: true });
								if (!before.isFile() || fileState(before) !== state)
									throw new Error('Storage source changed.');
								await fs.copyFile(entry.original, plain);
								await fs.chmod(plain, 0o600);
								sha = await storageFileDigest(plain, progress.activity);
								bytes = Number(before.size);
								if (
									fileState(await fs.stat(entry.original, { bigint: true })) !== state ||
									sha !== (await storageFileDigest(entry.original, progress.activity))
								)
									throw new Error('Storage source changed.');
							});
						else {
							sha = archived?.sha256;
							bytes = archived?.bytes;
						}
						if (!digestPattern.test(sha) || !Number.isSafeInteger(bytes) || bytes < 0)
							throw new Error('Invalid storage file.');
						let object = db
							.prepare(
								'SELECT * FROM storage_file_objects WHERE destination=? AND sha256=? AND bytes=? ORDER BY verified_at DESC LIMIT 1'
							)
							.get(destination, sha, bytes);
						if (object) {
							const info = await remoteFileStat(
								worker,
								deps.storagePath(connection, 'files', 'objects', object.object_key)
							);
							if (info.size !== object.encrypted_bytes) throw new Error('Storage object changed.');
							await register(item, entry, object, state);
							return;
						}
						if (
							archived &&
							archived.sha256 === sha &&
							archived.bytes === bytes &&
							archived.destination === destination &&
							digestPattern.test(archived.remote_sha256) &&
							/^[a-f0-9-]{36}\.enc$/.test(archived.object_key)
						) {
							const source = deps.storagePath(connection, 'audio', archived.object_key);
							const info = await remoteFileStat(worker, source);
							const object_key = `${archived.remote_sha256}.enc`;
							const target = deps.storagePath(connection, 'files', 'objects', object_key);
							if (!(await remoteFileStat(worker, target, true)))
								await deps.linkStorageFile(worker, source, target, connection, { assertActive });
							await progress.track('verifying', async () => {
								if (
									(await deps.hashStorageFile(worker, target, connection, { assertActive })) !==
									archived.remote_sha256
								)
									throw new Error('Archived audio changed.');
								progress.state.verificationBytes += info.size;
							});
							object = await saveObject({
								object_key,
								sha256: sha,
								remote_sha256: archived.remote_sha256,
								bytes,
								encrypted_bytes: info.size
							});
						} else {
							await progress.track('preparing', () => deps.encryptFile(plain, encrypted));
							const remote_sha256 = await storageFileDigest(encrypted, progress.activity);
							const object_key = `${remote_sha256}.enc`;
							const target = deps.storagePath(connection, 'files', 'objects', object_key);
							const encrypted_bytes = (await fs.stat(encrypted)).size;
							await progress.track('uploading', () =>
								uploadStorageFile(worker, encrypted, target, connection, {
									assertActive,
									onProgress: () => progress.activity()
								})
							);
							await assertActive();
							await progress.track('verifying', async () => {
								if (
									(await deps.hashStorageFile(worker, target, connection, { assertActive })) !==
									remote_sha256
								)
									throw new Error('Storage verification failed.');
								progress.state.verificationBytes += encrypted_bytes;
							});
							object = await saveObject({
								object_key,
								sha256: sha,
								remote_sha256,
								bytes,
								encrypted_bytes
							});
						}
						await register(item, entry, object, state);
					} finally {
						await fs.rm(plain, { force: true });
						await fs.rm(encrypted, { force: true });
					}
				},
				assertActive,
				client
			);
			if (options.archiveAudio !== false && connection.archiveEnabled) {
				const refs = audioReferences(db).filter(
					(ref) => !db.prepare('SELECT 1 FROM storage_audio WHERE path=?').get(ref.path)
				);
				await storageFilePool(
					deps,
					connection,
					refs,
					async (worker, ref) => {
						const located = storageFileLocation(cwd, voice, ref.path);
						const saved = catalog.get(located.relative);
						if (!saved?.object_key || saved.deleted_at || saved.state === null) return;
						await noFileLinks(located.absolute);
						if (fileState(await fs.stat(located.absolute, { bigint: true })) !== saved.state)
							return;
						const object = getObject.get(destination, saved.object_key);
						if (!object) throw new Error('Storage object missing.');
						const key = `${randomUUID()}.enc`;
						await deps.linkStorageFile(
							worker,
							deps.storagePath(connection, 'files', 'objects', object.object_key),
							deps.storagePath(connection, 'audio', key),
							connection,
							{ assertActive }
						);
						await assertActive();
						if (!audioReferences(db).some((current) => current.path === ref.path)) return;
						db.prepare(
							'INSERT INTO storage_audio(path,object_key,sha256,remote_sha256,bytes,archived_at,destination) VALUES(?,?,?,?,?,?,?)'
						).run(
							ref.path,
							key,
							object.sha256,
							object.remote_sha256,
							object.bytes,
							now,
							destination
						);
					},
					assertActive,
					client
				);
			}
			const due = db
				.prepare(
					'SELECT * FROM storage_file_objects WHERE destination=? AND verified_at<=? ORDER BY verified_at LIMIT 100'
				)
				.all(destination, now - (connection.integrityAuditDays ?? 7) * 86400);
			await storageFilePool(
				deps,
				connection,
				due,
				async (worker, object) => {
					await progress.track('verifying', async () => {
						if (
							(await deps.hashStorageFile(
								worker,
								deps.storagePath(connection, 'files', 'objects', object.object_key),
								connection,
								{ assertActive }
							)) !== object.remote_sha256
						)
							throw new Error('Storage integrity audit failed.');
						progress.state.verificationBytes += object.encrypted_bytes;
						if (object.backup_linked_at !== null) {
							if (
								(await deps.hashStorageFile(
									worker,
									deps.storagePath(connection, 'backups', 'objects', object.object_key),
									connection,
									{ assertActive }
								)) !== object.remote_sha256
							)
								throw new Error('Backup integrity audit failed.');
							progress.state.verificationBytes += object.encrypted_bytes;
						}
					});
					await assertActive();
					db.prepare(
						'UPDATE storage_file_objects SET verified_at=? WHERE destination=? AND object_key=?'
					).run(now, destination, object.object_key);
				},
				assertActive,
				client
			);
		});
		if (options.archiveAudio !== false && connection.archiveEnabled && !options.forceAll) {
			await assertActive();
			const result = await archiveAudio(db, connection, {
				now,
				owned: options.owned,
				roots: [path.join(cwd, 'uploads'), voice],
				transport: deps.withStorage,
				verify: (worker, target, settings) =>
					deps.hashStorageFile(worker, target, settings, { assertActive }),
				onProgress: options.onProgress
			});
			progress.state.evicted += result.evicted;
		}
		await assertActive();
		return {
			...progress.state,
			syncPending: db.prepare('SELECT COUNT(*) AS count FROM storage_file_queue').get().count
		};
	} catch {
		throw new Error('Storage synchronization failed.');
	} finally {
		try {
			if (work) await fs.rm(work, { recursive: true, force: true });
		} finally {
			progress.finish();
		}
	}
}
