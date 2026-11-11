import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import {
	inspectActivationSource,
	queueActivationFiles,
	activationStatus,
	applyPendingActivation,
	finalizeActivation,
	rollbackActivation
} from '../src/lib/server/restore-activation-files.js';

const ROOTS = ['db', 'uploads', 'voice'];
const SAFE_ERROR = /Restore activation unavailable; offline recovery required\./;

function sqlite(file, value) {
	const db = new Database(file);
	db.exec('CREATE TABLE sample(value TEXT)');
	db.prepare('INSERT INTO sample VALUES (?)').run(value);
	db.close();
}

function value(cwd) {
	const db = new Database(path.join(cwd, 'db', 'pacs.db'), { readonly: true });
	try {
		return db.prepare('SELECT value FROM sample').pluck().get();
	} finally {
		db.close();
	}
}

async function tree(base) {
	const result = {};
	async function walk(relative) {
		const absolute = path.join(base, ...relative.split('/'));
		const stat = await fs.lstat(absolute);
		if (stat.isDirectory()) {
			result[relative] = 'directory';
			for (const name of (await fs.readdir(absolute)).sort()) await walk(`${relative}/${name}`);
		} else result[relative] = (await fs.readFile(absolute)).toString('hex');
	}
	for (const root of ROOTS) await walk(root);
	return result;
}

async function fixture(t, { voice = true } = {}) {
	const cwd = path.join(process.cwd(), 'tests', `.activation-${randomUUID()}`);
	const restoreId = randomUUID();
	const staged = path.join(cwd, 'restore-staging', restoreId);
	for (const root of ROOTS) await fs.mkdir(path.join(cwd, root), { recursive: true });
	for (const root of voice ? ROOTS : ['db', 'uploads'])
		await fs.mkdir(path.join(staged, root), { recursive: true });
	sqlite(path.join(cwd, 'db', 'pacs.db'), 'original');
	sqlite(path.join(staged, 'db', 'pacs.db'), 'restored');
	await fs.writeFile(path.join(cwd, 'uploads', 'old.txt'), 'old upload');
	await fs.mkdir(path.join(cwd, 'uploads', 'old-empty'));
	await fs.writeFile(path.join(cwd, 'voice', 'old.ogg'), 'old voice');
	await fs.mkdir(path.join(staged, 'uploads', 'empty'));
	await fs.mkdir(path.join(staged, 'uploads', 'nested'));
	await fs.writeFile(path.join(staged, 'uploads', 'nested', 'new.txt'), 'new upload');
	await fs.writeFile(path.join(staged, 'uploads', 'zero'), '');
	if (voice) await fs.writeFile(path.join(staged, 'voice', 'new.ogg'), 'new voice');
	await fs.writeFile(path.join(cwd, '.env'), 'LIVE_SECRET=keep-me');
	await fs.writeFile(path.join(cwd, 'environment.json'), '{"key":"live"}');
	await fs.writeFile(path.join(staged, '.env'), 'LIVE_SECRET=replace-me');
	await fs.writeFile(path.join(staged, 'environment.json'), '{"key":"restored"}');
	t.after(() => fs.rm(cwd, { recursive: true, force: true }));
	return {
		cwd,
		restoreId,
		staged,
		original: await tree(cwd),
		requestFile: path.join(cwd, 'restore-staging', '.activation', 'request.json')
	};
}

async function queue(f) {
	return queueActivationFiles({
		cwd: f.cwd,
		restoreId: f.restoreId,
		backupId: '123-backup',
		requestedBy: 7
	});
}

function crashAt(point, occurrence = 1) {
	let count = 0;
	return async (name) => {
		if (name === point && ++count === occurrence) {
			const error = new Error('simulated process exit');
			error.activationCrash = true;
			throw error;
		}
	};
}

