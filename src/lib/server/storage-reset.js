import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { hashLocal } from './storage-audio.js';
import { decryptFile } from './storage-crypto.js';
import { storageDestination } from './storage-settings.js';
import { storagePath, withStorage } from './storage-transport.js';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const audioName = new RegExp(`^${uuid}\\.enc$`);
const manifestName = new RegExp(`^\\d{1,16}-${uuid}\\.enc$`);
const indexName = new RegExp(`^\\d{1,16}-${uuid}\\.(database|full)\\.json$`);
const objectName = /^[a-f0-9]{64}\.enc$/;
const digest = /^[a-f0-9]{64}$/;

function attribute(attributes, name) {
	return (
		attributes?.[name] === true || (typeof attributes?.[name] === 'function' && attributes[name]())
	);
}

async function existingAttributes(client, path) {
	try {
		return await client.lstat(path);
	} catch (error) {
		if (error.code === 2 || error.code === 'ENOENT') return null;
		throw error;
	}
}

async function directory(client, path) {
	const attributes = await existingAttributes(client, path);
	if (
		attributes &&
		(!attribute(attributes, 'isDirectory') || attribute(attributes, 'isSymbolicLink'))
	)
		throw new Error('Reset requires real storage directories.');
	return attributes;
}

async function remotePlan(client, connection) {
	const files = [];
	const folders = [];
	async function collect(segments, pattern) {
		const path = storagePath(connection, ...segments);
		if (!(await directory(client, path))) return;
		const entries = await client.list(path);
		if (entries.length > 200_000) throw new Error('Storage reset listing limit exceeded.');
		for (const entry of entries) {
			if (!pattern.test(entry.name) || entry.type !== '-')
				throw new Error('Unexpected file in application storage; reset stopped.');
			files.push(storagePath(connection, ...segments, entry.name));
		}
		folders.push(path);
	}
	const backups = storagePath(connection, 'backups');
	if (await directory(client, backups)) {
		for (const entry of await client.list(backups))
			if (!['indexes', 'manifests', 'objects'].includes(entry.name) || entry.type !== 'd')
				throw new Error('Unexpected directory in application backup storage.');
		// Remove completed-point indexes before the objects they reference.
		await collect(['backups', 'indexes'], indexName);
		await collect(['backups', 'manifests'], manifestName);
		await collect(['backups', 'objects'], objectName);
		folders.push(backups);
	}
	await collect(['audio'], audioName);
	return { files, folders };
}

async function localTarget(path, roots) {
	const target = resolve(path);
	let root;
	for (const candidate of roots) {
		const absolute = resolve(candidate);
		const sub = relative(absolute, target);
		if (
			sub &&
			sub !== '..' &&
			!sub.startsWith(`..\\`) &&
			!sub.startsWith('../') &&
			!isAbsolute(sub)
		) {
			root = absolute;
			break;
		}
	}
	if (!root || (await realpath(root)) !== root || !(await lstat(root)).isDirectory())
		throw new Error('Reset audio path is outside real upload directories.');
	const segments = relative(root, target).split(/[\\/]/);
	let parent = root;
	for (const segment of segments.slice(0, -1)) {
		parent = join(parent, segment);
		try {
			await mkdir(parent, { mode: 0o700 });
			if (process.platform !== 'win32') await syncFile(dirname(parent));
		} catch (error) {
			if (error.code !== 'EEXIST') throw error;
		}
		const attributes = await lstat(parent);
		if (!attributes.isDirectory() || attributes.isSymbolicLink())
			throw new Error('Reset audio path contains an unsafe directory.');
	}
	return { target, parent };
}

async function matches(file, saved) {
	try {
		const attributes = await lstat(file);
		if (!attributes.isFile() || attributes.isSymbolicLink())
			throw new Error('Unsafe local audio file.');
		if (attributes.size !== saved.bytes || (await hashLocal(file)) !== saved.sha256)
			throw new Error('Local audio differs from the archived copy; reset stopped.');
		return true;
	} catch (error) {
		if (error.code === 'ENOENT') return false;
		throw error;
	}
}

