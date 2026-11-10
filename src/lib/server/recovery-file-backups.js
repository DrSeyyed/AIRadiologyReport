import path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { recoveryProgress } from './recovery-progress.js';
import { MAX_MANIFEST_BYTES } from './recovery-bundles.js';
import { uploadStorageFile } from './storage-upload.js';
import { syncStorageData, remoteFileStat, ensureFileDirectory } from './storage-sync.js';
import { storageFilePool, storageTaskPool } from './storage-file-pool.js';
import { storageParallelConnections } from './storage-settings.js';
import {
	ensureStorageFileState,
	fileState,
	noFileLinks,
	storageFileLocation,
	storageFileDigest,
	discoverStorageFiles
} from './storage-file-state.js';

const DIGEST = /^[a-f0-9]{64}$/;
const ordered = (entries) => JSON.stringify([...entries].sort(([a], [b]) => a.localeCompare(b)));

function referenceMetadata(db) {
	return JSON.stringify(
		[
			['recording_audio_parts', ['audio_report_path']],
			['study_recordings', ['audio_report_path', 'text_report_path']]
		].map(([table, candidates]) => {
			const columns = db
				.prepare(`PRAGMA table_info(${table})`)
				.all()
				.map((row) => row.name);
			const references = candidates.filter((column) => columns.includes(column));
			if (!references.length) return [table, []];
			const selected = [...(columns.includes('id') ? ['id'] : []), ...references];
			return [
				table,
				db
					.prepare(`SELECT ${selected.join(',')} FROM ${table} ORDER BY ${selected.join(',')}`)
					.all()
			];
		})
	);
}

