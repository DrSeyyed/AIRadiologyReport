import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdtemp, readFile, realpath, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, join, extname } from 'node:path';
import { withStorage, storagePath, hashRemote } from './storage-transport.js';
import { encryptFile, decryptFile } from './storage-crypto.js';
import { getStorageConnection, storageDestination } from './storage-settings.js';

export async function hashLocal(path) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
}

export function audioReferences(db) {
	return db
		.prepare(
			`SELECT audio_report_path AS path, MIN(created_at) AS created_at FROM (
		SELECT audio_report_path, created_at FROM study_recordings WHERE audio_report_path IS NOT NULL
		UNION ALL SELECT audio_report_path, created_at FROM recording_audio_parts
	) GROUP BY audio_report_path`
		)
		.all();
}

async function safeLocal(path, roots) {
	const absolute = resolve(path);
	const actual = await realpath(absolute);
	if (actual !== absolute || !(await lstat(absolute)).isFile())
		throw new Error('Audio source must be a regular file, not a symbolic link.');
	if (
		!roots.some((root) => {
			const sub = relative(resolve(root), absolute);
			return sub && !sub.startsWith('..') && !isAbsolute(sub);
		})
	)
		throw new Error('Audio source is outside the configured upload folders.');
	return absolute;
}

function referenced(db, path) {
	return Boolean(
		db
			.prepare(
				`SELECT 1 FROM study_recordings WHERE audio_report_path = ?
		UNION ALL SELECT 1 FROM recording_audio_parts WHERE audio_report_path = ? LIMIT 1`
			)
			.get(path, path)
	);
}

function processing(db, path) {
	return Boolean(
		db
			.prepare(
				`SELECT 1 FROM study_recordings WHERE processing = 1 AND (audio_report_path = ? OR id IN
		(SELECT recording_id FROM recording_audio_parts WHERE audio_report_path = ?)) LIMIT 1`
			)
			.get(path, path)
	);
}

