import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { decryptSecret, encryptSecret } from '../src/lib/server/storage-crypto.js';
import {
	INTEGRATION_FIELDS,
	resolveIntegrationSettings,
	applyIntegrationSettings,
	readIntegrationSettings,
	saveIntegrationSettings
} from '../src/lib/server/integration-settings.js';

const master = Buffer.alloc(32, 7).toString('base64');
const otherMaster = Buffer.alloc(32, 8).toString('base64');
const valid = {
	OPENAI_API_KEY: 'synthetic-openai-secret',
	ELEVENLABS_API_KEY: 'synthetic-elevenlabs-secret',
	GEMINI_API_KEY: 'synthetic-gemini-secret',
	TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyz_ABCDEF12',
	TELEGRAM_CHAT_ID: '-100123456789',
	TELEGRAM_WEBHOOK_SECRET: 'synthetic_webhook-secret',
	TELEGRAM_WEBHOOK_BASE_URL: 'https://radiology.example.com'
};

function setup(t) {
	// All fixtures are isolated project-local workspaces, never deployment files or OS temp paths.
	const previous = process.env.STORAGE_ENCRYPTION_KEY;
	process.env.STORAGE_ENCRYPTION_KEY = master;
	const cwd = path.resolve(`.integration-settings-test-${randomUUID()}`);
	fs.mkdirSync(cwd, { mode: 0o700 });
	const directory = path.join(cwd, 'restore-staging', '.integrations');
	const filename = path.join(directory, 'settings.json');
	t.after(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
		if (previous === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
		else process.env.STORAGE_ENCRYPTION_KEY = previous;
	});
	return { cwd, directory, filename };
}

function contents(fixture) {
	return fs.existsSync(fixture.filename) ? fs.readFileSync(fixture.filename, 'utf8') : null;
}

function writeFixture(fixture, record) {
	fs.mkdirSync(fixture.directory, { recursive: true, mode: 0o700 });
	fs.writeFileSync(fixture.filename, JSON.stringify(record), { mode: 0o600 });
}

function sanitized(action) {
	assert.throws(action, (error) => {
		assert.doesNotMatch(error.message, /synthetic|v1:|ciphertext-canary|private-canary/);
		return true;
	});
}

test('descriptors are immutable and include only managed integration fields', () => {
	assert.deepEqual(
		INTEGRATION_FIELDS.map(({ key }) => key),
		Object.keys(valid)
	);
	assert.ok(Object.isFrozen(INTEGRATION_FIELDS));
	assert.ok(INTEGRATION_FIELDS.every(Object.isFrozen));
	assert.deepEqual(
		INTEGRATION_FIELDS.filter(({ secret }) => !secret).map(({ key }) => key),
		['TELEGRAM_CHAT_ID', 'TELEGRAM_WEBHOOK_BASE_URL']
	);
});

test('encrypted deployment persistence survives fresh reads without leaking secrets in status', (t) => {
	const fixture = setup(t);
	const { cwd } = fixture;
	const env = { OPENAI_API_KEY: 'environment-key' };
	const status = saveIntegrationSettings(valid, { cwd, env });
	const record = JSON.parse(contents(fixture));
	assert.equal(record.version, 1);
	assert.ok(record.ciphertext.startsWith('v1:'));
	assert.ok(!Object.values(valid).some((secret) => record.ciphertext.includes(secret)));
	assert.deepEqual(JSON.parse(decryptSecret(record.ciphertext)), {
		scope: 'AIRadiologyReport/integrations/v1',
		fields: valid
	});
	assert.ok(!contents(fixture).includes(master));
	assert.deepEqual(resolveIntegrationSettings({ cwd, env }), valid);
	assert.equal(env.OPENAI_API_KEY, 'environment-key');
	assert.equal(status.encryptionConfigured, true);
	assert.equal(status.fields.TELEGRAM_CHAT_ID.value, valid.TELEGRAM_CHAT_ID);
	assert.equal(status.fields.TELEGRAM_WEBHOOK_BASE_URL.value, valid.TELEGRAM_WEBHOOK_BASE_URL);
	for (const { key, secret } of INTEGRATION_FIELDS) {
		assert.equal(status.fields[key].source, 'admin');
		assert.equal(status.fields[key].configured, true);
		if (secret) assert.equal(Object.hasOwn(status.fields[key], 'value'), false);
	}
	assert.doesNotMatch(JSON.stringify(status), /synthetic|v1:|123456789:/);
});

