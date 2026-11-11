import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { exportIntegrationBackup, readIntegrationBackup, integrationRestoreFields, stageIntegrationRestore,
	pendingIntegrationRestoreStatus, applyPendingIntegrationRestore, discardPendingIntegrationRestore } from '../src/lib/server/integration-backup.js';
import { INTEGRATION_FIELDS, resolveIntegrationSettings, saveIntegrationSettings, applyIntegrationSettings } from '../src/lib/server/integration-settings.js';
import { encryptSecret, decryptSecret } from '../src/lib/server/storage-crypto.js';
import { createSiteMaintenance } from '../src/lib/server/site-maintenance.js';
import { queueActivationFiles, applyPendingActivation } from '../src/lib/server/restore-activation-files.js';

const KEYS = INTEGRATION_FIELDS.map(({ key }) => key);
const BOT = `123:${'a'.repeat(35)}`;
const NEWBOT = `456:${'b'.repeat(35)}`;
const BASE = { OPENAI_API_KEY: 'current-openai', ELEVENLABS_API_KEY: 'current-eleven', GEMINI_API_KEY: 'current-gemini',
	TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: '-100123', TELEGRAM_WEBHOOK_SECRET: 'current-secret', TELEGRAM_WEBHOOK_BASE_URL: 'https://current.domain.org' };
const RESTORED = { OPENAI_API_KEY: 'restored-openai', ELEVENLABS_API_KEY: 'restored-eleven', GEMINI_API_KEY: 'restored-gemini',
	TELEGRAM_BOT_TOKEN: NEWBOT, TELEGRAM_CHAT_ID: '-100456', TELEGRAM_WEBHOOK_SECRET: 'restored-secret', TELEGRAM_WEBHOOK_BASE_URL: 'https://restored.domain.org' };
function fixture(t, restored = RESTORED) {
	const cwd = fs.mkdtempSync(path.join(process.cwd(), 'tests', '.integration-restore-'));
	const originalKey = process.env.STORAGE_ENCRYPTION_KEY;
	process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
	t.after(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
		if (originalKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
		else process.env.STORAGE_ENCRYPTION_KEY = originalKey;
	});
	const directory = path.join(cwd, 'verified');
	fs.mkdirSync(directory, { mode: 0o700 });
	const backupId = 'backup-123';
	const serialized = exportIntegrationBackup({ backupId, cwd, env: { ...restored, STORAGE_ENCRYPTION_KEY: 'never-copy-master', UNRELATED: 'never-copy-runtime' } });
	const artifact = path.join(directory, 'integration-settings.json');
	fs.writeFileSync(artifact, serialized, { mode: 0o600 });
	const env = { ...BASE, STORAGE_ENCRYPTION_KEY: 'unchanged-master' };
	const calls = [];
	const db = new Database(':memory:');
	db.exec('CREATE TABLE application_settings(key TEXT PRIMARY KEY,value TEXT)');
	t.after(() => db.close());
	const request = async (url, options) => {
		calls.push({ url, payload: JSON.parse(options.body) });
		return { ok: true, json: async () => ({ ok: true, result: true }) };
	};
	function install(fields) {
		stageIntegrationRestore(directory, { backupId, fields });
		fs.mkdirSync(path.join(cwd, 'db'), { recursive: true });
		fs.copyFileSync(path.join(directory, 'db', 'integration-restore.json'), path.join(cwd, 'db', 'integration-restore.json'));
		fs.chmodSync(path.join(cwd, 'db', 'integration-restore.json'), 0o600);
	}
	return { cwd, directory, artifact, serialized, backupId, env, calls, install, options: { cwd, env, getDatabase: () => db, request } };
}

test('snapshot is separately encrypted, bounded, seven fields only, and uses effective administrator overrides', (t) => {
	const f = fixture(t);
	const outer = JSON.parse(f.serialized);
	assert.deepEqual(Object.keys(outer), ['version', 'ciphertext']);
	assert.doesNotMatch(f.serialized, /restored-openai|never-copy|TELEGRAM_BOT_TOKEN/);
	assert.deepEqual(readIntegrationBackup(f.serialized, { backupId: f.backupId }), RESTORED);
	assert.doesNotMatch(decryptSecret(outer.ciphertext), /never-copy|STORAGE_ENCRYPTION_KEY|UNRELATED/);
	saveIntegrationSettings({ OPENAI_API_KEY: 'admin-override', GEMINI_API_KEY: '' }, { cwd: f.cwd });
	const current = readIntegrationBackup(exportIntegrationBackup({ cwd: f.cwd, env: BASE, backupId: f.backupId }), { backupId: f.backupId });
	assert.equal(current.OPENAI_API_KEY, 'admin-override');
	assert.equal(current.GEMINI_API_KEY, '');
	assert.deepEqual(integrationRestoreFields(f.directory, { backupId: f.backupId }), INTEGRATION_FIELDS.map(({ key, label }) => ({ key, label, configured: true })));
});

