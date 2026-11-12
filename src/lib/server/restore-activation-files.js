import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, readFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

// apply/rollback require an exclusively stopped application, before any live SQLite open.
// The caller must treat ANY rejection as a boot veto, and call finalize only after health checks.
// Environment files are never installed. Missing staged voice means an empty voice root.
// Inventories and journal checksums detect corruption, not a hostile filesystem administrator.
// Rollback/history and failed verification copies are retained for offline recovery.
// Only health-confirmed completion permits best-effort removal of its temporary source.
// Directory fsync requires POSIX for power-loss durability. Windows supports file fsync only.
// Unreadable/corrupt locks or reused live PIDs fail closed. Locks require one shared PID namespace.
const ROOTS = ['db', 'uploads', 'voice'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES = [
	'queued',
	'backing_up',
	'backed_up',
	'installing',
	'installed',
	'rolling_back',
	'rolled_back',
	'completed'
];
const TERMINAL = ['rolled_back', 'completed'];
const active = new Set();
const fail = () => new Error('Restore activation unavailable; offline recovery required.');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const validId = (id) => typeof id === 'string' && UUID.test(id);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function component(name) {
	if (
		typeof name !== 'string' ||
		!name ||
		/[\\/<>:"|?*]/.test(name) ||
		Array.from(name).some((character) => character.codePointAt(0) < 32) ||
		name === '.' ||
		name === '..' ||
		/[. ]$/.test(name) ||
		/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
	)
		throw fail();
}

async function directories(directory, create = false) {
	const absolute = path.resolve(directory);
	let current = path.parse(absolute).root;
	for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		if (create) {
			let created = false;
			try {
				await fs.mkdir(current, { mode: 0o700 });
				created = true;
			} catch (e) {
				if (e.code !== 'EEXIST') throw e;
			}
			if (created) {
				await syncDirectory(current);
				await syncDirectory(path.dirname(current));
			}
		}
		const stat = await fs.lstat(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
	}
}

async function syncDirectory(directory) {
	let handle;
	try {
		handle = await fs.open(directory, 'r');
		await handle.sync();
	} catch (e) {
		// Windows does not expose directory fsync through Node. File fsync is still required.
		if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL', 'EACCES'].includes(e.code))
			throw e;
	} finally {
		await handle?.close();
	}
}

async function present(file) {
	try {
		return await fs.lstat(file);
	} catch (e) {
		if (e.code !== 'ENOENT') throw e;
		return null;
	}
}

async function regular(file) {
	await directories(path.dirname(file));
	const stat = await fs.lstat(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail();
	return stat;
}

async function hashFile(file, destination) {
	const before = await regular(file);
	const input = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
	let output;
	try {
		const opened = await input.stat();
		if (opened.ino !== before.ino || opened.dev !== before.dev) throw fail();
		if (destination) {
			await directories(path.dirname(destination), true);
			output = await fs.open(destination, 'wx', 0o600);
		}
		const hash = createHash('sha256');
		const buffer = Buffer.alloc(1024 * 1024);
		let bytes = 0;
		for (;;) {
			const read = await input.read(buffer, 0, buffer.length, null);
			if (!read.bytesRead) break;
			const chunk = buffer.subarray(0, read.bytesRead);
			hash.update(chunk);
			if (output) {
				let offset = 0;
				while (offset < chunk.length) {
					const written = await output.write(chunk, offset, chunk.length - offset);
					if (!written.bytesWritten) throw fail();
					offset += written.bytesWritten;
				}
			}
			bytes += read.bytesRead;
		}
		const after = await regular(file);
		if (
			after.ino !== before.ino ||
			after.dev !== before.dev ||
			after.size !== bytes ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs
		)
			throw fail();
		if (output) await output.sync();
		return { bytes, sha256: hash.digest('hex') };
	} finally {
		await input.close();
		await output?.close();
		if (output) await syncDirectory(path.dirname(destination));
	}
}

function seal(value) {
	return { ...value, seal: digest(JSON.stringify(value)) };
}

function validateInventory(inventory) {
	if (
		!inventory ||
		!Array.isArray(inventory.roots) ||
		!Array.isArray(inventory.directories) ||
		!Array.isArray(inventory.files) ||
		inventory.files.length > 100000 ||
		!inventory.roots.every((root, i, all) => ROOTS.includes(root) && all.indexOf(root) === i)
	)
		throw fail();
	const names = new Set();
	for (const entry of [
		...inventory.directories.map((name) => ({ path: name })),
		...inventory.files
	]) {
		if (typeof entry.path !== 'string') throw fail();
		const parts = entry.path.split('/');
		parts.forEach(component);
		if (!inventory.roots.includes(parts[0]) || names.has(entry.path.toLowerCase())) throw fail();
		names.add(entry.path.toLowerCase());
	}
	for (const file of inventory.files) {
		if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256))
			throw fail();
		if (file.path.split('/').length < 2) throw fail();
	}
	const value = {
		roots: inventory.roots,
		directories: inventory.directories,
		files: inventory.files,
		bytes: inventory.files.reduce((sum, file) => sum + file.bytes, 0)
	};
	if (!Number.isSafeInteger(value.bytes) || !same(seal(value), inventory)) throw fail();
	const dirs = new Set(inventory.directories);
	if (!inventory.roots.every((root) => dirs.has(root))) throw fail();
	for (const name of [...inventory.directories, ...inventory.files.map((file) => file.path)]) {
		const parent = name.slice(0, name.lastIndexOf('/'));
		if (name.includes('/') && !dirs.has(parent)) throw fail();
	}
	return inventory;
}

async function inventoryAt(base, roots = ROOTS, emptyVoice = false) {
	await directories(base);
	const files = [],
		dirs = [],
		found = [];
	const names = new Set();
	const identities = new Set();
	async function walk(relative, device) {
		const absolute = path.join(base, ...relative.split('/'));
		// NTFS directory IDs can exceed Number precision and falsely appear identical.
		const stat = await fs.lstat(absolute, { bigint: true });
		if (stat.isSymbolicLink() || (device !== undefined && stat.dev !== device)) throw fail();
		const key = relative.toLowerCase();
		if (names.has(key)) throw fail();
		names.add(key);
		if (stat.isDirectory()) {
			const identity = `${stat.dev}:${stat.ino}`;
			if (identities.has(identity)) throw fail();
			identities.add(identity);
			dirs.push(relative);
			for (const name of (await fs.readdir(absolute)).sort()) {
				component(name);
				await walk(`${relative}/${name}`, stat.dev);
			}
		} else {
			if (!stat.isFile() || files.length >= 100000) throw fail();
			files.push({ path: relative, ...(await hashFile(absolute)) });
		}
	}
	for (const root of roots) {
		if (await present(path.join(base, root))) {
			await directories(path.join(base, root));
			found.push(root);
			await walk(root);
		} else if (emptyVoice && root === 'voice') {
			found.push(root);
			dirs.push(root);
		}
	}
	return validateInventory(
		seal({
			roots: found,
			directories: dirs,
			files,
			bytes: files.reduce((sum, file) => sum + file.bytes, 0)
		})
	);
}

async function copyInventory(from, to, inventory, hook = async () => {}, point = 'copy_file') {
	validateInventory(inventory);
	await directories(to, true);
	for (const directory of inventory.directories)
		await directories(path.join(to, ...directory.split('/')), true);
	for (const file of inventory.files) {
		const result = await hashFile(
			path.join(from, ...file.path.split('/')),
			path.join(to, ...file.path.split('/'))
		);
		if (!same(result, { bytes: file.bytes, sha256: file.sha256 })) throw fail();
		await hook(point);
	}
	for (const directory of [...inventory.directories].reverse())
		await syncDirectory(path.join(to, ...directory.split('/')));
	await syncDirectory(to);
	if (!same(await inventoryAt(to, inventory.roots), inventory)) throw fail();
}

async function databaseIntegrity(base, control, staged = false) {
	const dbRoot = path.join(base, 'db');
	await directories(dbRoot);
	await regular(path.join(dbRoot, 'pacs.db'));
	if (staged) {
		for (const name of await fs.readdir(dbRoot)) {
			if (!['pacs.db', 'integration-restore.json'].includes(name)) throw fail();
			await regular(path.join(dbRoot, name));
		}
	}
	// SQLite may recover a hot journal or update SHM even on a read-only connection.
	// Validate a private copy, never the staged/rollback WAL+SHM set itself.
	const scratch = path.join(control, 'verification', randomUUID());
	const dbInventory = await inventoryAt(base, ['db']);
	await directories(path.dirname(scratch), true);
	await fs.mkdir(scratch, { mode: 0o700 });
	const identity = directoryIdentity(await fs.lstat(scratch, { bigint: true }));
	await copyInventory(base, scratch, dbInventory);
	let db;
	try {
		db = new Database(path.join(scratch, 'db', 'pacs.db'), { fileMustExist: true });
		const result = db.pragma('integrity_check');
		if (result.length !== 1 || result[0].integrity_check !== 'ok') throw fail();
	} finally {
		db?.close();
	}
	// Cleanup is secondary to validation, and only follows a successful check and close.
	try {
		await removePrivateTree(scratch, identity, control);
	} catch {
		// Retain evidence rather than weakening the deletion safeguards.
	}
}

const directoryIdentity = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino) });
const identityKey = (stat) => `${stat.dev}:${stat.ino}`;

