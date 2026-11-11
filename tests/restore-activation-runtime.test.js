import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encryptSecret } from '../src/lib/server/storage-crypto.js';
import Database from 'better-sqlite3';
import { createActivationRuntime } from '../src/lib/server/restore-activation-runtime.js';
import { activatePreparedRestore } from '../src/lib/server/restore-activation.js';
import { initializeSchema } from '../scripts/initialize-schema.mjs';

function fixture(overrides = {}) {
	const messages = [];
	const scheduled = [];
	const queued = [];
	const runtime = createActivationRuntime({
		env: { RESTORE_ACTIVATION_SUPERVISED: '1', RESTORE_ACTIVATION_DATA_PERSISTED: '1' },
		connected: () => true,
		send: (value) => messages.push(value),
		schedule: (operation) => scheduled.push(operation),
		queue: async (value) => { queued.push(value); return { id: 'activation' }; },
		maintenanceEnabled: () => false,
		enableMaintenance: async () => {},
		...overrides
	});
	return { runtime, queued, messages, scheduled };
}

test('activation queues durably before delayed supervisor notification and blocks further work', async () => {
	const f = fixture();
	let validated = false;
	await f.runtime.request(() => f.runtime.activate({ restoreId: 'copy', validate: () => { validated = true; } }));
	assert.equal(validated, true);
	assert.equal(f.queued.length, 1);
	assert.equal(f.queued[0].restoreId, 'copy');
	assert.ok(!('validate' in f.queued[0]));
	assert.deepEqual(f.messages, []);
	assert.equal(f.runtime.maintenance(), true);
	await assert.rejects(f.runtime.activate({}));
	let ran = false;
	await f.runtime.background(() => { ran = true; });
	assert.equal(ran, false);
	f.scheduled[0]();
	assert.deepEqual(f.messages, [{ type: 'restore-activation-requested', id: 'activation' }]);
});

test('restore enables persistent maintenance before queueing and leaves it enabled after queue failure', async () => {
	let manual = false;
	const order = [];
	const f = fixture({
		maintenanceEnabled: () => manual,
		enableMaintenance: async (userId) => { assert.equal(userId, 7); manual = true; order.push('maintenance'); },
		queue: async () => { order.push('queue'); throw new Error('no space'); }
	});
	await assert.rejects(f.runtime.activate({ requestedBy: 7 }), /no space/);
	assert.deepEqual(order, ['maintenance', 'queue']);
	assert.equal(manual, true);
	assert.equal(f.runtime.maintenance(), false);
	let ran = false;
	await f.runtime.background(() => { ran = true; });
	assert.equal(ran, false);
	await f.runtime.background(() => { ran = true; }, { allowDuringMaintenance: true });
	assert.equal(ran, true);
});

test('startup confirmation never reopens persistent maintenance or resumes ordinary background work', async () => {
	const f = fixture({ env: { RESTORE_ACTIVATION_PENDING: 'restored' }, maintenanceEnabled: () => true });
	let ran = false;
	await f.runtime.background(() => { ran = true; }, { allowDuringMaintenance: true });
	assert.equal(ran, false);
	f.runtime.confirm('restored');
	assert.equal(f.runtime.maintenance(), false);
	await f.runtime.background(() => { ran = true; });
	assert.equal(ran, false);
	await f.runtime.background(() => { ran = true; }, { allowDuringMaintenance: true });
	assert.equal(ran, true);
});

test('failed group locking never queues a restore or requests restart', async () => {
	const f = fixture({ enableMaintenance: async () => { throw new Error('bot needs administrator rights'); } });
	await assert.rejects(f.runtime.activate({ requestedBy: 7 }), /administrator rights/);
	assert.deepEqual(f.queued, []);
	assert.deepEqual(f.scheduled, []);
});

test('notification scheduling failure keeps maintenance after a durable activation request', async () => {
	const f = fixture({ schedule: () => { throw new Error('scheduler failed'); } });
	await assert.rejects(f.runtime.activate({}), /scheduler failed/);
	assert.equal(f.queued.length, 1);
	assert.equal(f.runtime.maintenance(), true);
	let ran = false;
	await f.runtime.background(() => { ran = true; });
	assert.equal(ran, false);
});

test('activation refuses active background work and restores normal operation after rejection', async () => {
	const f = fixture();
	let release;
	const pending = f.runtime.background(() => new Promise((resolve) => { release = resolve; }));
	await assert.rejects(f.runtime.activate({}), /background jobs/);
	assert.equal(f.runtime.maintenance(), false);
	assert.equal(f.queued.length, 0);
	release();
	await pending;
	await f.runtime.activate({});
	assert.equal(f.queued.length, 1);
});

test('activation waits for existing requests while rejecting new background work', async () => {
	let release;
	const f = fixture({ wait: async () => { release(); await Promise.resolve(); } });
	const existing = f.runtime.request(() => new Promise((resolve) => { release = resolve; }));
	await f.runtime.request(() => f.runtime.activate({}));
	await existing;
	assert.equal(f.queued.length, 1);
});