async function backupDirectory(f) {
	const request = JSON.parse(await fs.readFile(f.requestFile, 'utf8'));
	return path.join(
		f.cwd,
		'restore-staging',
		'.activation',
		'rollback',
		request.id,
		request.attempt
	);
}

test('sealed inventory, synchronous sanitized status, exact offline install, finalize and retained rollback', async (t) => {
	const f = await fixture(t);
	assert.deepEqual(activationStatus({ cwd: f.cwd }), { state: 'idle' });
	const inspected = await inspectActivationSource(f);
	assert.equal(inspected.restoreId, f.restoreId);
	assert.deepEqual(inspected.roots, ROOTS);
	assert.match(inspected.seal, /^[a-f0-9]{64}$/);
	assert.equal(
		inspected.bytes,
		inspected.files.reduce((sum, file) => sum + file.bytes, 0)
	);
	assert.ok(
		inspected.files.every(
			(file) => !file.path.includes('environment') && !file.path.includes('.env')
		)
	);
	const request = await queue(f);
	const status = activationStatus({ cwd: f.cwd });
	assert.equal(typeof status.then, 'undefined');
	assert.deepEqual(status, request);
	assert.equal(request.requestedBy, 7);
	assert.ok(!JSON.stringify(status).includes(f.cwd));
	assert.ok(!JSON.stringify(status).includes('keep-me'));
	const installed = await applyPendingActivation({ cwd: f.cwd });
	assert.equal(installed.id, request.id);
	assert.equal(installed.state, 'installed');
	assert.equal(value(f.cwd), 'restored');
	assert.deepEqual(await tree(f.cwd), await tree(f.staged));
	assert.deepEqual(await tree(await backupDirectory(f)), f.original);
	assert.equal(await fs.readFile(path.join(f.cwd, '.env'), 'utf8'), 'LIVE_SECRET=keep-me');
	assert.equal(await fs.readFile(path.join(f.cwd, 'environment.json'), 'utf8'), '{"key":"live"}');
	assert.equal((await finalizeActivation({ cwd: f.cwd, id: request.id })).state, 'completed');
	assert.equal((await finalizeActivation({ cwd: f.cwd, id: request.id })).state, 'completed');
	assert.equal(await applyPendingActivation({ cwd: f.cwd }), null);
	assert.equal(value(f.cwd), 'restored');
	assert.deepEqual(await tree(await backupDirectory(f)), f.original);
});

test('distinct 64-bit directory identities must not collide through Number rounding', async (t) => {
	const f = await fixture(t);
	const identities = new Map([
		[path.join(f.staged, 'uploads', 'empty'), (1n << 63n) + 1n],
		[path.join(f.staged, 'uploads', 'nested'), (1n << 63n) + 2n]
	]);
	assert.equal(Number((1n << 63n) + 1n), Number((1n << 63n) + 2n));
	const originalLstat = fs.lstat;
	const mocked = t.mock.method(fs, 'lstat', async (file, options) => {
		const stat = await originalLstat(file, options);
		const identity = identities.get(file);
		if (identity !== undefined) stat.ino = options?.bigint ? identity : Number(identity);
		return stat;
	});
	try {
		const request = await queue(f);
		assert.equal(request.state, 'queued');
		assert.equal((await applyPendingActivation({ cwd: f.cwd })).state, 'installed');
		identities.set(
			path.join(f.staged, 'uploads', 'nested'),
			identities.get(path.join(f.staged, 'uploads', 'empty'))
		);
		await assert.rejects(inspectActivationSource(f), SAFE_ERROR);
	} finally {
		mocked.mock.restore();
	}
});

test('missing optional staged voice installs an empty persistent voice root', async (t) => {
	const f = await fixture(t, { voice: false });
	await queue(f);
	await applyPendingActivation({ cwd: f.cwd });
	assert.deepEqual(await fs.readdir(path.join(f.cwd, 'voice')), []);
	assert.equal(
		await fs.readFile(path.join(await backupDirectory(f), 'voice', 'old.ogg'), 'utf8'),
		'old voice'
	);
});