// Preflight the ENTIRE tree, including preparation metadata, before deleting anything.
// Never use recursive rm: each deletion rechecks ancestry and the preflight identity.
async function removePrivateTree(directory, expected, control) {
	const staging = path.dirname(control);
	const parent = path.dirname(directory);
	if (
		!validId(path.basename(directory)) ||
		(parent !== staging && parent !== path.join(control, 'verification'))
	)
		throw fail();
	await directories(parent);
	if (!(await present(directory))) {
		await syncDirectory(parent);
		return;
	}
	if (process.platform === 'linux') {
		// Same-device bind mounts are invisible to dev comparisons. Never clear a
		// mount point (or a tree containing one), even if rmdir would later fail.
		const mountinfo = await fs.readFile(
			path.join(path.parse(directory).root, 'proc', 'self', 'mountinfo'),
			'utf8'
		);
		for (const line of mountinfo.trim().split('\n')) {
			const field = line.split(' ')[4];
			if (!field) throw fail();
			const mounted = field.replace(/\\([0-7]{3})/g, (_, octal) =>
				String.fromCharCode(parseInt(octal, 8))
			);
			if (mounted === directory || mounted.startsWith(directory + path.sep)) throw fail();
		}
	}
	const protectedIds = new Set();
	for (let ancestor = parent; ; ancestor = path.dirname(ancestor)) {
		protectedIds.add(identityKey(await fs.lstat(ancestor, { bigint: true })));
		if (ancestor === path.dirname(ancestor)) break;
	}
	const visited = new Set();
	async function protect(absolute) {
		if (absolute === directory) return;
		const stat = await fs.lstat(absolute, { bigint: true });
		// A protected symlink could itself reference this temporary tree.
		if (stat.isSymbolicLink()) throw fail();
		if (!stat.isDirectory()) return;
		const key = identityKey(stat);
		protectedIds.add(key);
		if (visited.has(key)) return;
		visited.add(key);
		for (const name of await fs.readdir(absolute)) {
			component(name);
			await protect(path.join(absolute, name));
		}
	}
	const cwd = path.dirname(staging);
	for (const root of [...ROOTS.map((name) => path.join(cwd, name)), staging]) {
		if (await present(root)) await protect(root);
	}
	const device = (await fs.lstat(parent, { bigint: true })).dev;
	const entries = [];
	const identities = new Set();
	async function preflight(absolute) {
		const stat = await fs.lstat(absolute, { bigint: true });
		if (stat.isSymbolicLink() || stat.dev !== device) throw fail();
		if (absolute === directory && !same(directoryIdentity(stat), expected)) throw fail();
		if (stat.isDirectory()) {
			const key = identityKey(stat);
			if (protectedIds.has(key) || identities.has(key)) throw fail();
			identities.add(key);
			for (const name of await fs.readdir(absolute)) {
				component(name);
				await preflight(path.join(absolute, name));
			}
		} else if (!stat.isFile() || stat.nlink !== 1n) throw fail();
		if (absolute === directory && !stat.isDirectory()) throw fail();
		entries.push({ absolute, stat });
	}
	await preflight(directory);
	for (const { absolute, stat: before } of entries) {
		await directories(path.dirname(absolute));
		const stat = await fs.lstat(absolute, { bigint: true });
		if (
			stat.isSymbolicLink() ||
			identityKey(stat) !== identityKey(before) ||
			stat.isDirectory() !== before.isDirectory() ||
			(!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))
		)
			throw fail();
		if (stat.isDirectory()) await fs.rmdir(absolute);
		else await fs.unlink(absolute);
		await syncDirectory(path.dirname(absolute));
	}
}

