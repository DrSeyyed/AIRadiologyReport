import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createSiteMaintenance } from '../src/lib/server/site-maintenance.js';

function fixture(t, overrides = {}) {
	const cwd = fs.mkdtempSync(path.join(tmpdir(), 'pacs-maintenance-'));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const original = { chatId: '-100123', permissions: { can_send_messages: true, can_send_photos: false, can_invite_users: false } };
	const calls = [];
	const filename = path.join(cwd, 'restore-staging', '.maintenance', 'state.json');
	const options = { cwd, env: { TELEGRAM_BOT_TOKEN: 'synthetic-token', TELEGRAM_CHAT_ID: '-100123' },
		snapshot: async () => { calls.push('snapshot'); return structuredClone(original); },
		lock: async (value) => {
			const journal = JSON.parse(fs.readFileSync(filename, 'utf8'));
			assert.equal(journal.enabled, true);
			assert.equal(journal.telegram.lockAttempted, true);
			assert.deepEqual(journal.telegram.snapshot, original);
			assert.deepEqual(value, original);
			calls.push('lock');
		},
		unlock: async (value) => { assert.deepEqual(value, original); calls.push('unlock'); },
		notify: async (_value, { enabled }) => { calls.push(enabled ? 'notice-on' : 'notice-off'); }, ...overrides };
	return { cwd, filename, original, calls, options, maintenance: createSiteMaintenance(options) };
}

test('maintenance journals original group rights before locking and survives process/database replacement', async (t) => {
	const f = fixture(t);
	assert.equal(f.maintenance.status().enabled, false);
	assert.equal((await f.maintenance.set({ enabled: true, userId: 1 })).telegram, 'locked');
	assert.deepEqual(f.calls, ['snapshot', 'lock', 'notice-on']);
	assert.doesNotMatch(fs.readFileSync(f.filename, 'utf8'), /synthetic-token/);
	const fresh = createSiteMaintenance(f.options);
	assert.equal(fresh.status().enabled, true);
	assert.deepEqual(fresh.context(), f.original);
	await fresh.set({ enabled: true, userId: 2 });
	assert.deepEqual(f.calls, ['snapshot', 'lock', 'notice-on']);
	const off = await fresh.set({ enabled: false, userId: 2 });
	assert.equal(off.enabled, false);
	assert.deepEqual(f.calls, ['snapshot', 'lock', 'notice-on', 'unlock', 'notice-off']);
	assert.equal(fresh.context(), null);
	await fresh.set({ enabled: true, userId: 2 });
	assert.equal(f.calls.filter(value => value === 'snapshot').length, 2);
});

test('uncertain lock failure stays closed and retry preserves the pre-lock permissions', async (t) => {
	let fail = true;
	const f = fixture(t, { lock: async () => { if (fail) throw new Error('https://invalid/synthetic-token'); } });
	await assert.rejects(f.maintenance.set({ enabled: true, userId: 1 }), /Maintenance remains enabled/);
	assert.equal(f.maintenance.status().enabled, true);
	assert.equal(f.maintenance.status().phase, 'error');
	assert.doesNotMatch(JSON.stringify(f.maintenance.status()), /synthetic-token|https:/);
	fail = false;
	const fresh = createSiteMaintenance({ ...f.options, snapshot: () => assert.fail('must retain original rights') });
	assert.equal((await fresh.set({ enabled: true, userId: 1 })).telegram, 'locked');
	await fresh.set({ enabled: false, userId: 1 });
	assert.ok(f.calls.includes('unlock'));
});

test('uncertain unlock failure keeps website closed until the original permissions are restored', async (t) => {
	let fail = true;
	const f = fixture(t, { unlock: async (snapshot) => {
		assert.deepEqual(snapshot, f.original);
		if (fail) throw new Error('network failure');
	} });
	await f.maintenance.set({ enabled: true, userId: 1 });
	await assert.rejects(f.maintenance.set({ enabled: false, userId: 1 }));
	assert.equal(f.maintenance.status().enabled, true);
	fail = false;
	assert.equal((await f.maintenance.set({ enabled: false, userId: 1 })).enabled, false);
});

test('interrupted lock journal can be reopened without resnapshotting locked rights', async (t) => {
	const f = fixture(t);
	await f.maintenance.set({ enabled: true, userId: 1 });
	const state = JSON.parse(fs.readFileSync(f.filename));
	state.phase = 'enabling';
	state.telegram.status = 'pending';
	fs.writeFileSync(f.filename, JSON.stringify(state));
	const fresh = createSiteMaintenance({ ...f.options, snapshot: () => assert.fail('original snapshot must be retained') });
	assert.equal((await fresh.set({ enabled: false, userId: 2 })).enabled, false);
	assert.ok(f.calls.includes('unlock'));
});