test('unconfirmed installation rolls back on the next boot, not repeated serving', async (t) => {
	const f = await fixture(t);
	const request = await queue(f);
	await applyPendingActivation({ cwd: f.cwd });
	const recovered = await applyPendingActivation({ cwd: f.cwd });
	assert.equal(recovered, null);
	assert.equal(activationStatus({ cwd: f.cwd }).id, request.id);
	assert.equal(activationStatus({ cwd: f.cwd }).state, 'rolled_back');
	assert.deepEqual(await tree(f.cwd), f.original);
	assert.equal(await applyPendingActivation({ cwd: f.cwd }), null);
	assert.equal((await rollbackActivation({ cwd: f.cwd, id: request.id })).state, 'rolled_back');
});

test('explicit startup failure rollback restores exact files and leaves roots mounted', async (t) => {
	const f = await fixture(t);
	const identities = await Promise.all(ROOTS.map((root) => fs.stat(path.join(f.cwd, root))));
	const request = await queue(f);
	await applyPendingActivation({ cwd: f.cwd });
	await fs.writeFile(path.join(f.cwd, 'uploads', 'startup-created'), 'remove on rollback');
	assert.equal((await rollbackActivation({ cwd: f.cwd, id: request.id })).state, 'rolled_back');
	assert.deepEqual(await tree(f.cwd), f.original);
	const after = await Promise.all(ROOTS.map((root) => fs.stat(path.join(f.cwd, root))));
	assert.deepEqual(
		after.map((stat) => stat.ino),
		identities.map((stat) => stat.ino)
	);
	await assert.rejects(finalizeActivation({ cwd: f.cwd, id: request.id }), SAFE_ERROR);
});

test('ordinary partial-install failure automatically restores before throwing', async (t) => {
	const f = await fixture(t);
	await queue(f);
	await assert.rejects(
		applyPendingActivation({
			cwd: f.cwd,
			fault: async (point) => {
				if (point === 'install_file') throw new Error('private path or credential');
			}
		}),
		SAFE_ERROR
	);
	assert.equal(activationStatus({ cwd: f.cwd }).state, 'rolled_back');
	assert.deepEqual(await tree(f.cwd), f.original);
});

for (const point of [
	'backing_up',
	'backup_file',
	'backed_up',
	'installing',
	'install_cleared',
	'install_file',
	'installed'
]) {
	test(`interrupted ${point} is durably recovered without serving partial data`, async (t) => {
		const f = await fixture(t);
		await queue(f);
		await assert.rejects(applyPendingActivation({ cwd: f.cwd, fault: crashAt(point) }), SAFE_ERROR);
		const recovered = await applyPendingActivation({ cwd: f.cwd });
		assert.equal(recovered, null);
		assert.equal(activationStatus({ cwd: f.cwd }).state, 'rolled_back');
		assert.deepEqual(await tree(f.cwd), f.original);
	});
}

for (const point of ['rolling_back', 'rollback_cleared', 'rollback_file', 'rolled_back']) {
	test(`interrupted ${point} repeats rollback from preserved immutable copy`, async (t) => {
		const f = await fixture(t);
		const request = await queue(f);
		await applyPendingActivation({ cwd: f.cwd });
		await assert.rejects(
			rollbackActivation({ cwd: f.cwd, id: request.id, fault: crashAt(point) }),
			SAFE_ERROR
		);
		assert.equal(await applyPendingActivation({ cwd: f.cwd }), null);
		assert.equal(activationStatus({ cwd: f.cwd }).state, 'rolled_back');
		assert.deepEqual(await tree(f.cwd), f.original);
	});
}