export async function archiveAudio(
	db,
	connection,
	{
		now = Math.floor(Date.now() / 1000),
		limit = 100,
		concurrency = 4,
		roots = ['uploads', ...(process.env.VOICE_SAVE_DIR ? [process.env.VOICE_SAVE_DIR] : [])],
		transport = withStorage,
		owned = () => true
	} = {}
) {
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 100 ||
		!Number.isSafeInteger(concurrency) ||
		concurrency < 1 ||
		concurrency > 4
	)
		throw new Error('Invalid archive batch limits.');
	const destination = storageDestination(connection);
	let copied = 0;
	let evicted = 0;
	let failure;
	const sessions = [];
	const callbacks = [];
	const clients = new WeakMap();
	const assertActive = () => {
		if (failure) throw failure;
		if (!owned()) throw new Error('Storage worker lease expired.');
	};
	const failed = (error) => {
		failure ||= error;
		throw error;
	};
	const runSession = (action) => {
		const session = Promise.resolve()
			.then(() =>
				transport(connection, (client) => {
					const callback = Promise.resolve()
						.then(() => action(client))
						.catch(failed);
					callbacks.push(callback);
					return callback;
				})
			)
			.catch(failed);
		sessions.push(session);
		return session;
	};
	const directory = await mkdtemp(join(tmpdir(), 'radiology-archive-'));
	try {
		await runSession(async (client) => {
			assertActive();
			const audioDirectory = storagePath(connection, 'audio');
			await client.mkdir(audioDirectory, true);
			const remoteDirectory = await client.lstat(audioDirectory);
			if (!remoteDirectory.isDirectory || remoteDirectory.isSymbolicLink)
				throw new Error('Remote audio directory must not be a symbolic link.');
			for (const orphan of db
				.prepare(
					`SELECT a.* FROM storage_audio a
				WHERE NOT EXISTS (SELECT 1 FROM study_recordings r WHERE r.audio_report_path = a.path)
				AND NOT EXISTS (SELECT 1 FROM recording_audio_parts p WHERE p.audio_report_path = a.path)`
				)
				.all()) {
				assertActive();
				if (orphan.destination !== destination || referenced(db, orphan.path)) continue;
				await client.delete(storagePath(connection, 'audio', orphan.object_key), true);
				assertActive();
				if (!referenced(db, orphan.path))
					db.prepare('DELETE FROM storage_audio WHERE path = ?').run(orphan.path);
			}
			assertActive();
			const refs = [];
			let selected = 0;
			for (const ref of audioReferences(db)) {
				const saved = db.prepare('SELECT * FROM storage_audio WHERE path = ?').get(ref.path);
				if (saved && saved.destination !== destination)
					throw new Error('Audio belongs to a different storage destination.');
				if (!saved) {
					if (selected++ < limit) refs.push(ref);
					continue;
				}
				const created = Date.parse(`${ref.created_at.replace(' ', 'T')}Z`) / 1000;
				if (
					Number.isFinite(created) &&
					created <= now - connection.localRetentionDays * 86400 &&
					!saved.evicted_at &&
					!processing(db, ref.path) &&
					db
						.prepare(
							"SELECT 1 FROM storage_jobs WHERE kind='full' AND status='succeeded' AND started_at>? LIMIT 1"
						)
						.get(saved.archived_at)
				)
					refs.push(ref);
			}
			let next = 0;
			const run = async (workerClient) => {
				// Injected transports can share a client; never interleave its upload/verification pairs.
				const previous = clients.get(workerClient) || Promise.resolve();
				let release;
				clients.set(
					workerClient,
					new Promise((resolve) => {
						release = resolve;
					})
				);
				await previous;
				try {
					assertActive();
					const attributes = await workerClient.lstat(audioDirectory);
					if (!attributes.isDirectory || attributes.isSymbolicLink)
						throw new Error('Remote audio directory must not be a symbolic link.');
					while (next < refs.length) {
						assertActive();
						const ref = refs[next++];
						if (!referenced(db, ref.path)) continue;
						let saved = db.prepare('SELECT * FROM storage_audio WHERE path = ?').get(ref.path);
						if (saved && saved.destination !== destination)
							throw new Error('Audio belongs to a different storage destination.');
						if (!saved) {
							const local = await safeLocal(ref.path, roots);
							const before = await stat(local);
							const sha256 = await hashLocal(local);
							const objectKey = `${randomUUID()}.enc`;
							const encrypted = join(directory, objectKey);
							await encryptFile(local, encrypted);
							if ((await hashLocal(local)) !== sha256 || (await stat(local)).size !== before.size)
								throw new Error('Audio changed during archiving; the local copy was preserved.');
							const remote = storagePath(connection, 'audio', objectKey);
							const remoteSha256 = await hashLocal(encrypted);
							try {
								assertActive();
								await workerClient.put(encrypted, remote);
								assertActive();
								if ((await hashRemote(workerClient, remote)) !== remoteSha256)
									throw new Error(
										'Audio storage verification failed; the local copy was preserved.'
									);
								assertActive();
							} catch (error) {
								try {
									await workerClient.delete(remote, true);
								} catch {
									/* A disconnected server may retain an unreferenced encrypted partial object. */
								}
								throw error;
							}
							await unlink(encrypted);
							assertActive();
							if (!referenced(db, ref.path)) {
								await workerClient.delete(remote, true);
								continue;
							}
							db.prepare(
								`INSERT INTO storage_audio(path,object_key,sha256,remote_sha256,bytes,archived_at,destination)
						VALUES(?,?,?,?,?,?,?)`
							).run(ref.path, objectKey, sha256, remoteSha256, before.size, now, destination);
							saved = db.prepare('SELECT * FROM storage_audio WHERE path = ?').get(ref.path);
							copied++;
						}
						const created = Date.parse(`${ref.created_at.replace(' ', 'T')}Z`) / 1000;
						if (
							!Number.isFinite(created) ||
							created > now - connection.localRetentionDays * 86400 ||
							saved.evicted_at ||
							processing(db, ref.path)
						)
							continue;
						// Eviction requires a separately completed recovery backup taken after archiving.
						if (
							!db
								.prepare(
									"SELECT 1 FROM storage_jobs WHERE kind = 'full' AND status = 'succeeded' AND started_at > ? LIMIT 1"
								)
								.get(saved.archived_at)
						)
							continue;
						try {
							await access(ref.path);
						} catch {
							continue;
						}
						const local = await safeLocal(ref.path, roots);
						if ((await hashLocal(local)) !== saved.sha256)
							throw new Error('Local audio changed after archiving; eviction was cancelled.');
						if (
							(await hashRemote(
								workerClient,
								storagePath(connection, 'audio', saved.object_key)
							)) !== saved.remote_sha256
						)
							throw new Error('Archived audio verification failed; eviction was cancelled.');
						assertActive();
						if (!referenced(db, ref.path) || processing(db, ref.path)) continue;
						await unlink(local);
						db.prepare('UPDATE storage_audio SET evicted_at = ? WHERE path = ?').run(now, ref.path);
						evicted++;
					}
				} catch (error) {
					failed(error);
				} finally {
					release();
				}
			};
			const workers = [];
			for (let index = 1; index < Math.min(concurrency, refs.length); index++)
				workers.push(runSession(run));
			workers.push(run(client));
			await Promise.allSettled(workers);
			assertActive();
		});
		return { copied, evicted };
	} catch (error) {
		failed(error);
	} finally {
		// A transport timeout can settle before its callback finishes using an encrypted spool.
		await Promise.allSettled(sessions);
		await Promise.allSettled(callbacks);
		await rm(directory, { recursive: true, force: true });
	}
}