test('drain timeout, failed validation and queue failures never request a restart', async () => {
	for (const failure of ['timeout', 'validation', 'queue']) {
		const f = fixture({
			wait: async () => {},
			...(failure === 'queue' ? { queue: async () => { throw new Error('failed'); } } : {})
		});
		let release;
		const existing = failure === 'timeout' ? f.runtime.request(() => new Promise((resolve) => { release = resolve; })) : null;
		await assert.rejects(f.runtime.request(() => f.runtime.activate({
			validate: () => { if (failure === 'validation') throw new Error('failed'); }
		})));
		assert.equal(f.runtime.maintenance(), false);
		assert.deepEqual(f.messages, []);
		assert.deepEqual(f.scheduled, []);
		if (release) { release(); await existing; }
	}
});

test('only supervised processes with supported voice roots can activate', async () => {
	for (const overrides of [
		{ env: {} },
		{ env: { RESTORE_ACTIVATION_SUPERVISED: '1' } },
		{ connected: () => false },
		{ env: { RESTORE_ACTIVATION_SUPERVISED: '1', RESTORE_ACTIVATION_DATA_PERSISTED: '1', VOICE_SAVE_DIR: '../external-voice' } }
	]) {
		const f = fixture(overrides);
		assert.equal(f.runtime.availability().supported, false);
		await assert.rejects(f.runtime.activate({}));
		assert.equal(f.queued.length, 0);
	}
});

test('unconfirmed startup stays in maintenance until matching supervisor confirmation', async () => {
	const f = fixture({ env: { RESTORE_ACTIVATION_SUPERVISED: '1', RESTORE_ACTIVATION_PENDING: 'activation' } });
	assert.equal(f.runtime.maintenance(), true);
	f.runtime.confirm('wrong');
	assert.equal(f.runtime.maintenance(), true);
	f.runtime.confirm('activation');
	assert.equal(f.runtime.maintenance(), false);
});