test('actual process exit during installation reclaims dead lock and recovers journal', async (t) => {
	const f = await fixture(t);
	await queue(f);
	const moduleUrl = new URL('../src/lib/server/restore-activation-files.js', import.meta.url).href;
	const script = `import {applyPendingActivation} from ${JSON.stringify(moduleUrl)};
		await applyPendingActivation({cwd:${JSON.stringify(f.cwd)},fault:async p=>{if(p==='install_file')process.exit(77)}});`;
	const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
		encoding: 'utf8'
	});
	assert.equal(child.status, 77, child.stderr);
	assert.equal(await applyPendingActivation({ cwd: f.cwd }), null);
	assert.equal(activationStatus({ cwd: f.cwd }).state, 'rolled_back');
	assert.deepEqual(await tree(f.cwd), f.original);
});

test('source changes after queue fail without replacing live data', async (t) => {
	const f = await fixture(t);
	await queue(f);
	await fs.writeFile(path.join(f.staged, 'uploads', 'zero'), 'changed');
	await assert.rejects(applyPendingActivation({ cwd: f.cwd }), SAFE_ERROR);
	assert.deepEqual(await tree(f.cwd), f.original);
	assert.equal(activationStatus({ cwd: f.cwd }).state, 'queued');
});

test('source changed during installation triggers exact rollback', async (t) => {
	const f = await fixture(t);
	await queue(f);
	await assert.rejects(
		applyPendingActivation({
			cwd: f.cwd,
			fault: async (point) => {
				if (point === 'installing')
					await fs.writeFile(path.join(f.staged, 'uploads', 'zero'), 'changed');
			}
		}),
		SAFE_ERROR
	);
	assert.deepEqual(await tree(f.cwd), f.original);
});

test('corrupt rollback fails closed before another deletion and reports no secrets', async (t) => {
	const f = await fixture(t);
	await queue(f);
	await applyPendingActivation({ cwd: f.cwd });
	const installed = await tree(f.cwd);
	await fs.writeFile(path.join(await backupDirectory(f), 'db', 'pacs.db'), 'corrupt backup');
	await assert.rejects(applyPendingActivation({ cwd: f.cwd }), SAFE_ERROR);
	assert.deepEqual(await tree(f.cwd), installed);
	assert.equal(activationStatus({ cwd: f.cwd }).state, 'installed');
});

test('corrupt journal is fail closed and synchronous public status is sanitized', async (t) => {
	const f = await fixture(t);
	await queue(f);
	const request = JSON.parse(await fs.readFile(f.requestFile, 'utf8'));
	request.state = 'completed';
	await fs.writeFile(f.requestFile, JSON.stringify(request));
	assert.deepEqual(activationStatus({ cwd: f.cwd }), {
		state: 'error',
		error: 'Restore activation unavailable; offline recovery required.'
	});
	await assert.rejects(applyPendingActivation({ cwd: f.cwd }), SAFE_ERROR);
	assert.deepEqual(await tree(f.cwd), f.original);
	await fs.writeFile(f.requestFile, '{secret malformed');
	await assert.rejects(queue(f), SAFE_ERROR);
});

test('SQLite integrity, missing database and staged WAL are rejected', async (t) => {
	for (const kind of ['corrupt', 'missing', 'wal', 'shm', 'journal']) {
		const f = await fixture(t);
		const db = path.join(f.staged, 'db', 'pacs.db');
		if (kind === 'corrupt') await fs.writeFile(db, 'not sqlite');
		else if (kind === 'missing') await fs.unlink(db);
		else await fs.writeFile(`${db}-${kind}`, 'stale sidecar');
		await assert.rejects(queue(f), SAFE_ERROR);
		assert.deepEqual(await tree(f.cwd), f.original);
	}
});