export async function withAudioFile(db, path, action, { transport = withStorage } = {}) {
	let localExists = true;
	try {
		await access(path);
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
		localExists = false;
	}
	if (localExists) return action(path);
	const saved = db.prepare('SELECT * FROM storage_audio WHERE path = ?').get(path);
	if (!saved || !referenced(db, path))
		throw Object.assign(new Error('Audio file not found.'), { status: 404 });
	const connection = getStorageConnection(db);
	if (saved.destination !== storageDestination(connection))
		throw new Error('Archived audio storage destination does not match.');
	const directory = await mkdtemp(join(tmpdir(), 'radiology-retrieval-'));
	try {
		const encrypted = join(directory, 'audio.enc');
		const local = join(directory, `audio${extname(path)}`);
		try {
			await transport(connection, async (client) =>
				client.get(storagePath(connection, 'audio', saved.object_key), encrypted)
			);
			if ((await hashLocal(encrypted)) !== saved.remote_sha256)
				throw new Error('Archived audio verification failed.');
			await decryptFile(encrypted, local);
			if ((await stat(local)).size !== saved.bytes || (await hashLocal(local)) !== saved.sha256)
				throw new Error('Archived audio verification failed.');
		} catch {
			throw Object.assign(
				new Error(
					'Archived audio is unavailable or failed verification. The previous report has been preserved.'
				),
				{ status: 503 }
			);
		}
		if (!referenced(db, path))
			throw Object.assign(new Error('Audio is no longer attached to this recording.'), {
				status: 404
			});
		return await action(local);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export async function withRecordingAudio(db, recording, action, options) {
	const paths = new Map();
	async function part(index) {
		if (index === recording.audio_parts.length)
			return action({
				...recording,
				audio_report_path: paths.get(recording.audio_report_path) ?? recording.audio_report_path,
				audio_parts: recording.audio_parts.map((entry) => ({
					...entry,
					audio_report_path: paths.get(entry.audio_report_path)
				}))
			});
		const path = recording.audio_parts[index].audio_report_path;
		return withAudioFile(
			db,
			path,
			async (local) => {
				paths.set(path, local);
				return part(index + 1);
			},
			options
		);
	}
	return part(0);
}

export async function readStoredAudio(db, path, options) {
	return withAudioFile(db, path, (local) => readFile(local), options);
}