test('wrong keys, IDs, corrupt records, duplicates, unknown/master fields and invalid values fail sanitized', (t) => {
	const f = fixture(t);
	assert.throws(() => readIntegrationBackup(f.serialized, { backupId: 'wrong' }), /Integration restore/);
	const correctKey = process.env.STORAGE_ENCRYPTION_KEY;
	process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
	assert.throws(() => readIntegrationBackup(f.serialized, { backupId: f.backupId }), /Integration restore/);
	process.env.STORAGE_ENCRYPTION_KEY = correctKey;
	const payload = JSON.parse(decryptSecret(JSON.parse(f.serialized).ciphertext));
	for (const fields of [{ ...RESTORED, STORAGE_ENCRYPTION_KEY: 'secret-do-not-expose' }, { ...RESTORED, TELEGRAM_CHAT_ID: 'secret-do-not-expose' }, { ...RESTORED, TELEGRAM_BOT_TOKEN: null }]) {
		const malformed = JSON.stringify({ version: 1, ciphertext: encryptSecret(JSON.stringify({ ...payload, fields })) });
		assert.throws(() => readIntegrationBackup(malformed, { backupId: f.backupId }), error => !error.message.includes('secret-do-not-expose'));
	}
	for (const text of ['{invalid', 'x'.repeat(65537), f.serialized.replace('"version":1', '"version":1,"version":1'),
		JSON.stringify({ version: 1, ciphertext: encryptSecret(JSON.stringify(payload).replace('"fields":{', '"fields":{"OPENAI_API_KEY":"duplicate",')) })]) {
		assert.throws(() => readIntegrationBackup(text, { backupId: f.backupId }), /Integration restore/);
	}
	for (const fields of [['STORAGE_ENCRYPTION_KEY'], ['OPENAI_API_KEY', 'OPENAI_API_KEY'], 'OPENAI_API_KEY']) {
		assert.throws(() => stageIntegrationRestore(f.directory, { backupId: f.backupId, fields }), /Integration restore/);
	}
});

test('legacy missing artifacts return empty metadata; empty selection safely removes plan only', (t) => {
	const f = fixture(t);
	f.install(['OPENAI_API_KEY']);
	stageIntegrationRestore(f.directory, { backupId: f.backupId, fields: [] });
	assert.ok(fs.existsSync(f.artifact));
	assert.equal(fs.existsSync(path.join(f.directory, 'db', 'integration-restore.json')), false);
	fs.unlinkSync(f.artifact);
	assert.deepEqual(integrationRestoreFields(f.directory, { backupId: f.backupId }), []);
	stageIntegrationRestore(path.join(f.cwd, 'does-not-exist'), { backupId: f.backupId, fields: [] });
	assert.equal(fs.existsSync(path.join(f.cwd, 'does-not-exist')), false);
	assert.throws(() => stageIntegrationRestore(f.directory, { backupId: f.backupId, fields: ['OPENAI_API_KEY'] }), /Integration restore/);
});

test('each selected field applies independently, unchecked values and master remain exact, providers never call Telegram', async (t) => {
	for (const key of KEYS) await t.test(key, async (t) => {
		const f = fixture(t);
		f.install([key]);
		assert.deepEqual(resolveIntegrationSettings({ cwd: f.cwd, env: f.env }), BASE);
		assert.deepEqual(f.env, { ...BASE, STORAGE_ENCRYPTION_KEY: 'unchanged-master' });
		const pending = pendingIntegrationRestoreStatus({ cwd: f.cwd });
		assert.deepEqual(pending, { pending: true, fields: [key], backupId: f.backupId });
		assert.doesNotMatch(fs.readFileSync(path.join(f.cwd, 'db', 'integration-restore.json'), 'utf8'), /restored-|current-|TELEGRAM_BOT_TOKEN/);
		await applyPendingIntegrationRestore(f.options);
		assert.deepEqual(resolveIntegrationSettings({ cwd: f.cwd, env: f.env }), { ...BASE, [key]: RESTORED[key] });
		assert.equal(f.env.STORAGE_ENCRYPTION_KEY, 'unchanged-master');
		assert.deepEqual(pendingIntegrationRestoreStatus({ cwd: f.cwd }), { pending: false, fields: [] });
		if (!key.startsWith('TELEGRAM_') || key === 'TELEGRAM_CHAT_ID') assert.equal(f.calls.length, 0);
		else assert.ok(f.calls.every(call => call.payload.drop_pending_updates === false));
	});
});