test('valid live WAL and SHM are preserved byte-for-byte and restored as a set', async (t) => {
	const f = await fixture(t);
	const db = new Database(path.join(f.cwd, 'db', 'pacs.db'));
	db.pragma('journal_mode = WAL');
	db.pragma('wal_autocheckpoint = 0');
	db.prepare('UPDATE sample SET value=?').run('original in WAL');
	// Crash a separate writer to leave genuine WAL/SHM without any live SQLite connection.
	db.close();
	const script = `import Database from 'better-sqlite3';const db=new Database(${JSON.stringify(path.join(f.cwd, 'db', 'pacs.db'))});
		db.pragma('journal_mode=WAL');db.pragma('wal_autocheckpoint=0');db.prepare('UPDATE sample SET value=?').run('unclean WAL');process.exit(0);`;
	const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
		cwd: process.cwd(),
		encoding: 'utf8'
	});
	assert.equal(child.status, 0, child.stderr);
	assert.ok((await fs.stat(path.join(f.cwd, 'db', 'pacs.db-wal'))).size > 0);
	const original = await tree(f.cwd);
	const request = await queue(f);
	await applyPendingActivation({ cwd: f.cwd });
	assert.deepEqual(await tree(await backupDirectory(f)), original);
	await rollbackActivation({ cwd: f.cwd, id: request.id });
	assert.deepEqual(await tree(f.cwd), original);
	assert.equal(value(f.cwd), 'unclean WAL');
});

test('concurrent queues are excluded and an active operation cannot be stolen', async (t) => {
	const f = await fixture(t);
	const results = await Promise.allSettled([queue(f), queue(f), queue(f)]);
	assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
	assert.equal(results.filter((result) => result.status === 'rejected').length, 2);
	let release, entered;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const entry = new Promise((resolve) => {
		entered = resolve;
	});
	const applying = applyPendingActivation({
		cwd: f.cwd,
		fault: async (point) => {
			if (point === 'backing_up') {
				entered();
				await gate;
			}
		}
	});
	await entry;
	await assert.rejects(applyPendingActivation({ cwd: f.cwd }), SAFE_ERROR);
	release();
	await applying;
});

test('new request after completion retains history and previous rollback', async (t) => {
	const f = await fixture(t);
	const first = await queue(f);
	await applyPendingActivation({ cwd: f.cwd });
	const rollback = await backupDirectory(f);
	await finalizeActivation({ cwd: f.cwd, id: first.id });
	const second = await queue(f);
	assert.notEqual(first.id, second.id);
	assert.deepEqual(await tree(rollback), f.original);
	const history = path.join(f.cwd, 'restore-staging', '.activation', 'history', `${first.id}.json`);
	assert.equal(JSON.parse(await fs.readFile(history, 'utf8')).state, 'completed');
	await assert.rejects(finalizeActivation({ cwd: f.cwd, id: first.id }), SAFE_ERROR);
});

for (const where of [
	'source-root',
	'source-uploads',
	'source-db-file',
	'live-root',
	'live-ancestor',
	'rollback-root',
	'journal'
]) {
	test(`rejects symlinks/junctions at ${where}`, async (t) => {
		const f = await fixture(t);
		const outside = path.join(f.cwd, 'outside');
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, 'sentinel'), 'do not touch');
		let target,
			destination = outside,
			type = 'junction';
		if (where === 'source-root') target = f.staged;
		if (where === 'source-uploads') target = path.join(f.staged, 'uploads');
		if (where === 'source-db-file') {
			target = path.join(f.staged, 'db', 'pacs.db');
			destination = path.join(f.cwd, 'db', 'pacs.db');
			type = 'file';
		}
		if (where === 'live-root') target = path.join(f.cwd, 'uploads');
		if (where === 'live-ancestor') target = path.join(f.cwd, 'restore-staging');
		if (where === 'rollback-root' || where === 'journal') {
			await queue(f);
			await applyPendingActivation({ cwd: f.cwd });
			if (where === 'rollback-root') target = path.join(await backupDirectory(f), 'uploads');
			else {
				target = f.requestFile;
				destination = path.join(outside, 'journal');
				type = 'file';
				await fs.writeFile(destination, '{}');
			}
		}
		await fs.rm(target, { recursive: true, force: true });
		try {
			await fs.symlink(destination, target, type);
		} catch (error) {
			if (error.code === 'EPERM') {
				t.skip('Host does not permit file symlinks');
				return;
			}
			throw error;
		}
		if (['rollback-root', 'journal'].includes(where))
			await assert.rejects(applyPendingActivation({ cwd: f.cwd }), SAFE_ERROR);
		else await assert.rejects(queue(f), SAFE_ERROR);
		assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'do not touch');
	});
}

