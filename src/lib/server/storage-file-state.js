import path from 'node:path';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

export function ensureStorageFileState(db) {
	db.exec(`CREATE TABLE IF NOT EXISTS storage_file_objects (
  destination TEXT NOT NULL, object_key TEXT NOT NULL, sha256 TEXT NOT NULL, remote_sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL, encrypted_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL, backup_linked_at INTEGER,
  PRIMARY KEY(destination,object_key));
 CREATE TABLE IF NOT EXISTS storage_file_catalog (
  path TEXT PRIMARY KEY, original TEXT NOT NULL, destination TEXT NOT NULL, object_key TEXT,
  state TEXT, synced_at INTEGER, deleted_at INTEGER);
 CREATE TABLE IF NOT EXISTS storage_file_queue (
  path TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1, queued_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS storage_file_objects_audit ON storage_file_objects(destination,verified_at);
 CREATE INDEX IF NOT EXISTS storage_file_objects_content ON storage_file_objects(destination,sha256,bytes);`);
}
export function fileState(stat) {
	return JSON.stringify([stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino].map(String));
}
export async function noFileLinks(file, allowMissing = false) {
	const absolute = path.resolve(file);
	let current = path.parse(absolute).root;
	for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Unsafe storage source.');
		} catch (error) {
			if (allowMissing && error.code === 'ENOENT') return;
			throw error;
		}
	}
}
export function storageFileLocation(cwd, voice, original) {
	const absolute = path.resolve(cwd, original);
	const uploads = path.join(cwd, 'uploads');
	const within = (root) => {
		const sub = path.relative(root, absolute);
		return sub && sub !== '..' && !sub.startsWith(`..${path.sep}`) && !path.isAbsolute(sub);
	};
	const root = within(uploads) ? uploads : within(voice) ? voice : null;
	if (!root) throw new Error('Unsafe storage source.');
	const relative = `${root === uploads ? 'uploads' : 'voice'}/${path.relative(root, absolute).split(path.sep).join('/')}`;
	if (
		relative
			.split('/')
			.some(
				(s) => !s || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)
			) ||
		/[\\<>:"|?*]/.test(relative) ||
		Array.from(relative).some((character) => character.charCodeAt(0) < 32)
	)
		throw new Error('Unsafe storage source.');
	return { absolute, relative };
}
export async function storageFileDigest(file, activity = () => {}) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) {
		hash.update(chunk);
		activity();
	}
	return hash.digest('hex');
}
export async function discoverStorageFiles(cwd, voice) {
	const files = new Map();
	async function walk(directory) {
		await noFileLinks(directory, true);
		let entries;
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (error.code === 'ENOENT') return;
			throw error;
		}
		for (const entry of entries) {
			const file = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error('Unsafe storage source.');
			if (entry.isDirectory()) await walk(file);
			else if (entry.isFile()) {
				const located = storageFileLocation(cwd, voice, file);
				files.set(located.relative, {
					original: file,
					state: fileState(await fs.stat(file, { bigint: true }))
				});
			} else throw new Error('Unsafe storage source.');
		}
	}
	await walk(path.join(cwd, 'uploads'));
	const uploads = path.join(cwd, 'uploads');
	const rel = path.relative(uploads, voice);
	if (
		voice !== uploads &&
		(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
	)
		await walk(voice);
	return files;
}