test('all fields may be selected together and reapplying a completed restore makes no requests', async (t) => {
	const f = fixture(t);
	f.install(KEYS);
	await applyPendingIntegrationRestore(f.options);
	assert.deepEqual(resolveIntegrationSettings({ cwd: f.cwd, env: f.env }), RESTORED);
	assert.equal(f.calls.length, 2);
	await applyPendingIntegrationRestore(f.options);
	assert.equal(f.calls.length, 2);
});

test('selected empty values explicitly disable; old webhook removed before changing bot or clearing website', async (t) => {
	const f = fixture(t, { ...RESTORED, OPENAI_API_KEY: '', TELEGRAM_WEBHOOK_BASE_URL: '' });
	f.install(['OPENAI_API_KEY', 'TELEGRAM_WEBHOOK_BASE_URL']);
	await applyPendingIntegrationRestore({ ...f.options, request: async (url, options) => {
		assert.equal(resolveIntegrationSettings({ cwd: f.cwd, env: f.env }).TELEGRAM_WEBHOOK_BASE_URL, BASE.TELEGRAM_WEBHOOK_BASE_URL);
		assert.ok(url.includes(BOT));
		assert.ok(url.endsWith('/deleteWebhook'));
		assert.equal(JSON.parse(options.body).drop_pending_updates, false);
		return { ok: true, json: async () => ({ ok: true, result: true }) };
	} });
	assert.equal(f.env.OPENAI_API_KEY, '');
	assert.equal(f.env.TELEGRAM_WEBHOOK_BASE_URL, '');
	assert.equal(f.env.TELEGRAM_WEBHOOK_SECRET, BASE.TELEGRAM_WEBHOOK_SECRET);
});

test('failed old webhook removal is retryable before any settings mutation, preserving unchecked secret', async (t) => {
	const f = fixture(t);
	f.install(['TELEGRAM_BOT_TOKEN']);
	await assert.rejects(applyPendingIntegrationRestore({ ...f.options, request: async () => { throw new Error('secret-token'); } }), /Integration restore/);
	assert.equal(f.env.TELEGRAM_BOT_TOKEN, BOT);
	assert.equal(pendingIntegrationRestoreStatus({ cwd: f.cwd }).pending, true);
	await applyPendingIntegrationRestore(f.options);
	assert.equal(f.env.TELEGRAM_BOT_TOKEN, NEWBOT);
	assert.equal(f.env.TELEGRAM_WEBHOOK_SECRET, BASE.TELEGRAM_WEBHOOK_SECRET);
	assert.ok(f.calls[0].url.includes(BOT));
	assert.ok(f.calls[1].url.includes(NEWBOT));
	assert.equal(f.calls[1].payload.secret_token, BASE.TELEGRAM_WEBHOOK_SECRET);
});

test('missing unchecked webhook secret fails before mutation and never silently rotates it', async (t) => {
	const f = fixture(t);
	f.env.TELEGRAM_WEBHOOK_SECRET = '';
	f.install(['TELEGRAM_BOT_TOKEN']);
	await assert.rejects(applyPendingIntegrationRestore(f.options), /Integration restore/);
	assert.equal(f.env.TELEGRAM_BOT_TOKEN, BOT);
	assert.equal(f.env.TELEGRAM_WEBHOOK_SECRET, '');
	assert.equal(f.calls.length, 0);
	assert.equal(discardPendingIntegrationRestore({ cwd: f.cwd }).applied, false);
});

test('webhook failure after application and process restart never overwrite later administrator edits', async (t) => {
	const f = fixture(t);
	f.install(['TELEGRAM_WEBHOOK_SECRET', 'OPENAI_API_KEY']);
	await assert.rejects(applyPendingIntegrationRestore({ ...f.options, request: async () => { throw new Error('secret-token'); } }));
	assert.equal(f.env.OPENAI_API_KEY, RESTORED.OPENAI_API_KEY);
	saveIntegrationSettings({ OPENAI_API_KEY: 'later-administrator-edit', TELEGRAM_WEBHOOK_SECRET: 'later-secret' }, { cwd: f.cwd, env: f.env });
	const restarted = { ...BASE };
	await applyPendingIntegrationRestore({ ...f.options, env: restarted });
	assert.equal(restarted.OPENAI_API_KEY, 'later-administrator-edit');
	assert.equal(restarted.TELEGRAM_WEBHOOK_SECRET, 'later-secret');
	assert.equal(f.calls.at(-1).payload.secret_token, 'later-secret');
});