function databaseFixture(t) {
	const db = new Database(':memory:');
	initializeSchema(db, readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
	t.after(() => db.close());
	const restoreId = randomUUID();
	const saved = { id: `1800000000-${randomUUID()}`, restoreId, audioMode: 'download' };
	const { lastInsertRowid: jobId } = db.prepare("INSERT INTO storage_jobs(kind,status,created_at,result) VALUES('restore','succeeded',1,?)").run(JSON.stringify(saved));
	return { db, jobId, saved };
}

test('activation accepts only a registered succeeded restore and checks live storage work', async (t) => {
	const { db, jobId, saved } = databaseFixture(t);
	let options;
	const activate = async (value) => { options = value; await value.validate(); return { id: 'queued' }; };
	const result = await activatePreparedRestore(db, { jobId, userId: 7 }, { activate });
	assert.equal(result.id, 'queued');
	assert.equal(options.restoreId, saved.restoreId);
	assert.equal(options.backupId, saved.id);
	assert.equal(options.requestedBy, 7);
	db.prepare("INSERT INTO storage_jobs(kind,status,created_at) VALUES('archive','running',1)").run();
	await assert.rejects(activatePreparedRestore(db, { jobId, userId: 7 }, { activate }), /running storage/);
	db.prepare("UPDATE storage_jobs SET status='failed' WHERE id=?").run(jobId);
	await assert.rejects(activatePreparedRestore(db, { jobId, userId: 7 }, { activate }));
	await assert.rejects(activatePreparedRestore(db, { jobId: 999, userId: 7 }, { activate }));
	await assert.rejects(activatePreparedRestore(db, { jobId, userId: 0 }, { activate }));
});

test('activation rejects untrusted prepared paths without touching the filesystem', async (t) => {
	const { db, jobId, saved } = databaseFixture(t);
	for (const restoreId of ['../db', '/tmp/source', 'not-a-uuid']) {
		db.prepare('UPDATE storage_jobs SET result=? WHERE id=?').run(JSON.stringify({ ...saved, restoreId }), jobId);
		await assert.rejects(activatePreparedRestore(db, { jobId, userId: 1 }, { activate: () => assert.fail('must not activate') }));
	}
});

test('remote activation requires the original key and refuses a linked staged database directory', async (t) => {
	const { db, jobId, saved } = databaseFixture(t);
	const cwd = mkdtempSync(path.join(tmpdir(), 'arr-activation-key-'));
	const previousKey = process.env.STORAGE_ENCRYPTION_KEY;
	t.after(() => {
		if (previousKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
		else process.env.STORAGE_ENCRYPTION_KEY = previousKey;
		rmSync(cwd, { recursive: true, force: true });
	});
	process.env.STORAGE_ENCRYPTION_KEY = Buffer.alloc(32, 71).toString('base64');
	const prepared = path.join(cwd, 'restore-staging', saved.restoreId);
	mkdirSync(path.join(prepared, 'db'), { recursive: true });
	const restored = new Database(path.join(prepared, 'db', 'pacs.db'));
	try {
		initializeSchema(restored, readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
		restored.prepare("INSERT INTO application_settings(key,value) VALUES('storage_password',?)").run(encryptSecret('synthetic-storage-password'));
	} finally { restored.close(); }
	db.prepare('UPDATE storage_jobs SET result=? WHERE id=?').run(JSON.stringify({ ...saved, audioMode: 'remote', remoteAudioFiles: 1 }), jobId);
	const activate = async ({ validate }) => { await validate(); return { id: 'accepted' }; };
	assert.equal((await activatePreparedRestore(db, { jobId, userId: 1 }, { cwd, activate })).id, 'accepted');
	process.env.STORAGE_ENCRYPTION_KEY = Buffer.alloc(32, 72).toString('base64');
	await assert.rejects(activatePreparedRestore(db, { jobId, userId: 1 }, { cwd, activate }), /decryption failed/);
	process.env.STORAGE_ENCRYPTION_KEY = Buffer.alloc(32, 71).toString('base64');
	rmSync(path.join(prepared, 'db'), { recursive: true });
	const outside = path.join(cwd, 'outside');
	mkdirSync(outside);
	symlinkSync(outside, path.join(prepared, 'db'), process.platform === 'win32' ? 'junction' : 'dir');
	await assert.rejects(activatePreparedRestore(db, { jobId, userId: 1 }, { cwd, activate }), /Unsafe prepared/);
});

test('server hooks gate normal requests and require the private startup health token', async (t) => {
	const key = randomUUID();
	const previousToken = process.env.RESTORE_STARTUP_TOKEN;
	process.env.RESTORE_STARTUP_TOKEN = 'synthetic-health-token';
	const state = { maintenance: true, manual: false, role: null, auth: 0, queries: 0, requests: 0 };
	globalThis[key] = state;
	t.after(() => {
		delete globalThis[key];
		if (previousToken === undefined) delete process.env.RESTORE_STARTUP_TOKEN;
		else process.env.RESTORE_STARTUP_TOKEN = previousToken;
	});
	const source = readFileSync(new URL('../src/hooks.server.js', import.meta.url), 'utf8').replace(
		/from (['"])([^'"]+)\1/g, (_statement, _quote, specifier) => {
			let body;
			const access = `globalThis[${JSON.stringify(key)}]`;
			if (specifier === '$app/environment') body = 'export const building=true;';
			else if (specifier === '$lib/server/auth') body = `export function getSession(){${access}.auth++;return ${access}.role?{user:{id:1,role:${access}.role},session:{}}:null;}`;
			else if (specifier === '$lib/server/db') body = `export function getDb(){${access}.queries++;return {prepare:()=>({get:()=>({})})};}`;
			else if (specifier === '$lib/server/restore-activation-runtime.js') body = `export const restoreActivation={maintenance:()=>${access}.maintenance,request:async(fn)=>{${access}.requests++;return fn();}};`;
			else if (specifier === '$lib/server/site-maintenance.js') body = `export function siteMaintenanceStatus(){return {enabled:${access}.manual};}`;
			else if (specifier === '$lib/server/maintenance-response.js')
				return `from ${JSON.stringify(new URL('../src/lib/server/maintenance-response.js', import.meta.url).href)}`;
			else if (specifier === 'undici') body = 'export function setGlobalDispatcher(){};export class ProxyAgent{};';
			else body = 'export function startVoiceWorker(){};export function startStudyNotificationWorker(){};export function startGroupInvitationWorker(){};export function startTelegramStudyRefreshWorker(){};export function startStorageWorker(){};';
			return `from ${JSON.stringify(`data:text/javascript,${encodeURIComponent(body)}`)}`;
		}
	);
	const { handle } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
	const call = (pathname, headers = {}) => handle({
		event: { url: new URL(`http://localhost${pathname}`), request: new Request(`http://localhost${pathname}`, { headers }), cookies: { get() {} }, locals: {} },
		resolve: async () => new Response('site')
	});
	assert.equal((await call('/login')).status, 503);
	assert.equal((await call('/__restore-health')).status, 404);
	assert.equal(state.queries, 0);
	assert.equal((await call('/__restore-health', { 'x-restore-startup-token': 'synthetic-health-token' })).status, 204);
	assert.equal(state.queries, 1);
	assert.equal(state.auth, 0);
	state.maintenance = false;
	assert.equal(await (await call('/login')).text(), 'site');
	assert.equal(state.auth, 1);
	assert.equal(state.requests, 1);
	state.manual = true;
	const updating = await call('/studies');
	assert.equal(updating.status, 503);
	assert.match(await updating.text(), /Updating…/);
	assert.equal(updating.headers.get('cache-control'), 'no-store');
	assert.equal((await call('/api/studies')).headers.get('content-type'), 'application/json');
	assert.equal((await call('/login')).status, 200);
	assert.equal((await call('/logout')).status, 200);
	state.role = 'resident';
	assert.equal((await call('/studies')).status, 503);
	state.role = 'admin';
	assert.equal((await call('/admin/maintenance')).status, 200);
	assert.equal((await call('/studies')).status, 200);
	state.maintenance = true;
	assert.equal((await call('/admin/maintenance')).status, 503);
	assert.equal((await call('/api/telegram/webhook')).status, 200);
});