test('environment fallback and status reads require no master and create no files or directories', (t) => {
	const fixture = setup(t);
	const { cwd } = fixture;
	delete process.env.STORAGE_ENCRYPTION_KEY;
	const env = { OPENAI_API_KEY: 'synthetic-fallback', TELEGRAM_CHAT_ID: '-10099' };
	const status = readIntegrationSettings({ cwd, env });
	assert.equal(status.encryptionConfigured, false);
	assert.deepEqual(status.fields.OPENAI_API_KEY, { configured: true, source: 'environment' });
	assert.deepEqual(status.fields.ELEVENLABS_API_KEY, { configured: false, source: 'unset' });
	assert.deepEqual(status.fields.TELEGRAM_CHAT_ID, {
		configured: true,
		source: 'environment',
		value: '-10099'
	});
	assert.equal(resolveIntegrationSettings({ cwd, env }).OPENAI_API_KEY, 'synthetic-fallback');
	assert.equal(resolveIntegrationSettings({ cwd, env }).GEMINI_API_KEY, '');
	assert.deepEqual(fs.readdirSync(cwd), []);
	sanitized(() => saveIntegrationSettings({ OPENAI_API_KEY: 'synthetic-secret' }, { cwd, env }));
	assert.equal(contents(fixture), null);
	assert.deepEqual(fs.readdirSync(cwd), []);
});

test('empty admin values disable fallback and remain encrypted across reads', (t) => {
	const fixture = setup(t);
	const { cwd } = fixture;
	const env = { ...valid };
	saveIntegrationSettings(Object.fromEntries(Object.keys(valid).map((key) => [key, ''])), {
		cwd,
		env
	});
	const status = readIntegrationSettings({ cwd, env });
	for (const key of Object.keys(valid)) {
		assert.equal(resolveIntegrationSettings({ cwd, env })[key], '');
		assert.equal(status.fields[key].configured, false);
		assert.equal(status.fields[key].source, 'admin');
	}
	assert.ok(JSON.parse(contents(fixture)).ciphertext.startsWith('v1:'));
});

test('partial updates preserve unrelated settings and do not write on reads', (t) => {
	const fixture = setup(t);
	const { cwd } = fixture;
	fs.writeFileSync(path.join(cwd, 'unrelated.txt'), 'untouched');
	saveIntegrationSettings(valid, { cwd, env: {} });
	saveIntegrationSettings({ GEMINI_API_KEY: 'synthetic-replacement' }, { cwd, env: {} });
	const before = contents(fixture);
	const statBefore = fs.statSync(fixture.filename);
	const writes = [
		'mkdirSync',
		'writeFileSync',
		'renameSync',
		'chmodSync',
		'fchmodSync',
		'fsyncSync'
	];
	const originals = Object.fromEntries(writes.map((name) => [name, fs[name]]));
	for (const name of writes)
		fs[name] = () => {
			throw new Error('Reads must not write');
		};
	try {
		readIntegrationSettings({ cwd, env: {} });
		resolveIntegrationSettings({ cwd, env: {} });
	} finally {
		for (const name of writes) fs[name] = originals[name];
	}
	const statAfter = fs.statSync(fixture.filename);
	assert.equal(statAfter.ino, statBefore.ino);
	assert.equal(statAfter.mtimeMs, statBefore.mtimeMs);
	assert.deepEqual(contents(fixture), before);
	assert.equal(resolveIntegrationSettings({ cwd, env: {} }).OPENAI_API_KEY, valid.OPENAI_API_KEY);
	assert.equal(fs.readFileSync(path.join(cwd, 'unrelated.txt'), 'utf8'), 'untouched');
	assert.deepEqual(fs.readdirSync(fixture.directory), ['settings.json']);
});