test('crash after atomic vault write but before plan checkpoint cannot overwrite later edits', async (t) => {
	const f = fixture(t);
	f.install(['OPENAI_API_KEY']);
	await assert.rejects(applyPendingIntegrationRestore({ ...f.options, saveSettings: (updates, options) => {
		saveIntegrationSettings(updates, options);
		throw new Error('simulated crash');
	} }));
	saveIntegrationSettings({ OPENAI_API_KEY: 'later-edit' }, { cwd: f.cwd });
	await applyPendingIntegrationRestore(f.options);
	assert.equal(f.env.OPENAI_API_KEY, 'later-edit');
});

test('failed unapplied restore can be discarded without settings changes; applied retry needs explicit acknowledgement', async (t) => {
	const f = fixture(t);
	f.install(['TELEGRAM_BOT_TOKEN']);
	await assert.rejects(applyPendingIntegrationRestore({ ...f.options, request: async () => { throw new Error('network'); } }));
	assert.deepEqual(discardPendingIntegrationRestore({ cwd: f.cwd }), { discarded: true, applied: false, fields: ['TELEGRAM_BOT_TOKEN'] });
	assert.equal(f.env.TELEGRAM_BOT_TOKEN, BOT);
	assert.deepEqual(discardPendingIntegrationRestore({ cwd: f.cwd }), { discarded: false, applied: false, fields: [] });
	f.install(['TELEGRAM_WEBHOOK_SECRET']);
	await assert.rejects(applyPendingIntegrationRestore({ ...f.options, request: async () => { throw new Error('network'); } }));
	assert.throws(() => discardPendingIntegrationRestore({ cwd: f.cwd }), error => error.code === 'INTEGRATION_RESTORE_ALREADY_APPLIED');
	assert.equal(pendingIntegrationRestoreStatus({ cwd: f.cwd }).pending, true);
	assert.deepEqual(discardPendingIntegrationRestore({ cwd: f.cwd, allowApplied: true }), { discarded: true, applied: true, fields: ['TELEGRAM_WEBHOOK_SECRET'] });
	assert.equal(resolveIntegrationSettings({ cwd: f.cwd, env: f.env }).TELEGRAM_WEBHOOK_SECRET, RESTORED.TELEGRAM_WEBHOOK_SECRET);
	assert.equal(f.env.TELEGRAM_WEBHOOK_SECRET, RESTORED.TELEGRAM_WEBHOOK_SECRET);
});