async function distinctDirectories(paths) {
	const identities = new Set();
	for (const directory of paths) {
		if (!(await present(directory))) continue;
		await directories(directory);
		const stat = await fs.lstat(directory, { bigint: true });
		const identity = `${stat.dev}:${stat.ino}`;
		if (identities.has(identity)) throw fail();
		identities.add(identity);
	}
}

function liveDirectories(ctx) {
	return [ctx.cwd, ...ROOTS.map((root) => path.join(ctx.cwd, root)), ctx.staging, ctx.control];
}

async function context(cwd) {
	cwd = path.resolve(cwd);
	await directories(cwd);
	const staging = path.join(cwd, 'restore-staging');
	const control = path.join(staging, '.activation');
	const ctx = { cwd, staging, control, request: path.join(control, 'request.json') };
	await distinctDirectories(liveDirectories(ctx));
	await directories(control, true);
	return ctx;
}

async function source(ctx, restoreId) {
	if (!validId(restoreId)) throw fail();
	const base = path.join(ctx.staging, restoreId);
	await directories(base);
	await distinctDirectories([
		...liveDirectories(ctx),
		base,
		...ROOTS.map((root) => path.join(base, root))
	]);
	for (const name of await fs.readdir(base)) {
		component(name);
		const file = path.join(base, name);
		const stat = await fs.lstat(file);
		if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw fail();
		if (stat.isFile()) await regular(file);
	}
	const inventory = await inventoryAt(base, ROOTS, true);
	if (!inventory.roots.includes('db') || !inventory.roots.includes('uploads')) throw fail();
	await databaseIntegrity(base, ctx.control, true);
	if (!same(await inventoryAt(base, ROOTS, true), inventory)) throw fail();
	return { base, inventory };
}

