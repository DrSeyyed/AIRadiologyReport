import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
	backupRecovery,
	restoreRecovery,
	validateRecoveryManifest
} from '../src/lib/server/recovery-backups.js';
import {
	exportIntegrationBackup,
	readIntegrationBackup
} from '../src/lib/server/integration-backup.js';
import * as storageCrypto from '../src/lib/server/storage-crypto.js';

const connection = {
	host: 'offline.invalid',
	username: 'backup',
	root: '/vault',
	fingerprint: 'pinned',
	port: 22
};
const fields = [
	'OPENAI_API_KEY',
	'ELEVENLABS_API_KEY',
	'GEMINI_API_KEY',
	'TELEGRAM_BOT_TOKEN',
	'TELEGRAM_CHAT_ID',
	'TELEGRAM_WEBHOOK_SECRET',
	'TELEGRAM_WEBHOOK_BASE_URL'
];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function secrets(key = randomBytes(32)) {
	return {
		encryptSecret(value) {
			const iv = randomBytes(12);
			const cipher = createCipheriv('aes-256-gcm', key, iv);
			const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
			return `v1:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')}`;
		},
		decryptSecret(value) {
			const bytes = Buffer.from(value.slice(3), 'base64');
			const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
			cipher.setAuthTag(bytes.subarray(12, 28));
			return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
		}
	};
}
async function fixture(t) {
	const root = path.join(process.cwd(), 'tests', `.integration-recovery-${randomUUID()}`);
	const app = path.join(root, 'app');
	const remote = path.join(root, 'remote');
	await fs.mkdir(path.join(app, 'uploads'), { recursive: true });
	await fs.mkdir(remote);
	const db = new Database(path.join(app, 'source.sqlite'));
	db.exec(
		'CREATE TABLE study_recordings(id INTEGER PRIMARY KEY, audio_report_path TEXT, text_report_path TEXT); CREATE TABLE recording_audio_parts(id INTEGER PRIMARY KEY, audio_report_path TEXT);'
	);
	t.after(async () => {
		if (db.open) db.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	const crypto = secrets();
	const fileKey = randomBytes(32);
	const local = (target) => {
		assert.ok(target.startsWith('/vault/') && !target.split('/').includes('..'));
		return path.join(remote, ...target.slice(7).split('/'));
	};
	const client = {
		async mkdir(target) {
			await fs.mkdir(local(target), { recursive: true });
		},
		async lstat(target) {
			return fs.lstat(local(target));
		},
		async put(source, target) {
			if (typeof source === 'string') await fs.copyFile(source, local(target));
			else await pipeline(source, createWriteStream(local(target)));
		},
		async rename(source, target) {
			await fs.rename(local(source), local(target));
		},
		async get(source, target) {
			await fs.copyFile(local(source), target);
		},
		createReadStream(source) {
			return createReadStream(local(source));
		},
		async list(target) {
			return (await fs.readdir(local(target), { withFileTypes: true })).map((entry) => ({
				name: entry.name,
				type: entry.isDirectory() ? 'd' : '-'
			}));
		}
	};
	const deps = {
		...crypto,
		assertStorageKey() {},
		withStorage: async (_settings, callback) => callback(client),
		storagePath: (_settings, ...parts) => '/vault/' + parts.join('/'),
		hashRemote: async (_client, target) => digest(await fs.readFile(local(target))),
		hashStorageFile: async (_client, target) => digest(await fs.readFile(local(target))),
		async statStorageFiles(_client, targets) {
			return Promise.all(
				targets.map(async (target) => {
					try {
						return { size: (await fs.stat(local(target))).size };
					} catch (error) {
						if (error.code !== 'ENOENT') throw error;
						return null;
					}
				})
			);
		},
		async linkStorageFile(_client, source, target) {
			await fs.link(local(source), local(target));
		},
		async encryptFile(source, target) {
			const iv = randomBytes(12);
			const cipher = createCipheriv('aes-256-gcm', fileKey, iv);
			const encrypted = Buffer.concat([cipher.update(await fs.readFile(source)), cipher.final()]);
			await fs.writeFile(target, Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
		},
		async decryptFile(source, target) {
			const bytes = await fs.readFile(source);
			const cipher = createDecipheriv('aes-256-gcm', fileKey, bytes.subarray(0, 12));
			cipher.setAuthTag(bytes.subarray(12, 28));
			await fs.writeFile(
				target,
				Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()])
			);
		}
	};
	const env = {
		ORIGIN: 'https://offline.invalid',
		OPENAI_API_KEY: 'offline-openai-sensitive',
		ELEVENLABS_API_KEY: '',
		GEMINI_API_KEY: 'offline-gemini-sensitive',
		TELEGRAM_BOT_TOKEN: `12345:${'a'.repeat(35)}`,
		TELEGRAM_CHAT_ID: '-10012345',
		TELEGRAM_WEBHOOK_SECRET: 'offline-webhook-sensitive',
		TELEGRAM_WEBHOOK_BASE_URL: 'https://offline.domain.org',
		STORAGE_ENCRYPTION_KEY: 'never-export-master'
	};
	await fs.writeFile(
		path.join(app, '.env'),
		Object.entries(env)
			.map(([key, value]) => `${key}=${value}`)
			.join('\n')
	);
	const options = { cwd: app, env, now: 1800000000 };
	async function backup(extra = {}, overrides = {}) {
		return backupRecovery(db, connection, { ...options, ...extra }, { ...deps, ...overrides });
	}
	async function manifest(result) {
		const target = path.join(root, `${randomUUID()}.json`);
		await deps.decryptFile(path.join(remote, 'backups', 'manifests', `${result.id}.enc`), target);
		return JSON.parse(await fs.readFile(target, 'utf8'));
	}
	function restoreOptions(result) {
		return {
			manifestFile: path.join(remote, 'backups', 'manifests', `${result.id}.enc`),
			objectsDirectory: path.join(remote, 'backups', 'objects'),
			outputDirectory: path.join(root, `restored-${randomUUID()}`)
		};
	}
	async function rewriteManifest(result, value) {
		const plain = path.join(root, `${randomUUID()}.json`);
		await fs.writeFile(plain, JSON.stringify(value));
		await deps.encryptFile(plain, path.join(remote, 'backups', 'manifests', `${result.id}.enc`));
	}
	return {
		root,
		app,
		remote,
		db,
		deps,
		env,
		options,
		backup,
		manifest,
		restoreOptions,
		rewriteManifest
	};
}

for (const [name, options] of [
	['database v2', { kind: 'database', format: 'concat-gzip-v1' }],
	['full v2', { kind: 'full', format: 'concat-gzip-v1' }],
	['full immutable v1', { kind: 'full' }]
]) {
	test(`${name}: authenticated credentials remain encrypted in staging and metadata is redacted`, async (t) => {
		const f = await fixture(t);
		const result = await f.backup(options);
		const manifest = await f.manifest(result);
		assert.equal(manifest.files.filter((entry) => entry.role === 'integrations').length, 1);
		const restore = f.restoreOptions(result);
		const restored = await restoreRecovery(restore, f.deps);
		const serialized = await fs.readFile(
			path.join(restore.outputDirectory, 'integration-settings.json'),
			'utf8'
		);
		const values = readIntegrationBackup(serialized, {
			backupId: result.id,
			decrypt: f.deps.decryptSecret
		});
		assert.deepEqual(values, Object.fromEntries(fields.map((key) => [key, f.env[key]])));
		assert.equal(restored.integrationFields.length, 7);
		assert.equal(
			restored.integrationFields.find(({ key }) => key === 'ELEVENLABS_API_KEY').configured,
			false
		);
		const runtime = await fs.readFile(
			path.join(restore.outputDirectory, 'environment.json'),
			'utf8'
		);
		const envFile = await fs.readFile(path.join(restore.outputDirectory, '.env'), 'utf8');
		for (const key of [...fields, 'STORAGE_ENCRYPTION_KEY']) {
			assert.ok(!runtime.includes(key));
			assert.ok(!envFile.includes(key));
			if (f.env[key]) assert.ok(!serialized.includes(f.env[key]));
		}
		assert.doesNotMatch(
			JSON.stringify({ result, manifest, restored }),
			/offline-openai-sensitive|offline-gemini-sensitive|offline-webhook-sensitive|ciphertext|never-export-master/
		);
		assert.deepEqual(
			(await fs.readdir(f.app)).filter((name) => name.startsWith('.recovery-work-')),
			[]
		);
		assert.ok(!(await fs.readdir(f.app)).includes('integration-settings.json'));
	});
}

test('production storage encryption round-trips snapshots in every format using an isolated generated master', async (t) => {
	const original = process.env.STORAGE_ENCRYPTION_KEY;
	t.after(() => {
		if (original === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
		else process.env.STORAGE_ENCRYPTION_KEY = original;
	});
	process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
	for (const options of [
		{ kind: 'full' },
		{ kind: 'full', format: 'concat-gzip-v1' },
		{ kind: 'database', format: 'concat-gzip-v1' }
	]) {
		const f = await fixture(t);
		Object.assign(f.deps, storageCrypto);
		const result = await f.backup(options);
		const restore = f.restoreOptions(result);
		assert.equal((await restoreRecovery(restore, f.deps)).integrationFields.length, 7);
		const serialized = await fs.readFile(
			path.join(restore.outputDirectory, 'integration-settings.json'),
			'utf8'
		);
		assert.equal(
			readIntegrationBackup(serialized, { backupId: result.id }).OPENAI_API_KEY,
			f.env.OPENAI_API_KEY
		);
		assert.ok(!serialized.includes(process.env.STORAGE_ENCRYPTION_KEY));
	}
});

test('missing production master fails rather than omitting the credential artifact', async (t) => {
	const f = await fixture(t);
	const original = process.env.STORAGE_ENCRYPTION_KEY;
	delete process.env.STORAGE_ENCRYPTION_KEY;
	t.after(() => {
		if (original !== undefined) process.env.STORAGE_ENCRYPTION_KEY = original;
	});
	await assert.rejects(f.backup({ kind: 'full' }, { encryptSecret: undefined }), {
		message: 'Recovery backup failed.'
	});
	assert.deepEqual(
		(await fs.readdir(f.app)).filter((name) => name.startsWith('.recovery-work-')),
		[]
	);
	assert.deepEqual(await fs.readdir(f.remote), []);
});

test('snapshot freezes credentials synchronously before asynchronous SQLite backup', async (t) => {
	const f = await fixture(t);
	const original = f.db.backup.bind(f.db);
	f.db.backup = (...args) => {
		f.env.OPENAI_API_KEY = 'changed-after-snapshot';
		return original(...args);
	};
	const result = await f.backup({ kind: 'full' });
	const restore = f.restoreOptions(result);
	await restoreRecovery(restore, f.deps);
	const values = readIntegrationBackup(
		await fs.readFile(path.join(restore.outputDirectory, 'integration-settings.json'), 'utf8'),
		{ backupId: result.id, decrypt: f.deps.decryptSecret }
	);
	assert.equal(values.OPENAI_API_KEY, 'offline-openai-sensitive');
});

test('legacy v1 and v2 manifests without integration artifacts restore with no choices', async (t) => {
	for (const options of [{ kind: 'full' }, { kind: 'database', format: 'concat-gzip-v1' }]) {
		const f = await fixture(t);
		const result = await f.backup(options);
		const manifest = await f.manifest(result);
		const entry = manifest.files.find((entry) => entry.role === 'integrations');
		manifest.files = manifest.files.filter((entry) => entry.role !== 'integrations');
		if (manifest.version === 2) {
			assert.equal(entry.parts.length, 1);
			const index = entry.parts[0].bundle;
			manifest.bundles.splice(index, 1);
			for (const file of manifest.files)
				for (const part of file.parts) if (part.bundle > index) part.bundle--;
		}
		await f.rewriteManifest(result, manifest);
		const restore = f.restoreOptions(result);
		assert.deepEqual((await restoreRecovery(restore, f.deps)).integrationFields, []);
		await assert.rejects(fs.stat(path.join(restore.outputDirectory, 'integration-settings.json')), {
			code: 'ENOENT'
		});
	}
});

for (const fault of ['missing', 'corrupt', 'wrong-key', 'wrong-binding']) {
	test(`restore rejects ${fault} integration artifacts without output or live changes`, async (t) => {
		const f = await fixture(t);
		const before = await fs.readFile(path.join(f.app, '.env'), 'utf8');
		const overrides =
			fault === 'wrong-binding'
				? {
						exportIntegrationBackup: (options) =>
							exportIntegrationBackup({ ...options, backupId: `1800000001-${randomUUID()}` })
					}
				: {};
		const result = await f.backup({ kind: 'full' }, overrides);
		const manifest = await f.manifest(result);
		const entry = manifest.files.find((entry) => entry.role === 'integrations');
		const object = path.join(f.remote, 'backups', 'objects', entry.object);
		if (fault === 'missing') await fs.unlink(object);
		if (fault === 'corrupt') {
			const plain = path.join(f.root, 'corrupt.json');
			await fs.writeFile(plain, '{"version":1,"ciphertext":"invalid-sensitive"}');
			await f.deps.encryptFile(plain, object);
			entry.sha256 = digest(await fs.readFile(plain));
			entry.bytes = (await fs.stat(plain)).size;
			entry.remoteSha256 = digest(await fs.readFile(object));
			entry.object = `${entry.remoteSha256}.enc`;
			await fs.rename(object, path.join(path.dirname(object), entry.object));
			await f.rewriteManifest(result, manifest);
		}
		const restore = f.restoreOptions(result);
		await assert.rejects(
			restoreRecovery(restore, {
				...f.deps,
				...(fault === 'wrong-key' ? { decryptSecret: secrets().decryptSecret } : {})
			}),
			(error) => {
				assert.equal(error.message, 'Recovery restore failed. Output was not published.');
				return true;
			}
		);
		await assert.rejects(fs.stat(restore.outputDirectory), { code: 'ENOENT' });
		assert.equal(await fs.readFile(path.join(f.app, '.env'), 'utf8'), before);
		assert.deepEqual(
			(await fs.readdir(f.root)).filter((name) => name.startsWith('.recovery-work-')),
			[]
		);
	});
}

test('integration path allowance rejects mismatched roles, arbitrary roots and collisions', async (t) => {
	const f = await fixture(t);
	const result = await f.backup({ kind: 'full' });
	const original = await f.manifest(result);
	for (const [name, mutate] of [
		[
			'wrong role',
			(entry) => {
				entry.role = 'environment';
			}
		],
		[
			'wrong path',
			(entry) => {
				entry.path = 'other.json';
			}
		],
		[
			'nested path',
			(entry) => {
				entry.path = 'uploads/integration-settings.json';
			}
		],
		[
			'case collision',
			(entry, manifest) => {
				manifest.files.push({ ...entry, path: 'INTEGRATION-SETTINGS.JSON' });
			}
		],
		[
			'root collision',
			(entry, manifest) => {
				manifest.files.push({
					...entry,
					path: 'integration-settings.json/child',
					role: 'environment'
				});
			}
		]
	]) {
		const manifest = structuredClone(original);
		mutate(
			manifest.files.find((entry) => entry.role === 'integrations'),
			manifest
		);
		assert.throws(() => validateRecoveryManifest(manifest), undefined, name);
	}
});