test('unsafe snapshot/plan links and corrupt plans fail closed without touching targets', (t) => {
	const f = fixture(t);
	const alias = path.join(f.cwd, 'alias');
	fs.linkSync(f.artifact, alias);
	assert.throws(() => integrationRestoreFields(f.directory, { backupId: f.backupId }), /Integration restore/);
	fs.unlinkSync(alias);
	f.install(['OPENAI_API_KEY']);
	const plan = path.join(f.cwd, 'db', 'integration-restore.json');
	fs.linkSync(plan, alias);
	assert.throws(() => pendingIntegrationRestoreStatus({ cwd: f.cwd }), /Integration restore/);
	assert.throws(() => stageIntegrationRestore(f.cwd, { backupId: f.backupId, fields: [] }), /Integration restore/);
	fs.unlinkSync(alias);
	fs.writeFileSync(plan, '{corrupt');
	assert.throws(() => pendingIntegrationRestoreStatus({ cwd: f.cwd }), /Integration restore/);
	const linked = path.join(f.cwd, 'linked');
	fs.symlinkSync(f.directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
	assert.throws(() => integrationRestoreFields(linked, { backupId: f.backupId }), /Integration restore/);
});

test('maintenance unlock precedes restore and retry/restart never unlocks original group using restored bot', async (t) => {
	const f = fixture(t);
	f.install(['TELEGRAM_BOT_TOKEN']);
	let fail = true;
	const order = [];
	const original = { chatId: BASE.TELEGRAM_CHAT_ID, permissions: { can_send_messages: true } };
	const options = { cwd: f.cwd, env: f.env, snapshot: async () => original, lock: async () => {}, notify: async () => {},
		unlock: async (_snapshot, { env }) => { assert.equal(env.TELEGRAM_BOT_TOKEN, BOT); order.push('unlock'); },
		afterUnlock: async () => {
			order.push('apply');
			const journal = JSON.parse(fs.readFileSync(path.join(f.cwd, 'restore-staging', '.maintenance', 'state.json'), 'utf8'));
			assert.equal(journal.telegram.snapshot, null);
			assert.equal(journal.telegram.lockAttempted, false);
			await applyPendingIntegrationRestore({ ...f.options, request: async (url, init) => {
				if (fail && url.endsWith('/setWebhook')) throw new Error('network');
				return f.options.request(url, init);
			} });
		} };
	const maintenance = createSiteMaintenance(options);
	await maintenance.set({ enabled: true, userId: 1 });
	assert.equal(f.env.TELEGRAM_BOT_TOKEN, BOT);
	assert.equal(pendingIntegrationRestoreStatus({ cwd: f.cwd }).pending, true);
	await assert.rejects(maintenance.set({ enabled: false, userId: 1 }));
	assert.deepEqual(order, ['unlock', 'apply']);
	assert.equal(f.env.TELEGRAM_BOT_TOKEN, NEWBOT);
	assert.equal(maintenance.status().enabled, true);
	assert.equal(maintenance.context(), null);
	fail = false;
	const fresh = createSiteMaintenance(options);
	await fresh.set({ enabled: false, userId: 1 });
	assert.deepEqual(order, ['unlock', 'apply', 'apply']);
	assert.equal(fresh.status().enabled, false);
});

test('maintenance invokes deferred callback with no Telegram snapshot and skips notices with changed credentials', async (t) => {
	const f = fixture(t);
	let applied = 0;
	const maintenance = createSiteMaintenance({ cwd: f.cwd, env: {}, snapshot: async () => null,
		afterUnlock: async () => { applied++; } });
	await maintenance.set({ enabled: true, userId: 1 });
	assert.equal(applied, 0);
	await maintenance.set({ enabled: false, userId: 1 });
	assert.equal(applied, 1);
});

test('successful restored bot change suppresses the old-group reopening notice', async (t) => {
	const f = fixture(t);
	const notices = [];
	const maintenance = createSiteMaintenance({ cwd: f.cwd, env: f.env,
		snapshot: async () => ({ chatId: BASE.TELEGRAM_CHAT_ID, permissions: { can_send_messages: true } }),
		lock: async () => {}, unlock: async () => {},
		notify: async (_snapshot, { enabled }) => { notices.push(enabled); },
		afterUnlock: async () => { f.env.TELEGRAM_BOT_TOKEN = NEWBOT; } });
	await maintenance.set({ enabled: true, userId: 1 });
	await maintenance.set({ enabled: false, userId: 1 });
	assert.deepEqual(notices, [true]);
});

test('existing offline clinical installer inventories and installs encrypted plan with database, without applying live settings', async (t) => {
	const f = fixture(t);
	const restoreId = randomUUID();
	const staged = path.join(f.cwd, 'restore-staging', restoreId);
	fs.mkdirSync(staged, { recursive: true });
	for (const base of [f.cwd, staged]) {
		for (const root of ['db', 'uploads', 'voice']) fs.mkdirSync(path.join(base, root), { recursive: true });
		const db = new Database(path.join(base, 'db', 'pacs.db'));
		db.exec('CREATE TABLE sample(value TEXT)');
		db.prepare('INSERT INTO sample VALUES(?)').run(base === staged ? 'restored' : 'original');
		db.close();
	}
	fs.copyFileSync(f.artifact, path.join(staged, 'integration-settings.json'));
	fs.chmodSync(path.join(staged, 'integration-settings.json'), 0o600);
	stageIntegrationRestore(staged, { backupId: f.backupId, fields: ['OPENAI_API_KEY'] });
	await queueActivationFiles({ cwd: f.cwd, restoreId, backupId: f.backupId, requestedBy: 1 });
	await applyPendingActivation({ cwd: f.cwd });
	assert.equal(pendingIntegrationRestoreStatus({ cwd: f.cwd }).pending, true);
	assert.equal(f.env.OPENAI_API_KEY, BASE.OPENAI_API_KEY);
	const db = new Database(path.join(f.cwd, 'db', 'pacs.db'));
	assert.equal(db.prepare('SELECT value FROM sample').pluck().get(), 'restored');
	db.close();
	applyIntegrationSettings({ cwd: f.cwd, env: f.env });
	assert.equal(f.env.OPENAI_API_KEY, BASE.OPENAI_API_KEY);
	await applyPendingIntegrationRestore(f.options);
	assert.equal(f.env.OPENAI_API_KEY, RESTORED.OPENAI_API_KEY);
});