async function writeJson(file, value, exclusive = false) {
	const target = exclusive ? file : path.join(path.dirname(file), `journal-${randomUUID()}.json`);
	const handle = await fs.open(target, 'wx', 0o600);
	const { journalSeal: ignored, ...body } = value;
	void ignored;
	const stored = { ...body, journalSeal: digest(JSON.stringify(body)) };
	try {
		await handle.writeFile(JSON.stringify(stored));
		await handle.sync();
	} finally {
		await handle.close();
	}
	if (!exclusive) {
		await regular(file);
		await fs.rename(target, file);
	}
	await syncDirectory(path.dirname(file));
}

async function readJson(file) {
	const stat = await regular(file);
	if (stat.size > 64 * 1024 * 1024) throw fail();
	return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readRequest(ctx) {
	if (!(await present(ctx.request))) return null;
	return validateRequest(await readJson(ctx.request));
}

function validateRequest(stored) {
	const { journalSeal, ...request } = stored;
	if (digest(JSON.stringify(request)) !== journalSeal) throw fail();
	if (
		request.version !== 1 ||
		!validId(request.id) ||
		!validId(request.restoreId) ||
		!STATES.includes(request.state) ||
		typeof request.createdAt !== 'string' ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(request.createdAt) ||
		!(
			request.backupId === null ||
			(typeof request.backupId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(request.backupId))
		) ||
		!(
			request.requestedBy === null ||
			(Number.isSafeInteger(request.requestedBy) && request.requestedBy >= 0)
		)
	)
		throw fail();
	if (
		request.cleanup !== undefined &&
		(!request.cleanup ||
			!['pending', 'completed'].includes(request.cleanup.state) ||
			!/^\d+$/.test(request.cleanup.dev) ||
			!/^\d+$/.test(request.cleanup.ino) ||
			typeof request.cleanup.dev !== 'string' ||
			typeof request.cleanup.ino !== 'string' ||
			(request.cleanup.state === 'completed' && request.state !== 'completed'))
	)
		throw fail();
	validateInventory(request.source);
	if (
		!request.source.roots.includes('db') ||
		!request.source.roots.includes('uploads') ||
		request.source.files
			.filter((file) => file.path.startsWith('db/'))
			.some((file) => !['db/pacs.db', 'db/integration-restore.json'].includes(file.path)) ||
		!request.source.files.some((file) => file.path === 'db/pacs.db')
	)
		throw fail();
	if (request.state !== 'queued') {
		validateInventory(request.original);
		if (
			!request.original.files.some((file) => file.path === 'db/pacs.db') ||
			!validId(request.attempt)
		)
			throw fail();
	}
	return request;
}

// Missing legacy cleanup metadata is unknown, not confirmation of removal.
function publicStatus(request) {
	return request
		? {
				id: request.id,
				restoreId: request.restoreId,
				backupId: request.backupId,
				requestedBy: request.requestedBy,
				state: request.state,
				createdAt: request.createdAt,
				bytes: request.source.bytes,
				...(request.state === 'completed' && request.cleanup
					? { cleanupPending: request.cleanup.state === 'pending' }
					: {}),
				...(request.attempt
					? {
							rollbackDirectory: path.join(
								'restore-staging',
								'.activation',
								'rollback',
								request.id,
								request.attempt
							)
						}
					: {})
			}
		: { state: 'idle' };
}

async function locked(cwd, operation) {
	try {
		const ctx = await context(cwd);
		const lock = path.join(ctx.control, 'operation.lock');
		if (active.has(ctx.cwd)) throw fail();
		active.add(ctx.cwd);
		const token = randomUUID();
		const candidate = path.join(ctx.control, `lock-candidate-${token}`);
		let owned = false;
		try {
			// Publish only complete, durable nonempty directories. Renaming onto another
			// nonempty directory fails atomically on POSIX and Windows, unlike file rename.
			await fs.mkdir(candidate, { mode: 0o700 });
			await writeJson(path.join(candidate, 'owner.json'), { pid: process.pid, token }, true);
			await syncDirectory(ctx.control);
			if (await present(lock)) {
				await directories(lock);
				const { journalSeal, ...owner } = await readJson(path.join(lock, 'owner.json'));
				if (
					digest(JSON.stringify(owner)) !== journalSeal ||
					!Number.isSafeInteger(owner.pid) ||
					owner.pid <= 0 ||
					!validId(owner.token)
				)
					throw fail();
				try {
					process.kill(owner.pid, 0);
					throw fail();
				} catch (error) {
					if (error.code !== 'ESRCH') throw error;
				}
				// The fixed nonempty tombstone also prevents a late concurrent reclaimer
				// from moving a newly acquired lock after the original owner was removed.
				await fs.rename(lock, path.join(ctx.control, `lock-reclaimed-${owner.token}`));
				await syncDirectory(ctx.control);
			}
			await fs.rename(candidate, lock);
			owned = true;
			await syncDirectory(ctx.control);
			return await operation(ctx);
		} finally {
			try {
				if (owned) {
					await fs.rename(lock, path.join(ctx.control, `lock-retired-${token}`));
					await syncDirectory(ctx.control);
				}
			} finally {
				active.delete(ctx.cwd);
			}
		}
	} catch {
		throw fail();
	}
}

export async function inspectActivationSource({ cwd = process.cwd(), restoreId } = {}) {
	try {
		const ctx = await context(cwd);
		const { inventory } = await source(ctx, restoreId);
		return { restoreId, ...inventory };
	} catch {
		throw fail();
	}
}

export async function queueActivationFiles({
	cwd = process.cwd(),
	restoreId,
	backupId = null,
	requestedBy = null
} = {}) {
	return locked(cwd, async (ctx) => {
		const existing = await readRequest(ctx);
		if (existing && !TERMINAL.includes(existing.state)) throw fail();
		if (
			!(
				backupId === null ||
				(typeof backupId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(backupId))
			) ||
			!(requestedBy === null || (Number.isSafeInteger(requestedBy) && requestedBy >= 0))
		)
			throw fail();
		const { base, inventory } = await source(ctx, restoreId);
		const identity = directoryIdentity(await fs.lstat(base, { bigint: true }));
		if (existing) {
			const history = path.join(ctx.control, 'history');
			await directories(history, true);
			const historyFile = path.join(history, `${existing.id}.json`);
			if (await present(historyFile)) {
				if (!same(validateRequest(await readJson(historyFile)), existing)) throw fail();
			} else await writeJson(historyFile, existing, true);
			await fs.unlink(ctx.request);
			await syncDirectory(ctx.control);
		}
		const request = {
			version: 1,
			id: randomUUID(),
			restoreId,
			backupId,
			requestedBy,
			state: 'queued',
			createdAt: new Date().toISOString(),
			source: inventory,
			cleanup: { state: 'pending', ...identity }
		};
		await writeJson(ctx.request, request, true);
		return publicStatus(request);
	});
}

function statusPath(file, directory = false) {
	let current = path.parse(file).root;
	const parts = file.slice(current.length).split(path.sep).filter(Boolean);
	for (let index = 0; index < parts.length; index++) {
		current = path.join(current, parts[index]);
		let stat;
		try {
			stat = lstatSync(current);
		} catch (e) {
			if (e.code === 'ENOENT') return false;
			throw e;
		}
		if (stat.isSymbolicLink()) throw fail();
		if (index < parts.length - 1 || directory) {
			if (!stat.isDirectory()) throw fail();
		} else if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw fail();
	}
	return true;
}

// Synchronous and read-only for synchronous admin load functions. Never returns file contents.
export function activationStatus({ cwd = process.cwd() } = {}) {
	try {
		const control = path.join(path.resolve(cwd), 'restore-staging', '.activation');
		const requestFile = path.join(control, 'request.json');
		if (statusPath(requestFile))
			return publicStatus(validateRequest(JSON.parse(readFileSync(requestFile, 'utf8'))));
		const history = path.join(control, 'history');
		let latest = null;
		if (statusPath(history, true)) {
			for (const name of readdirSync(history).sort()) {
				if (!name.endsWith('.json') || !validId(name.slice(0, -5))) throw fail();
				const file = path.join(history, name);
				if (!statusPath(file)) throw fail();
				const request = validateRequest(JSON.parse(readFileSync(file, 'utf8')));
				if (request.id !== name.slice(0, -5) || !TERMINAL.includes(request.state)) throw fail();
				if (!latest || request.createdAt > latest.createdAt) latest = request;
			}
		}
		return publicStatus(latest);
	} catch {
		return { state: 'error', error: 'Restore activation unavailable; offline recovery required.' };
	}
}

async function phase(ctx, request, state, hook) {
	request.state = state;
	await writeJson(ctx.request, request);
	await hook(state);
}

async function clearContents(directory) {
	await directories(directory);
	for (const name of await fs.readdir(directory)) {
		component(name);
		const file = path.join(directory, name);
		const stat = await fs.lstat(file);
		if (stat.isSymbolicLink()) throw fail();
		if (stat.isDirectory()) {
			await clearContents(file);
			await fs.rmdir(file);
		} else {
			await regular(file);
			await fs.unlink(file);
		}
	}
	await syncDirectory(directory);
}

const rollbackPath = (ctx, request) =>
	path.join(ctx.control, 'rollback', request.id, request.attempt);

async function backup(ctx, request, hook) {
	if (request.state === 'queued') {
		for (const root of ROOTS) await directories(path.join(ctx.cwd, root), true);
		request.original = await inventoryAt(ctx.cwd);
		await databaseIntegrity(ctx.cwd, ctx.control);
	} else if (!same(await inventoryAt(ctx.cwd), request.original)) throw fail();
	request.attempt = randomUUID();
	await phase(ctx, request, 'backing_up', hook);
	const destination = rollbackPath(ctx, request);
	await copyInventory(ctx.cwd, destination, request.original, hook, 'backup_file');
	await databaseIntegrity(destination, ctx.control);
	if (!same(await inventoryAt(ctx.cwd), request.original)) throw fail();
	await phase(ctx, request, 'backed_up', hook);
}

async function replace(ctx, from, inventory, roots, hook, point) {
	// Preflight every root before the first deletion. Roots themselves may be bind mounts.
	await inventoryAt(ctx.cwd);
	for (const root of roots) {
		const target = path.join(ctx.cwd, root);
		if (await present(target)) await clearContents(target);
		else await directories(target, true);
		await hook(`${point}_cleared`);
	}
	await copyInventory(from, ctx.cwd, inventory, hook, `${point}_file`);
}

async function rollback(ctx, request, hook) {
	const from = rollbackPath(ctx, request);
	await directories(from);
	await distinctDirectories([
		...liveDirectories(ctx),
		from,
		...ROOTS.map((root) => path.join(from, root))
	]);
	if ((await fs.readdir(from)).some((name) => !ROOTS.includes(name))) throw fail();
	if (!same(await inventoryAt(from), request.original)) throw fail();
	await databaseIntegrity(from, ctx.control);
	await phase(ctx, request, 'rolling_back', hook);
	await replace(ctx, from, request.original, ROOTS, hook, 'rollback');
	// An absent original root may now be an empty mounted directory; preserve that root.
	const actual = await inventoryAt(ctx.cwd, request.original.roots);
	if (!same(actual, request.original)) throw fail();
	await databaseIntegrity(ctx.cwd, ctx.control);
	await phase(ctx, request, 'rolled_back', hook);
	return publicStatus(request);
}

async function cleanupCompleted(ctx, request, file) {
	if (request.state !== 'completed' || request.cleanup?.state === 'completed') return;
	try {
		const directory = path.join(ctx.staging, request.restoreId);
		if (!request.cleanup) {
			// Legacy journals have no source identity. Persist one before any removal.
			const stat = await fs.lstat(directory, { bigint: true });
			const cleanup = { state: 'pending', ...directoryIdentity(stat) };
			await writeJson(file, { ...request, cleanup });
			request.cleanup = cleanup;
		}
		const { dev, ino } = request.cleanup;
		await removePrivateTree(directory, { dev, ino }, ctx.control);
		const cleanup = { ...request.cleanup, state: 'completed' };
		await writeJson(file, { ...request, cleanup });
		request.cleanup = cleanup;
	} catch {
		// Completed activation is authoritative. Leave durable pending work for retry;
		// cleanup must never veto serving or cause a health-confirmed install to roll back.
	}
}

async function retryCleanup(ctx, current) {
	try {
		const requests = current ? [{ request: current, file: ctx.request }] : [];
		const history = path.join(ctx.control, 'history');
		if (await present(history)) {
			await directories(history);
			for (const name of await fs.readdir(history)) {
				if (!name.endsWith('.json') || !validId(name.slice(0, -5))) throw fail();
				const file = path.join(history, name);
				const request = validateRequest(await readJson(file));
				if (request.id !== name.slice(0, -5) || !TERMINAL.includes(request.state)) throw fail();
				requests.push({ request, file });
			}
		}
		const retained = new Set(
			requests
				.filter(({ request }) => request.state !== 'completed')
				.map(({ request }) => request.restoreId)
		);
		for (const { request, file } of requests) {
			// Old history without a cleanup marker remains operator-owned. Never remove
			// a source reused by a newer queued, failed, or restorable activation.
			if (!retained.has(request.restoreId) && (file === ctx.request || request.cleanup))
				await cleanupCompleted(ctx, request, file);
		}
	} catch {
		// History/cleanup problems are not activation failures.
	}
}

// Only a newly installed copy returns a pending health-confirmation object.
// Successful crash-recovery rollback returns null; its status remains rolled_back.
export async function applyPendingActivation({ cwd = process.cwd(), fault = async () => {} } = {}) {
	return locked(cwd, async (ctx) => {
		const request = await readRequest(ctx);
		await retryCleanup(ctx, request);
		if (!request || TERMINAL.includes(request.state)) return null;
		if (request.state !== 'queued') {
			if (request.state === 'backing_up') await backup(ctx, request, fault);
			await rollback(ctx, request, fault);
			return null;
		}
		// A changed source must fail before taking a rollback snapshot or touching live data.
		const prepared = await source(ctx, request.restoreId);
		if (!same(prepared.inventory, request.source)) throw fail();
		await backup(ctx, request, fault);
		try {
			if (!same(await inventoryAt(prepared.base, ROOTS, true), request.source)) throw fail();
			await phase(ctx, request, 'installing', fault);
			await replace(ctx, prepared.base, request.source, request.source.roots, fault, 'install');
			if (!same(await inventoryAt(ctx.cwd, request.source.roots), request.source)) throw fail();
			await databaseIntegrity(ctx.cwd, ctx.control, true);
			await phase(ctx, request, 'installed', fault);
			return publicStatus(request);
		} catch (error) {
			// Test-only crash simulation leaves the durable phase untouched, like process exit.
			if (!error.activationCrash) await rollback(ctx, request, async () => {});
			throw error;
		}
	});
}

export async function finalizeActivation({ cwd = process.cwd(), id } = {}) {
	return locked(cwd, async (ctx) => {
		const request = await readRequest(ctx);
		if (!validId(id) || request?.id !== id) throw fail();
		if (!['installed', 'completed'].includes(request.state)) throw fail();
		// The application may already have opened/migrated SQLite. Do not inspect it here.
		if (request.state === 'installed') await phase(ctx, request, 'completed', async () => {});
		await retryCleanup(ctx, request);
		return publicStatus(request);
	});
}

export async function rollbackActivation({ cwd = process.cwd(), id, fault = async () => {} } = {}) {
	return locked(cwd, async (ctx) => {
		const request = await readRequest(ctx);
		if (!validId(id) || request?.id !== id) throw fail();
		if (request.state === 'rolled_back') return publicStatus(request);
		if (['queued', 'completed'].includes(request.state)) throw fail();
		if (request.state === 'backing_up') await backup(ctx, request, fault);
		return rollback(ctx, request, fault);
	});
}