test('serializes competing enable and disable operations', async (t) => {
	const f = fixture(t);
	await Promise.all([f.maintenance.set({ enabled: true, userId: 1 }), f.maintenance.set({ enabled: false, userId: 1 })]);
	assert.deepEqual(f.calls, ['snapshot', 'lock', 'notice-on', 'unlock', 'notice-off']);
	assert.equal(f.maintenance.status().enabled, false);
});

test('website-only maintenance works with no configured Telegram and preserves explicit reopening', async (t) => {
	const f = fixture(t, { env: {}, snapshot: async () => null });
	assert.equal((await f.maintenance.set({ enabled: true, userId: 1 })).telegram, 'disabled');
	assert.equal(createSiteMaintenance(f.options).status().enabled, true);
	assert.deepEqual(f.calls, []);
	assert.equal((await f.maintenance.set({ enabled: false, userId: 1 })).enabled, false);
});

test('validates administrator identity and never persists failed preflight or credentials', async (t) => {
	const f = fixture(t, { snapshot: async () => { throw new Error('Telegram configuration required'); } });
	for (const options of [{ enabled: 'yes', userId: 1 }, { enabled: true, userId: 0 }, { enabled: true, userId: NaN }])
		await assert.rejects(f.maintenance.set(options), /Administrator confirmation/);
	await assert.rejects(f.maintenance.set({ enabled: true, userId: 1 }), /configuration/);
	assert.equal(f.maintenance.status().enabled, false);
	assert.equal(fs.existsSync(f.filename), false);
});

test('corrupt, oversized and contradictory maintenance records fail closed without overwriting evidence', async (t) => {
	const f = fixture(t);
	await f.maintenance.set({ enabled: true, userId: 1 });
	const valid = JSON.parse(fs.readFileSync(f.filename));
	for (const text of ['{bad json', 'x'.repeat(65537), JSON.stringify({ ...valid, enabled: false }),
		JSON.stringify({ ...valid, telegram: { ...valid.telegram, lockAttempted: false } }),
		JSON.stringify({ ...valid, telegram: { ...valid.telegram, snapshot: null } }),
		JSON.stringify({ ...valid, updatedAt: 'invalid' })]) {
		fs.writeFileSync(f.filename, text);
		assert.equal(f.maintenance.status().enabled, true);
		assert.equal(f.maintenance.status().phase, 'error');
		await assert.rejects(f.maintenance.set({ enabled: false, userId: 1 }), /investigation/);
		assert.equal(fs.readFileSync(f.filename, 'utf8'), text);
	}
});

test('hardlinked maintenance journals fail closed without changing either link', async (t) => {
	const f = fixture(t);
	await f.maintenance.set({ enabled: true, userId: 1 });
	const alias = path.join(f.cwd, 'journal-alias');
	fs.linkSync(f.filename, alias);
	const original = fs.readFileSync(alias, 'utf8');
	assert.equal(f.maintenance.status().enabled, true);
	assert.equal(f.maintenance.status().phase, 'error');
	await assert.rejects(f.maintenance.set({ enabled: false, userId: 1 }), /investigation/);
	assert.equal(fs.readFileSync(alias, 'utf8'), original);
});

test('notice delivery failures never reverse the locked journal or expose network errors', async (t) => {
	const f = fixture(t, { notify: async () => { throw new Error('synthetic-token'); } });
	assert.equal((await f.maintenance.set({ enabled: true, userId: 1 })).telegram, 'locked');
	assert.equal((await f.maintenance.set({ enabled: false, userId: 1 })).enabled, false);
});

test('maintenance directory junctions are rejected without reading or modifying their target', async (t) => {
	const f = fixture(t);
	const outside = fs.mkdtempSync(path.join(tmpdir(), 'pacs-maintenance-outside-'));
	t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
	fs.symlinkSync(outside, path.join(f.cwd, 'restore-staging'), process.platform === 'win32' ? 'junction' : 'dir');
	assert.equal(f.maintenance.status().enabled, true);
	await assert.rejects(f.maintenance.set({ enabled: true, userId: 1 }), /investigation/);
	assert.deepEqual(fs.readdirSync(outside), []);
});