test('strict input validation rejects unknown keys and invalid batches before writing', (t) => {
	const fixture = setup(t);
	const { cwd } = fixture;
	saveIntegrationSettings(valid, { cwd, env: {} });
	const before = contents(fixture);
	for (const updates of [
		null,
		undefined,
		[],
		'secret',
		1,
		{ STORAGE_ENCRYPTION_KEY: master },
		{ unknown: 'private-canary' },
		{ OPENAI_API_KEY: null },
		{ OPENAI_API_KEY: 42 },
		{ OPENAI_API_KEY: 'x'.repeat(2049) },
		{ OPENAI_API_KEY: 'private-canary\n' },
		{ ELEVENLABS_API_KEY: 'private-canary\u007f' },
		{ GEMINI_API_KEY: 'private-canary\u0085' },
		{ TELEGRAM_BOT_TOKEN: 'not-a-token' },
		{ TELEGRAM_BOT_TOKEN: 'abc:abcdefghijklmnopqrstuvwxyz' },
		{ TELEGRAM_CHAT_ID: '1234' },
		{ TELEGRAM_CHAT_ID: '-0' },
		{ TELEGRAM_CHAT_ID: '-123.4' },
		{ TELEGRAM_WEBHOOK_SECRET: 'private-canary!' },
		{ TELEGRAM_WEBHOOK_SECRET: 'x'.repeat(257) },
		{ OPENAI_API_KEY: 'replacement', TELEGRAM_CHAT_ID: 'bad' },
		Object.assign(Object.create({ inherited: 'secret' }), { OPENAI_API_KEY: 'secret' }),
		{ [Symbol('unknown')]: 'secret' },
		Object.defineProperty({}, 'OPENAI_API_KEY', {
			get() {
				throw new Error('private-canary');
			}
		}),
		Object.defineProperty({}, 'OPENAI_API_KEY', { value: 123 })
	]) {
		sanitized(() => saveIntegrationSettings(updates, { cwd, env: {} }));
		assert.deepEqual(contents(fixture), before);
	}
});

test('webhook origin canonicalizes HTTPS and rejects nonpublic or non-origin URLs', (t) => {
	const fixture = setup(t);
	const { cwd } = fixture;
	saveIntegrationSettings(
		{ TELEGRAM_WEBHOOK_BASE_URL: 'HTTPS://Radiology.Example.COM:443/' },
		{ cwd, env: {} }
	);
	assert.equal(
		resolveIntegrationSettings({ cwd, env: {} }).TELEGRAM_WEBHOOK_BASE_URL,
		'https://radiology.example.com'
	);
	const before = contents(fixture);
	for (const value of [
		'http://public.example.com',
		'https://user:private-canary@public.example.com',
		'https://public.example.com/path',
		'https://public.example.com/a/..',
		'https://public.example.com/?',
		'https://public.example.com/#',
		'https://public.example.com?private-canary',
		'https://public.example.com#private-canary',
		'https://localhost',
		'https://service.local',
		'https://service.internal',
		'https://127.0.0.1',
		'https://127.1',
		'https://0x7f000001',
		'https://10.0.0.1',
		'https://172.16.0.1',
		'https://192.168.1.1',
		'https://169.254.169.254',
		'https://100.64.0.1',
		'https://[::1]',
		'https://[::ffff:127.0.0.1]',
		'https://public.example.com\\private-canary',
		' https://public.example.com',
		'https://public.example.com\n'
	]) {
		sanitized(() =>
			saveIntegrationSettings({ TELEGRAM_WEBHOOK_BASE_URL: value }, { cwd, env: {} })
		);
		assert.deepEqual(contents(fixture), before);
	}
});