test('status exposes only a generated relative rollback path and recovers retained history', async (t) => {
	const f = await fixture(t);
	const first = await queue(f);
	await applyPendingActivation({ cwd: f.cwd });
	const status = activationStatus({ cwd: f.cwd });
	assert.equal(path.isAbsolute(status.rollbackDirectory), false);
	assert.equal(path.join(f.cwd, status.rollbackDirectory), await backupDirectory(f));
	assert.ok(!JSON.stringify(status).includes(f.cwd));
	await finalizeActivation({ cwd: f.cwd, id: first.id });
	await queue(f);
	await fs.unlink(f.requestFile);
	const historical = activationStatus({ cwd: f.cwd });
	assert.equal(historical.id, first.id);
	assert.equal(historical.state, 'completed');
});

test('prepared copies need no activation metadata, and live environment is untouched', async (t) => {
	const f = await fixture(t);
	const before = { ...process.env };
	await fs.writeFile(
		path.join(f.staged, 'prepared.json'),
		'{"unrelated":"old preparation format"}'
	);
	await queue(f);
	await applyPendingActivation({ cwd: f.cwd });
	assert.deepEqual({ ...process.env }, before);
	await assert.rejects(fs.stat(path.join(f.cwd, 'prepared.json')), { code: 'ENOENT' });
});

test('directory in place of source SQLite is rejected without needing symlink privileges', async (t) => {
	const f = await fixture(t);
	const db = path.join(f.staged, 'db', 'pacs.db');
	await fs.unlink(db);
	await fs.mkdir(db);
	await assert.rejects(queue(f), SAFE_ERROR);
	assert.deepEqual(await tree(f.cwd), f.original);
});

test('destination corruption before the installed marker restores original data', async (t) => {
	const f = await fixture(t);
	await queue(f);
	await assert.rejects(
		applyPendingActivation({
			cwd: f.cwd,
			fault: async (point) => {
				if (point === 'install_file')
					await fs.writeFile(path.join(f.cwd, 'db', 'pacs.db'), 'damaged destination');
			}
		}),
		SAFE_ERROR
	);
	assert.equal(activationStatus({ cwd: f.cwd }).state, 'rolled_back');
	assert.deepEqual(await tree(f.cwd), f.original);
});

test('a changed original after interrupted backup fails closed instead of snapshotting partial data', async (t) => {
	const f = await fixture(t);
	await queue(f);
	await assert.rejects(
		applyPendingActivation({ cwd: f.cwd, fault: crashAt('backup_file') }),
		SAFE_ERROR
	);
	await fs.writeFile(path.join(f.cwd, 'uploads', 'old.txt'), 'changed while offline');
	const changed = await tree(f.cwd);
	await assert.rejects(applyPendingActivation({ cwd: f.cwd }), SAFE_ERROR);
	assert.equal(activationStatus({ cwd: f.cwd }).state, 'backing_up');
	assert.deepEqual(await tree(f.cwd), changed);
});

test('a second process cannot acquire an operation lock belonging to a live process', async (t) => {
	const f = await fixture(t);
	await queue(f);
	const moduleUrl = new URL('../src/lib/server/restore-activation-files.js', import.meta.url).href;
	await applyPendingActivation({
		cwd: f.cwd,
		fault: async (point) => {
			if (point !== 'backing_up') return;
			const script = `import {applyPendingActivation} from ${JSON.stringify(moduleUrl)};
			try { await applyPendingActivation({cwd:${JSON.stringify(f.cwd)}});process.exit(90); }
			catch(e) { if(e.message==='Restore activation unavailable; offline recovery required.')process.exit(42);throw e; }`;
			const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
				encoding: 'utf8'
			});
			assert.equal(child.status, 42, child.stderr);
		}
	});
	assert.equal(activationStatus({ cwd: f.cwd }).state, 'installed');
});