async function syncFile(file) {
	const handle = await open(file, process.platform === 'win32' ? 'r+' : 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function resetStorageData(
	db,
	connection,
	{
		jobId,
		owned = () => true,
		transport = withStorage,
		roots = ['uploads', ...(process.env.VOICE_SAVE_DIR ? [process.env.VOICE_SAVE_DIR] : [])]
	} = {}
) {
	async function assertOwned() {
		if (!(await owned())) throw new Error('Storage reset no longer owns the worker.');
	}
	const request = db.prepare('SELECT * FROM storage_reset_requests WHERE job_id=?').get(jobId);
	if (!request) throw new Error('Missing storage reset request.');
	const destination = storageDestination(connection);
	return transport({ ...connection, operationTimeoutMs: 6 * 60 * 60 * 1000 }, async (client) => {
		await assertOwned();
		if (request.phase === 'recovering') {
			await directory(client, storagePath(connection, 'audio'));
			const rows = db.prepare('SELECT * FROM storage_audio ORDER BY path').all();
			db.prepare('UPDATE storage_reset_requests SET total=?,restored=0 WHERE job_id=?').run(
				rows.length,
				jobId
			);
			let recovered = 0;
			for (const saved of rows) {
				await assertOwned();
				if (
					saved.destination !== destination ||
					!audioName.test(saved.object_key) ||
					!digest.test(saved.sha256) ||
					!digest.test(saved.remote_sha256) ||
					!Number.isSafeInteger(saved.bytes) ||
					saved.bytes < 0
				)
					throw new Error('Invalid archive metadata; reset stopped.');
				const { target, parent } = await localTarget(saved.path, roots);
				if (!(await matches(target, saved))) {
					const space = await statfs(parent, { bigint: true });
					if (space.bavail * space.bsize < BigInt(saved.bytes) * 2n + 64n * 1024n * 1024n)
						throw new Error('Insufficient local disk space to recover audio safely.');
					const work = await mkdtemp(join(parent, '.storage-reset-'));
					try {
						const encrypted = join(work, `${randomUUID()}.enc`);
						const plain = join(work, 'audio');
						const remote = storagePath(connection, 'audio', saved.object_key);
						const attributes = await client.lstat(remote);
						if (
							!attribute(attributes, 'isFile') ||
							attribute(attributes, 'isSymbolicLink') ||
							!Number.isSafeInteger(attributes.size) ||
							attributes.size < saved.bytes ||
							attributes.size > saved.bytes + 1024
						)
							throw new Error('Unsafe remote audio object or unexpected size.');
						await client.get(remote, encrypted);
						if ((await hashLocal(encrypted)) !== saved.remote_sha256)
							throw new Error('Corrupt encrypted audio.');
						await decryptFile(encrypted, plain);
						if (!(await matches(plain, saved))) throw new Error('Recovered audio is missing.');
						await syncFile(plain);
						await assertOwned();
						try {
							await link(plain, target);
						} catch (error) {
							if (error.code !== 'EEXIST' || !(await matches(target, saved))) throw error;
						}
						if (process.platform !== 'win32') await syncFile(parent);
					} finally {
						await rm(work, { recursive: true, force: true });
					}
				}
				await syncFile(target);
				db.prepare('UPDATE storage_reset_requests SET restored=? WHERE job_id=?').run(
					++recovered,
					jobId
				);
			}
			for (const saved of rows) {
				await assertOwned();
				const { target } = await localTarget(saved.path, roots);
				if (!(await matches(target, saved))) throw new Error('Audio disappeared before reset.');
			}
			await remotePlan(client, connection);
			await assertOwned();
			db.transaction(() => {
				db.prepare('DELETE FROM storage_audio').run();
				db.prepare("UPDATE storage_reset_requests SET phase='cleaning' WHERE job_id=?").run(jobId);
			})();
		}
		const plan = await remotePlan(client, connection);
		for (const path of plan.files) {
			await assertOwned();
			const attributes = await existingAttributes(client, path);
			if (attributes) {
				if (!attribute(attributes, 'isFile') || attribute(attributes, 'isSymbolicLink'))
					throw new Error('Remote storage changed during reset.');
				await client.delete(path, true);
			}
			db.prepare('UPDATE storage_reset_requests SET deleted=deleted+1 WHERE job_id=?').run(jobId);
		}
		for (const path of plan.folders) {
			await assertOwned();
			if (await directory(client, path)) await client.rmdir(path, false);
		}
		await assertOwned();
		db.transaction(() => {
			db.prepare('DELETE FROM storage_jobs WHERE id<>?').run(jobId);
			db.prepare("UPDATE storage_reset_requests SET phase='complete' WHERE job_id=?").run(jobId);
		})();
		const result = db
			.prepare('SELECT restored,total,deleted FROM storage_reset_requests WHERE job_id=?')
			.get(jobId);
		return { reset: true, ...result };
	});
}