test('missing, malformed, and wrong master fail closed once values are saved', (t) => {
	const fixture = setup(t);
	const { cwd } = fixture;
	saveIntegrationSettings(valid, { cwd, env: {} });
	const before = contents(fixture);
	for (const key of [undefined, '', 'private-canary', otherMaster]) {
		if (key === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
		else process.env.STORAGE_ENCRYPTION_KEY = key;
		const env = { OPENAI_API_KEY: 'must-not-fallback' };
		for (const action of [
			() => resolveIntegrationSettings({ cwd, env }),
			() => readIntegrationSettings({ cwd, env }),
			() => applyIntegrationSettings({ cwd, env }),
			() => saveIntegrationSettings({ GEMINI_API_KEY: 'synthetic-new' }, { cwd, env })
		])
			sanitized(action);
		assert.deepEqual(env, { OPENAI_API_KEY: 'must-not-fallback' });
		assert.deepEqual(contents(fixture), before);
	}
});

test('corrupt envelopes and authenticated invalid plaintext fail closed without leaking data', (t) => {
	const fixture = setup(t);
	const { cwd } = fixture;
	const envelope = (payload) => ({
		version: 1,
		ciphertext: encryptSecret(JSON.stringify(payload))
	});
	for (const record of [
		null,
		[],
		{},
		{ version: 2, ciphertext: 'ciphertext-canary' },
		{ version: 1, ciphertext: 'ciphertext-canary' },
		{ version: 1, ciphertext: 'v1:AAAA' },
		{ version: 1, ciphertext: encryptSecret('private-canary') },
		envelope({ scope: 'wrong-scope', fields: {} }),
		envelope({ scope: 'AIRadiologyReport/integrations/v1', fields: { unknown: 'private-canary' } }),
		envelope({
			scope: 'AIRadiologyReport/integrations/v1',
			fields: { OPENAI_API_KEY: '\nprivate-canary' }
		})
	]) {
		writeFixture(fixture, record);
		sanitized(() => resolveIntegrationSettings({ cwd, env: { OPENAI_API_KEY: 'fallback' } }));
		sanitized(() => readIntegrationSettings({ cwd, env: {} }));
		sanitized(() => saveIntegrationSettings({}, { cwd, env: {} }));
	}
	fs.writeFileSync(fixture.filename, '{private-canary');
	sanitized(() => readIntegrationSettings({ cwd, env: {} }));
	fs.writeFileSync(fixture.filename, 'x'.repeat(65537));
	sanitized(() => readIntegrationSettings({ cwd, env: {} }));
});

test('failed durable writes preserve the previous file and remove incomplete pending files', (t) => {
	const fixture = setup(t);
	const { cwd } = fixture;
	saveIntegrationSettings(valid, { cwd, env: {} });
	const before = contents(fixture);
	const original = fs.fsyncSync;
	let calls = 0;
	fs.fsyncSync = () => {
		calls++;
		throw new Error('private-canary');
	};
	try {
		sanitized(() => saveIntegrationSettings({ OPENAI_API_KEY: 'synthetic-new' }, { cwd, env: {} }));
	} finally {
		fs.fsyncSync = original;
	}
	assert.ok(calls > 0);
	assert.equal(contents(fixture), before);
	assert.deepEqual(fs.readdirSync(fixture.directory), ['settings.json']);
});

test('private atomic files are flushed before rename and directory metadata is flushed afterward', (t) => {
	const fixture = setup(t);
	const { cwd } = fixture;
	saveIntegrationSettings(valid, { cwd, env: {} });
	const events = [];
	const originalSync = fs.fsyncSync;
	const originalRename = fs.renameSync;
	fs.fsyncSync = (fd) => {
		events.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file');
		return originalSync(fd);
	};
	fs.renameSync = (...args) => {
		events.push('rename');
		return originalRename(...args);
	};
	try {
		saveIntegrationSettings({ GEMINI_API_KEY: 'synthetic-new' }, { cwd, env: {} });
	} finally {
		fs.fsyncSync = originalSync;
		fs.renameSync = originalRename;
	}
	assert.deepEqual(
		events,
		process.platform === 'win32' ? ['file', 'rename'] : ['file', 'rename', 'directory']
	);
	assert.deepEqual(fs.readdirSync(fixture.directory), ['settings.json']);
	if (process.platform !== 'win32') {
		assert.equal(fs.statSync(fixture.filename).mode & 0o777, 0o600);
		assert.equal(fs.statSync(fixture.directory).mode & 0o777, 0o700);
	}
});

test('deployment settings survive a separate process restart and restored database replacement', (t) => {
	const fixture = setup(t);
	const { cwd } = fixture;
	saveIntegrationSettings(valid, { cwd, env: {} });
	const before = contents(fixture);
	const filename = path.join(cwd, 'synthetic.sqlite');
	const replaceDatabase = (value) => {
		fs.rmSync(filename, { force: true });
		const db = new Database(filename);
		try {
			db.exec('CREATE TABLE application_settings(key TEXT PRIMARY KEY, value TEXT)');
			db.prepare('INSERT INTO application_settings VALUES (?, ?)').run('TELEGRAM_BOT_TOKEN', value);
		} finally {
			db.close();
		}
	};
	replaceDatabase('synthetic-old-database-bot');
	replaceDatabase('synthetic-restored-database-bot');
	assert.deepEqual(resolveIntegrationSettings({ cwd, env: {} }), valid);
	const moduleUrl = new URL('../src/lib/server/integration-settings.js', import.meta.url).href;
	const result = spawnSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`import { resolveIntegrationSettings } from ${JSON.stringify(moduleUrl)};
		console.log(JSON.stringify(resolveIntegrationSettings({ env: {} })));`
		],
		{ cwd, env: { STORAGE_ENCRYPTION_KEY: master }, encoding: 'utf8' }
	);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), valid);
	assert.equal(contents(fixture), before);
});

for (const component of ['restore-staging', '.integrations']) {
	test(`symlinked ${component} directories fail closed without touching the target`, (t) => {
		const fixture = setup(t);
		const { cwd } = fixture;
		const target = path.join(cwd, 'protected-target');
		fs.mkdirSync(target, { mode: 0o700 });
		const link = component === 'restore-staging' ? path.join(cwd, component) : fixture.directory;
		if (component === '.integrations') fs.mkdirSync(path.dirname(link), { mode: 0o700 });
		try {
			fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
		} catch (error) {
			if (error.code === 'EPERM') return t.skip('Directory symlinks unavailable');
			throw error;
		}
		sanitized(() => readIntegrationSettings({ cwd, env: {} }));
		sanitized(() => saveIntegrationSettings(valid, { cwd, env: {} }));
		assert.deepEqual(fs.readdirSync(target), []);
	});
}