/** Independent v1 recovery objects; no remote downloads, packing or compression. */
export async function backupFileRecovery(db, connection, options = {}, deps, helpers) {
	let work;
	let snapshot;
	let aborted = false;
	const progress = recoveryProgress(options.onProgress);
	const withStorage = deps.withStorage.bind(deps);
	deps = {
		...deps,
		async withStorage(settings, operation) {
			let running;
			try {
				return await withStorage(settings, (client) => {
					if (aborted) throw new Error('Recovery backup aborted.');
					running = (async () => operation(client))();
					return running;
				});
			} catch (error) {
				aborted = true;
				throw error;
			} finally {
				await running?.catch(() => {});
			}
		}
	};
	const assertActive = () => {
		progress.assertHealthy();
		if (
			aborted ||
			(options.owned !== undefined &&
				(typeof options.owned !== 'function' || options.owned() !== true))
		)
			throw new Error('Recovery lease lost.');
	};
	try {
		await deps.assertStorageKey();
		assertActive();
		const now = options.now ?? Math.floor(Date.now() / 1000);
		if ((options.kind && options.kind !== 'full') || !Number.isSafeInteger(now) || now < 0)
			throw new Error('Invalid recovery options.');
		const cwd = path.resolve(options.cwd || process.cwd());
		const env = options.env || process.env;
		const voice = path.resolve(
			cwd,
			options.voiceSaveDir ||
				env.VOICE_SAVE_DIR ||
				process.env.VOICE_SAVE_DIR ||
				path.join('uploads', 'audio')
		);
		if (voice === cwd || helpers.within(voice, cwd)) throw new Error('Unsafe voice root.');
		const destination = helpers.recoveryDestination(connection);
		if (options.destination && options.destination !== destination)
			throw new Error('Invalid destination.');
		const locate = (original) => storageFileLocation(cwd, voice, original);
		const referencesIdentity = referenceMetadata;
		const archivesIdentity = (database) =>
			ordered(helpers.archiveRows(database).map((row) => [row.path, helpers.archiveIdentity(row)]));
		// Capture source identities before SQLite yields, not after synchronizing mutable paths.
		progress.set({ phase: 'discovering' });
		const initialFiles = await discoverStorageFiles(cwd, voice);
		const initialReferences = referencesIdentity(db);
		const initialArchives = archivesIdentity(db);
		const envFile = path.join(cwd, '.env');
		await noFileLinks(envFile, true);
		let envContent;
		let envState;
		try {
			envState = fileState(await fs.stat(envFile, { bigint: true }));
			envContent = await fs.readFile(envFile, 'utf8');
			if (envState !== fileState(await fs.stat(envFile, { bigint: true }))) throw new Error();
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
		const runtime = Object.fromEntries(
			helpers.APP_ENV_KEYS.filter((key) => typeof env[key] === 'string').map((key) => [
				key,
				env[key]
			])
		);
		work = await helpers.workDirectory(cwd);
		const databaseFile = path.join(work, 'database.sqlite');
		progress.set({ phase: 'snapshotting' });
		assertActive();
		await db.backup(databaseFile);
		await fs.chmod(databaseFile, 0o600);
		snapshot = new Database(databaseFile, { readonly: true });
		if (
			snapshot.pragma('integrity_check', { simple: true }) !== 'ok' ||
			referencesIdentity(snapshot) !== initialReferences ||
			archivesIdentity(snapshot) !== initialArchives
		)
			throw new Error('Recovery snapshot changed.');
		const references = helpers.referencedFiles(snapshot);
		const archives = helpers.archiveRows(snapshot);
		const expected = new Map([...initialFiles].map(([key, entry]) => [key, entry.state]));
		const archiveVersions = new Map();
		for (const row of archives) {
			if (row.destination !== destination) throw new Error('Recovery archive changed.');
			const { relative } = locate(row.path);
			if (!expected.has(relative)) {
				if (!row.evicted_at) throw new Error('Recovery source missing.');
				expected.set(relative, null);
				archiveVersions.set(relative, row);
			}
		}
		for (const original of references.keys())
			if (!expected.has(locate(original).relative)) throw new Error('Recovery source missing.');
		async function assertSources() {
			assertActive();
			if (
				referencesIdentity(db) !== initialReferences ||
				archivesIdentity(db) !== initialArchives ||
				ordered(await discoverStorageFiles(cwd, voice)) !== ordered(initialFiles)
			)
				throw new Error('Recovery source changed.');
			await noFileLinks(envFile, true);
			let current;
			try {
				current = fileState(await fs.stat(envFile, { bigint: true }));
			} catch (error) {
				if (error.code !== 'ENOENT') throw error;
			}
			if (current !== envState) throw new Error('Recovery environment changed.');
			assertActive();
		}
		await assertSources();
		ensureStorageFileState(db);
		progress.set({ phase: 'collecting' });
		await syncStorageData(
			db,
			connection,
			{
				...options,
				cwd,
				env,
				voiceSaveDir: voice,
				forceAll: true,
				archiveAudio: false,
				owned: () => {
					assertActive();
					return true;
				},
				onProgress: () => {
					progress.activity();
					progress.assertHealthy();
				}
			},
			deps
		);
		await assertSources();
		if (db.prepare('SELECT 1 FROM storage_file_queue LIMIT 1').get())
			throw new Error('Recovery synchronization incomplete.');
		const catalog = db
			.prepare('SELECT * FROM storage_file_catalog WHERE deleted_at IS NULL ORDER BY path')
			.all();
		if (catalog.length !== expected.size) throw new Error('Recovery catalog changed.');
		const frozen = catalog.map((entry) => {
			if (
				entry.destination !== destination ||
				!expected.has(entry.path) ||
				entry.state !== expected.get(entry.path)
			)
				throw new Error('Recovery catalog changed.');
			return { ...entry };
		});
		const uploads = path.join(cwd, 'uploads');
		const id = `${now}-${randomUUID()}`;
		const manifest = {
			version: 1,
			format: 'immutable-files-v1',
			id,
			kind: 'full',
			createdAt: now,
			voiceDirectory:
				voice === uploads
					? 'uploads'
					: helpers.within(uploads, voice)
						? `uploads/${path.relative(uploads, voice).split(path.sep).join('/')}`
						: 'voice',
			files: [],
			references: [...references].map(([original]) => ({
				original,
				path: locate(original).relative
			}))
		};
		const roles = new Map(
			[...references].map(([original, role]) => [locate(original).relative, role])
		);
		for (const archive of archives)
			if (!roles.has(locate(archive.path).relative))
				roles.set(locate(archive.path).relative, 'audio');
		const config = path.join(work, 'environment.json');
		await fs.writeFile(config, JSON.stringify(runtime, null, 2), { mode: 0o600 });
		const independent = [
			{ source: databaseFile, path: 'db/pacs.db', role: 'database' },
			{ source: config, path: 'environment.json', role: 'environment' }
		];
		if (envContent !== undefined) {
			const source = path.join(work, 'app.env');
			await fs.writeFile(
				source,
				helpers.serializeEnvironment(helpers.filteredEnvironment(envContent)),
				{ mode: 0o600 }
			);
			independent.push({ source, path: '.env', role: 'environment' });
		}
		progress.set({ totalFiles: frozen.length + independent.length });
		let uploadedObjects = 0;
		let reusedObjects = 0;
		const objectRow = db.prepare(
			'SELECT * FROM storage_file_objects WHERE destination=? AND object_key=?'
		);
		const frozenObjects = new Map();
		const objectIdentity = (object) =>
			JSON.stringify([
				object.destination,
				object.object_key,
				object.sha256,
				object.remote_sha256,
				object.bytes,
				object.encrypted_bytes
			]);
		const validObject = (object) => {
			if (
				!object ||
				object.destination !== destination ||
				!DIGEST.test(object.sha256) ||
				!DIGEST.test(object.remote_sha256) ||
				object.object_key !== `${object.remote_sha256}.enc` ||
				!Number.isSafeInteger(object.bytes) ||
				object.bytes < 0 ||
				!Number.isSafeInteger(object.encrypted_bytes) ||
				object.encrypted_bytes < 1
			)
				throw new Error('Invalid recovery object.');
			const identity = objectIdentity(object);
			if (frozenObjects.has(object.object_key) && frozenObjects.get(object.object_key) !== identity)
				throw new Error('Recovery object changed.');
			frozenObjects.set(object.object_key, identity);
			return object;
		};
		const upload = (client, source, target) =>
			progress.track('uploading', () =>
				uploadStorageFile(client, source, target, connection, {
					assertActive,
					onProgress: (bytes) => progress.add('uploadedBytes', bytes)
				})
			);
		const hashRemote = (client, target) =>
			progress.track('verifying', () =>
				deps.hashStorageFile(client, target, connection, {
					assertActive,
					onProgress: () => progress.activity()
				})
			);
		await deps.withStorage(connection, async (client) => {
			for (const parts of [
				['files'],
				['files', 'objects'],
				['backups'],
				['backups', 'objects'],
				['backups', 'manifests'],
				['backups', 'indexes']
			])
				await ensureFileDirectory(client, deps.storagePath(connection, ...parts));
			const preserving = new Map();
			function preserve(worker, object, checked) {
				validObject(object);
				if (!preserving.has(object.object_key))
					preserving.set(object.object_key, preserveObject(worker, object, checked));
				return preserving.get(object.object_key);
			}
			async function preserveObject(worker, object, checked) {
				validObject(object);
				assertActive();
				const source = deps.storagePath(connection, 'files', 'objects', object.object_key);
				const target = deps.storagePath(connection, 'backups', 'objects', object.object_key);
				const [sourceInfo, exists] = checked || [
					await remoteFileStat(worker, source),
					await remoteFileStat(worker, target, true)
				];
				if (!sourceInfo || sourceInfo.size !== object.encrypted_bytes)
					throw new Error('Recovery object changed.');
				if (exists) {
					if (
						exists.size !== object.encrypted_bytes ||
						(object.backup_linked_at == null &&
							(await hashRemote(worker, target)) !== object.remote_sha256)
					)
						throw new Error('Recovery object changed.');
				} else {
					await deps.linkStorageFile(worker, source, target, connection, { assertActive });
					if ((await remoteFileStat(worker, target)).size !== object.encrypted_bytes)
						throw new Error('Recovery object changed.');
				}
				assertActive();
			}
			await storageTaskPool(
				independent,
				storageParallelConnections(connection),
				async (entry) => {
					entry.sha256 = await storageFileDigest(entry.source, progress.activity);
					entry.bytes = (await fs.stat(entry.source)).size;
				},
				assertActive
			);
			const prepared = new Map();
			for (const entry of independent) {
				const key = `${entry.sha256}:${entry.bytes}`;
				if (!prepared.has(key)) {
					const object = db
						.prepare(
							'SELECT * FROM storage_file_objects WHERE destination=? AND sha256=? AND bytes=? ORDER BY created_at LIMIT 1'
						)
						.get(destination, entry.sha256, entry.bytes);
					prepared.set(key, { ...entry, object });
				}
				entry.prepared = prepared.get(key);
			}
			await storageFilePool(
				deps,
				connection,
				[...prepared.values()].filter((entry) => !entry.object),
				async (worker, entry) => {
					const encrypted = path.join(work, `${randomUUID()}.enc`);
					try {
						await deps.encryptFile(entry.source, encrypted);
						assertActive();
						const remote_sha256 = await storageFileDigest(encrypted, progress.activity);
						const encrypted_bytes = (await fs.stat(encrypted)).size;
						const object_key = `${remote_sha256}.enc`;
						const target = deps.storagePath(connection, 'files', 'objects', object_key);
						await upload(worker, encrypted, target);
						if ((await hashRemote(worker, target)) !== remote_sha256)
							throw new Error('Recovery verification failed.');
						assertActive();
						entry.object = {
							destination,
							object_key,
							sha256: entry.sha256,
							remote_sha256,
							bytes: entry.bytes,
							encrypted_bytes,
							created_at: now,
							verified_at: now
						};
						entry.uploaded = true;
					} finally {
						await fs.rm(encrypted, { force: true });
					}
				},
				assertActive,
				client
			);
			for (const entry of prepared.values()) {
				assertActive();
				if (!entry.uploaded) continue;
				const object = entry.object;
				db.prepare(
					'INSERT INTO storage_file_objects(destination,object_key,sha256,remote_sha256,bytes,encrypted_bytes,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?)'
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
				uploadedObjects++;
			}
			const objects = new Map();
			for (const entry of independent) {
				const object = validObject(entry.prepared.object);
				objects.set(object.object_key, object);
				if (!entry.prepared.uploaded) reusedObjects++;
				manifest.files.push({
					path: entry.path,
					role: entry.role,
					sha256: object.sha256,
					remoteSha256: object.remote_sha256,
					bytes: object.bytes,
					object: object.object_key
				});
				progress.add('files');
			}
			for (const entry of frozen) {
				assertActive();
				const object = validObject(objectRow.get(destination, entry.object_key));
				const archive = archiveVersions.get(entry.path);
				if (archive && (object.sha256 !== archive.sha256 || object.bytes !== archive.bytes))
					throw new Error('Recovery archive version changed.');
				if (!preserving.has(object.object_key)) objects.set(object.object_key, object);
			}
			const batches = [];
			let batch = { objects: [], paths: [], bytes: 0 };
			for (const object of objects.values()) {
				const paths = [
					deps.storagePath(connection, 'files', 'objects', object.object_key),
					deps.storagePath(connection, 'backups', 'objects', object.object_key)
				];
				// Allow for shell quoting expansion and keep commands below the SSH exec argument limit.
				const bytes = paths.reduce((sum, target) => sum + Buffer.byteLength(target) * 4 + 4, 0);
				if (
					batch.objects.length &&
					(batch.objects.length >= 32 || batch.bytes + bytes > 48 * 1024)
				) {
					batches.push(batch);
					batch = { objects: [], paths: [], bytes: 0 };
				}
				batch.objects.push(object);
				batch.paths.push(...paths);
				batch.bytes += bytes;
			}
			if (batch.objects.length) batches.push(batch);
			const checkedObjects = new Map();
			await storageFilePool(
				deps,
				connection,
				batches,
				async (worker, batch) => {
					assertActive();
					const checked = await deps.statStorageFiles(worker, batch.paths, connection, {
						assertActive,
						onProgress: () => progress.activity()
					});
					assertActive();
					if (!Array.isArray(checked) || checked.length !== batch.paths.length)
						throw new Error('Recovery object checks incomplete.');
					for (let index = 0; index < batch.objects.length; index++)
						checkedObjects.set(
							batch.objects[index].object_key,
							checked.slice(index * 2, index * 2 + 2)
						);
				},
				assertActive,
				client
			);
			await storageFilePool(
				deps,
				connection,
				[...objects.values()],
				(worker, object) => preserve(worker, object, checkedObjects.get(object.object_key)),
				assertActive,
				client
			);
			// Persist linkage only after every independent remote operation has drained.
			for (const object of objects.values()) {
				assertActive();
				db.prepare(
					'UPDATE storage_file_objects SET backup_linked_at=? WHERE destination=? AND object_key=?'
				).run(now, destination, object.object_key);
			}
			for (const entry of frozen) {
				assertActive();
				const object = validObject(objectRow.get(destination, entry.object_key));
				manifest.files.push({
					path: entry.path,
					role: roles.get(entry.path) || 'attachment',
					sha256: object.sha256,
					remoteSha256: object.remote_sha256,
					bytes: object.bytes,
					object: object.object_key
				});
				reusedObjects++;
				progress.add('files');
			}
			progress.set({ bundles: uploadedObjects + reusedObjects, uploadedObjects, reusedObjects });
			async function fence() {
				await assertSources();
				for (const [key, identity] of frozenObjects) {
					const current = objectRow.get(destination, key);
					if (!current || objectIdentity(current) !== identity)
						throw new Error('Recovery object changed.');
				}
				if (
					db.prepare('SELECT 1 FROM storage_file_queue LIMIT 1').get() ||
					ordered(
						db
							.prepare('SELECT * FROM storage_file_catalog WHERE deleted_at IS NULL ORDER BY path')
							.all()
							.map((row) => [row.path, row])
					) !== ordered(frozen.map((row) => [row.path, row]))
				)
					throw new Error('Recovery catalog changed.');
				assertActive();
			}
			await fence();
			helpers.validateManifest(manifest);
			const serialized = JSON.stringify(manifest);
			if (Buffer.byteLength(serialized) > MAX_MANIFEST_BYTES)
				throw new Error('Recovery manifest too large.');
			progress.set({ phase: 'publishing' });
			const plain = path.join(work, 'manifest.json');
			const encrypted = path.join(work, 'manifest.enc');
			await fs.writeFile(plain, serialized, { mode: 0o600 });
			await deps.encryptFile(plain, encrypted);
			const remoteManifest = deps.storagePath(connection, 'backups', 'manifests', `${id}.enc`);
			await upload(client, encrypted, remoteManifest);
			if ((await hashRemote(client, remoteManifest)) !== (await storageFileDigest(encrypted)))
				throw new Error('Recovery manifest changed.');
			const index = path.join(work, 'index.json');
			await fs.writeFile(index, JSON.stringify({ id, kind: 'full', createdAt: now }), {
				mode: 0o600
			});
			const pending = deps.storagePath(connection, 'backups', 'indexes', `${id}.pending`);
			await upload(client, index, pending);
			await fence();
			progress.set({ phase: 'publishing' });
			assertActive();
			await client.rename(
				pending,
				deps.storagePath(connection, 'backups', 'indexes', `${id}.full.json`)
			);
		});
		return {
			id,
			kind: 'full',
			createdAt: now,
			files: manifest.files.length,
			archivedFiles: archives.length,
			bytes: manifest.files.reduce((sum, entry) => sum + entry.bytes, 0),
			uploadedObjects,
			reusedObjects
		};
	} catch {
		aborted = true;
		throw new Error('Recovery backup failed.');
	} finally {
		progress.set({ phase: 'cleanup' });
		try {
			await helpers.cleanupRecovery(snapshot, work);
		} finally {
			progress.finish();
		}
	}
}