test('interrupted dead-lock reclamation leaves journal recoverable on the next boot', async (t) => {
	const f = await fixture(t);
	await queue(f);
	const moduleUrl = new URL('../src/lib/server/restore-activation-files.js', import.meta.url).href;
	const script = `import {applyPendingActivation} from ${JSON.stringify(moduleUrl)};
		await applyPendingActivation({cwd:${JSON.stringify(f.cwd)},fault:async p=>{if(p==='installed')process.exit(77)}});`;
	const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
		encoding: 'utf8'
	});
	assert.equal(child.status, 77, child.stderr);
	const control = path.dirname(f.requestFile);
	const lock = path.join(control, 'operation.lock');
	const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
	await fs.rename(lock, path.join(control, `lock-reclaimed-${owner.token}`));
	assert.equal(await applyPendingActivation({ cwd: f.cwd }), null);
	assert.equal(activationStatus({ cwd: f.cwd }).state, 'rolled_back');
	assert.deepEqual(await tree(f.cwd), f.original);
});

test('nested live junctions are rejected before backup or deletion', async (t) => {
	const f = await fixture(t);
	const target = path.join(f.cwd, 'voice');
	await fs.symlink(target, path.join(f.cwd, 'uploads', 'unsafe-link'), 'junction');
	await queue(f);
	await assert.rejects(applyPendingActivation({ cwd: f.cwd }), SAFE_ERROR);
	assert.equal(await fs.readFile(path.join(target, 'old.ogg'), 'utf8'), 'old voice');
});

test('a nested rollback junction fails closed before changing installed data', async (t) => {
	const f = await fixture(t);
	await queue(f);
	await applyPendingActivation({ cwd: f.cwd });
	const installed = await tree(f.cwd);
	await fs.symlink(
		path.join(f.cwd, 'voice'),
		path.join(await backupDirectory(f), 'uploads', 'unsafe-link'),
		'junction'
	);
	await assert.rejects(applyPendingActivation({ cwd: f.cwd }), SAFE_ERROR);
	assert.deepEqual(await tree(f.cwd), installed);
});

test(
	'case-colliding staged names are rejected on filesystems permitting them',
	{ skip: process.platform === 'win32' },
	async (t) => {
		const f = await fixture(t);
		await fs.writeFile(path.join(f.staged, 'uploads', 'A'), 'upper');
		await fs.writeFile(path.join(f.staged, 'uploads', 'a'), 'lower');
		await assert.rejects(queue(f), SAFE_ERROR);
	}
);

test('traversal IDs, unsafe filenames, and hard-linked source files are rejected', async (t) => {
	const f = await fixture(t);
	for (const restoreId of [
		'../escape',
		'..\\escape',
		path.resolve(f.cwd),
		'',
		randomUUID().toUpperCase()
	]) {
		await assert.rejects(queueActivationFiles({ cwd: f.cwd, restoreId }), SAFE_ERROR);
	}
	const unsafe = path.join(f.staged, 'uploads', 'CON.txt');
	try {
		await fs.writeFile(unsafe, 'unsafe');
		await assert.rejects(queue(f), SAFE_ERROR);
		await fs.unlink(unsafe);
	} catch (error) {
		if (!['ENOENT', 'EINVAL', 'EPERM'].includes(error.code)) throw error;
	}
	await fs.link(path.join(f.staged, 'uploads', 'zero'), path.join(f.staged, 'uploads', 'hardlink'));
	await assert.rejects(queue(f), SAFE_ERROR);
});