test('hardlinked settings files are rejected without modifying the protected target', (t) => {
	const fixture = setup(t);
	const { cwd } = fixture;
	saveIntegrationSettings(valid, { cwd, env: {} });
	const before = contents(fixture);
	const target = path.join(cwd, 'protected.json');
	fs.renameSync(fixture.filename, target);
	fs.linkSync(target, fixture.filename);
	sanitized(() => readIntegrationSettings({ cwd, env: {} }));
	sanitized(() => saveIntegrationSettings(valid, { cwd, env: {} }));
	assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('non-file settings paths fail closed', (t) => {
	const fixture = setup(t);
	const { cwd } = fixture;
	fs.mkdirSync(fixture.filename, { recursive: true, mode: 0o700 });
	sanitized(() => readIntegrationSettings({ cwd, env: {} }));
	sanitized(() => saveIntegrationSettings(valid, { cwd, env: {} }));
});

test('symlinked settings files fail closed', (t) => {
	const fixture = setup(t);
	const { cwd } = fixture;
	saveIntegrationSettings(valid, { cwd, env: {} });
	const before = contents(fixture);
	const target = path.join(cwd, 'protected.json');
	fs.renameSync(fixture.filename, target);
	try {
		fs.symlinkSync(target, fixture.filename, 'file');
	} catch (error) {
		if (error.code === 'EPERM') return t.skip('File symlinks unavailable');
		throw error;
	}
	sanitized(() => readIntegrationSettings({ cwd, env: {} }));
	sanitized(() => saveIntegrationSettings(valid, { cwd, env: {} }));
	assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('empty vaults remain authenticated and environment master cannot be overridden through options', (t) => {
	const fixture = setup(t);
	const { cwd } = fixture;
	saveIntegrationSettings({}, { cwd, env: { STORAGE_ENCRYPTION_KEY: otherMaster } });
	process.env.STORAGE_ENCRYPTION_KEY = otherMaster;
	sanitized(() => readIntegrationSettings({ cwd, env: { STORAGE_ENCRYPTION_KEY: master } }));
});

test('repeated apply preserves per-object startup fallback through updates, clears, and removal', (t) => {
	const fixture = setup(t);
	const { cwd } = fixture;
	const env = { OPENAI_API_KEY: 'original-fallback', OTHER: 'untouched' };
	const otherEnv = { OPENAI_API_KEY: 'other-fallback' };
	saveIntegrationSettings(
		{ OPENAI_API_KEY: 'synthetic-first', GEMINI_API_KEY: 'synthetic-gemini' },
		{ cwd, env }
	);
	applyIntegrationSettings({ cwd, env });
	applyIntegrationSettings({ cwd, env: otherEnv });
	assert.equal(env.OPENAI_API_KEY, 'synthetic-first');
	saveIntegrationSettings({ OPENAI_API_KEY: 'synthetic-second' }, { cwd, env });
	assert.equal(env.OPENAI_API_KEY, 'synthetic-first');
	applyIntegrationSettings({ cwd, env });
	applyIntegrationSettings({ cwd, env });
	assert.equal(env.OPENAI_API_KEY, 'synthetic-second');
	saveIntegrationSettings({ OPENAI_API_KEY: '' }, { cwd, env });
	applyIntegrationSettings({ cwd, env });
	assert.equal(env.OPENAI_API_KEY, '');
	fs.unlinkSync(fixture.filename);
	assert.equal(readIntegrationSettings({ cwd, env }).fields.OPENAI_API_KEY.source, 'environment');
	assert.equal(readIntegrationSettings({ cwd, env }).fields.GEMINI_API_KEY.source, 'unset');
	applyIntegrationSettings({ cwd, env });
	applyIntegrationSettings({ cwd, env: otherEnv });
	assert.equal(env.OPENAI_API_KEY, 'original-fallback');
	assert.equal(otherEnv.OPENAI_API_KEY, 'other-fallback');
	assert.equal(env.GEMINI_API_KEY, '');
	assert.equal(env.OTHER, 'untouched');
	assert.equal(Object.hasOwn(env, 'STORAGE_ENCRYPTION_KEY'), false);
});
