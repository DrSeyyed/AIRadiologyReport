import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as activationFiles from '../src/lib/server/restore-activation-files.js';
import http from 'node:http';
import { test } from 'node:test';
import {
	superviseApp,
	probeRestoreHealth,
	detectRestoreDataPersistence
} from '../scripts/start-app.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

const rootMount = '1 0 0:1 / / rw - overlay overlay rw';
const dataRoots = ['db', 'uploads', 'voice', 'restore-staging'];
function mount(path, filesystem = 'ext4', options = 'rw', id = 2) {
	return `${id} 1 8:1 / ${path} ${options} shared:1 - ${filesystem} /dev/data ${options}`;
}
function inspectMounts(mounts, cwd = '/app') {
	return detectRestoreDataPersistence({
		cwd,
		platform: 'linux',
		readMountInfo: async () => [rootMount, ...mounts].join('\n')
	});
}

test('private config persistence requires its own covering durable mount, not just clinical mounts', async () => {
	const inspect = (mounts) =>
		detectRestoreDataPersistence({
			cwd: '/app',
			platform: 'linux',
			roots: ['config'],
			readMountInfo: async () => [rootMount, ...mounts].join('\n')
		});
	assert.equal(
		await inspect(dataRoots.map((name, index) => mount(`/app/${name}`, 'ext4', 'rw', index + 2))),
		false
	);
	assert.equal(await inspect([mount('/app/config')]), true);
	assert.equal(await inspect([mount('/app/config', 'tmpfs')]), false);
	assert.equal(await inspect([mount('/app/config', 'ext4', 'ro')]), false);
	assert.equal(await inspect([mount('/app')]), true);
});

test('persistence accepts four exact mounts and shared non-root ancestors', async () => {
	assert.equal(
		await inspectMounts(
			dataRoots.map((name, index) => mount(`/app/${name}`, 'ext4', 'rw', index + 2))
		),
		true
	);
	assert.equal(await inspectMounts([mount('/app')]), true);
	assert.equal(await inspectMounts([mount('/data', 'xfs')], '/data/application'), true);
	assert.equal(await inspectMounts([mount('/app/', 'nfs4')]), true);
});

test('ordinary bind and named-volume backing filesystems remain accepted', async () => {
	for (const filesystem of [
		'ext4',
		'xfs',
		'btrfs',
		'zfs',
		'nfs',
		'nfs4',
		'cifs',
		'9p',
		'virtiofs'
	]) {
		assert.equal(await inspectMounts([mount('/app', filesystem)]), true, filesystem);
		const namedVolume = mount('/app', filesystem).replace(
			'8:1 / /app',
			'8:1 /var/lib/docker/volumes/app/_data /app'
		);
		assert.equal(await inspectMounts([namedVolume]), true, `${filesystem} named volume`);
		const bind = mount('/app', filesystem).replace('8:1 / /app', '8:1 /host/app-data /app');
		assert.equal(await inspectMounts([bind]), true, `${filesystem} bind mount`);
	}
});

test('persistence unescapes octal mount paths including spaces, tabs, newlines and backslashes', async () => {
	const cwd = '/app space\tline\nback\\slash';
	const encoded = cwd
		.replace(/\\/g, '\\134')
		.replace(/ /g, '\\040')
		.replace(/\t/g, '\\011')
		.replace(/\n/g, '\\012');
	assert.equal(await inspectMounts([mount(encoded)], cwd), true);
	assert.equal(await inspectMounts([mount('/app\\040space')], '/app space'), true);
});

test('rootfs, overlay, memory, pseudo and unknown filesystems do not establish persistence', async () => {
	assert.equal(await inspectMounts([]), false);
	assert.equal(
		await detectRestoreDataPersistence({
			cwd: '/app',
			platform: 'linux',
			readMountInfo: async () => '1 0 8:1 / / rw - ext4 /dev/root rw'
		}),
		false
	);
	for (const filesystem of [
		'overlay',
		'rootfs',
		'tmpfs',
		'ramfs',
		'proc',
		'sysfs',
		'devtmpfs',
		'unknown'
	]) {
		assert.equal(await inspectMounts([mount('/app', filesystem)]), false, filesystem);
		assert.equal(
			await inspectMounts([mount('/app'), mount('/app/db', filesystem, 'rw', 3)]),
			false,
			`${filesystem} exact data-root mount`
		);
		assert.equal(
			await inspectMounts([mount('/app'), mount('/app/uploads/cache', filesystem, 'rw', 3)]),
			false,
			`${filesystem} nested data mount`
		);
	}
});

test('all four roots need coverage with exact path boundaries', async () => {
	for (const missing of dataRoots) {
		const mounts = dataRoots
			.filter((name) => name !== missing)
			.map((name, index) => mount(`/app/${name}`, 'ext4', 'rw', index + 2));
		assert.equal(await inspectMounts(mounts), false, missing);
	}
	assert.equal(await inspectMounts([mount('/application')]), false);
	assert.equal(await inspectMounts([mount('/app/db-suffix')]), false);
});

test('ephemeral or read-only mounts cannot hide below persistent ancestors', async () => {
	assert.equal(await inspectMounts([mount('/app'), mount('/app/db', 'tmpfs', 'rw', 3)]), false);
	assert.equal(
		await inspectMounts([mount('/app'), mount('/app/uploads/cache', 'tmpfs', 'rw', 3)]),
		false
	);
	assert.equal(await inspectMounts([mount('/app', 'ext4', 'ro')]), false);
	assert.equal(await inspectMounts([mount('/app'), mount('/app/voice', 'ext4', 'ro', 3)]), false);
	assert.equal(
		await inspectMounts([
			mount('/app', 'tmpfs'),
			...dataRoots.map((name, index) => mount(`/app/${name}`, 'xfs', 'rw', index + 3))
		]),
		true
	);
});

test('unavailable, non-Linux and malformed mount inspection disables capability', async () => {
	assert.equal(
		await detectRestoreDataPersistence({
			platform: 'win32',
			readMountInfo: () => {
				throw new Error('must not read');
			}
		}),
		false
	);
	assert.equal(
		await detectRestoreDataPersistence({
			platform: 'linux',
			cwd: '/app',
			readMountInfo: async () => {
				throw new Error('denied');
			}
		}),
		false
	);
	for (const contents of [
		'',
		'invalid',
		mount('/app'),
		`${rootMount}\ninvalid`,
		`${rootMount}\n${mount('/app\\bad')}`,
		`${rootMount}\n${mount('/app')}\n${mount('/app', 'xfs', 'rw', 3)}`
	]) {
		assert.equal(
			await detectRestoreDataPersistence({
				platform: 'linux',
				cwd: '/app',
				readMountInfo: async () => contents
			}),
			false,
			contents
		);
	}
});

function fixture({
	activation = { id: 'restore-123' },
	stageFailure,
	ignoreTerm = false,
	ignoreKill = false
} = {}) {
	const events = [];
	const children = [];
	const signals = new EventEmitter();
	let pid = 100;
	const api = {
		activationStatus() {
			return activation ? { state: 'queued', ...activation } : null;
		},
		async applyPendingActivation(options) {
			events.push(['apply', options]);
			return activation;
		},
		async finalizeActivation(options) {
			events.push(['finalize', options]);
		},
		async rollbackActivation(options) {
			events.push(['rollback', options]);
		}
	};
	const options = {
		cwd: process.cwd(),
		env: {},
		activationApi: api,
		initializeConfiguration: () => {},
		detectPersistence: async () => true,
		signalSource: signals,
		readinessTimeoutMs: 100,
		pollIntervalMs: 1,
		shutdownTimeoutMs: 5,
		killTimeoutMs: 5,
		logger: {
			error(message) {
				events.push(['error', message]);
			}
		},
		spawnProcess(command, args, spawnOptions) {
			const child = new EventEmitter();
			child.pid = pid++;
			child.stopped = false;
			child.finish = (code = 0, signal = null) => {
				if (child.stopped) return;
				child.stopped = true;
				events.push(['exit', args[0], code, signal]);
				child.emit('exit', code, signal);
			};
			child.kill = (signal) => {
				events.push(['kill', args[0], signal]);
				if ((signal === 'SIGKILL' && !ignoreKill) || (signal !== 'SIGKILL' && !ignoreTerm)) {
					child.finish(null, signal);
				}
				return true;
			};
			child.send = (message, callback) => {
				events.push(['send', message]);
				callback();
			};
			children.push({ child, command, args, options: spawnOptions });
			events.push(['spawn', args[0]]);
			if (args[0] !== 'build') queueMicrotask(() => child.finish(args[0] === stageFailure ? 2 : 0));
			return child;
		},
		async checkHealth() {
			events.push(['health']);
			setImmediate(() => children.at(-1).child.finish(7));
			return true;
		}
	};
	return { options, events, children, signals, api };
}

test('private config initializes before persistence inspection, activation and database startup', async () => {
	const f = fixture();
	f.options.initializeConfiguration = (options) => {
		assert.deepEqual(options, { cwd: f.options.cwd });
		f.events.push(['config']);
	};
	f.options.detectPersistence = async () => {
		f.events.push(['persistence']);
		return true;
	};
	assert.equal(await superviseApp(f.options), 7);
	assert.deepEqual(
		f.events.slice(0, 4).map((event) => event[0]),
		['config', 'persistence', 'apply', 'spawn']
	);
});

for (const persisted of [false, true]) {
	test(`Docker config persistence ${persisted ? 'permits initialization' : 'blocks migration before any writes'}`, async () => {
		const f = fixture();
		f.options.env.REQUIRE_PRIVATE_CONFIG_VOLUME = '1';
		let initialized = false;
		f.options.initializeConfiguration = () => {
			initialized = true;
		};
		f.options.detectConfigurationPersistence = async (options) => {
			assert.deepEqual(options, { cwd: f.options.cwd });
			return persisted;
		};
		assert.equal(await superviseApp(f.options), persisted ? 7 : 1);
		assert.equal(initialized, persisted);
		if (!persisted) {
			assert.equal(f.children.length, 0);
			assert.ok(!f.events.some((event) => ['apply', 'rollback'].includes(event[0])));
			assert.match(f.events[0][1], /\/app\/config persistent volume/);
		}
	});
}

test('private config failure stops before database or restore mutation and logs no sensitive cause', async () => {
	const f = fixture();
	f.options.initializeConfiguration = () => {
		throw Object.assign(new Error('synthetic-private-secret'), {
			code: 'INTEGRATION_CONFIGURATION_INIT_FAILED'
		});
	};
	assert.equal(await superviseApp(f.options), 1);
	assert.equal(f.children.length, 0);
	assert.ok(!f.events.some((event) => ['apply', 'rollback', 'spawn'].includes(event[0])));
	assert.match(f.events[0][1], /Private integration configuration initialization failed/);
	assert.doesNotMatch(JSON.stringify(f.events), /synthetic-private-secret/);
});

const names = (events) => events.map((event) => event[0]);

const activationRoots = ['db', 'uploads', 'voice'];
function createActivationDatabase(file, value) {
	const db = new Database(file);
	try {
		db.exec('CREATE TABLE supervisor_fixture(value TEXT NOT NULL)');
		db.prepare('INSERT INTO supervisor_fixture VALUES (?)').run(value);
	} finally {
		db.close();
	}
}
function activationDatabaseValue(cwd) {
	const db = new Database(path.join(cwd, 'db', 'pacs.db'), { readonly: true });
	try {
		return db.prepare('SELECT value FROM supervisor_fixture').pluck().get();
	} finally {
		db.close();
	}
}
async function activationTree(base, roots = activationRoots) {
	const entries = {};
	async function visit(relative) {
		const file = path.join(base, relative);
		const stat = await fs.lstat(file);
		if (stat.isDirectory()) {
			entries[relative] = 'directory';
			for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name));
		} else {
			assert.ok(stat.isFile());
			entries[relative] = (await fs.readFile(file)).toString('hex');
		}
	}
	for (const root of roots) await visit(root);
	return entries;
}
async function activationRootIdentities(cwd) {
	return Promise.all(
		activationRoots.map(async (root) => {
			const stat = await fs.stat(path.join(cwd, root), { bigint: true });
			return `${stat.dev}:${stat.ino}`;
		})
	);
}
async function offlineActivationFixture(t) {
	const cwd = path.join(process.cwd(), 'tests', `.start-app-activation-${randomUUID()}`);
	t.after(() => fs.rm(cwd, { recursive: true, force: true }));
	const restoreId = randomUUID();
	const staged = path.join(cwd, 'restore-staging', restoreId);
	for (const base of [cwd, staged]) {
		for (const root of activationRoots) await fs.mkdir(path.join(base, root), { recursive: true });
	}
	createActivationDatabase(path.join(cwd, 'db', 'pacs.db'), 'original');
	createActivationDatabase(path.join(staged, 'db', 'pacs.db'), 'installed');
	await fs.writeFile(path.join(cwd, 'uploads', 'original.txt'), 'original upload');
	await fs.writeFile(path.join(cwd, 'voice', 'original.ogg'), 'original voice');
	await fs.mkdir(path.join(cwd, 'uploads', 'original-empty'));
	await fs.writeFile(path.join(staged, 'uploads', 'installed.txt'), 'installed upload');
	await fs.writeFile(path.join(staged, 'voice', 'installed.ogg'), 'installed voice');
	await fs.mkdir(path.join(staged, 'uploads', 'installed-empty'));
	const original = await activationTree(cwd);
	const installed = await activationTree(staged);
	const identities = await activationRootIdentities(cwd);
	assert.deepEqual(activationFiles.activationStatus({ cwd }), { state: 'idle' });
	const queued = await activationFiles.queueActivationFiles({ cwd, restoreId });
	assert.equal(queued.state, 'queued');
	return { cwd, staged, original, installed, identities, queued };
}

test(
	'real IPC ESM child reaches readiness when supervisor actively reads piped stdin',
	{ timeout: 10_000 },
	async (t) => {
		const cwd = path.join(process.cwd(), 'tests', `.start-app-activation-${randomUUID()}`);
		t.after(() => fs.rm(cwd, { recursive: true, force: true }));
		await fs.mkdir(path.join(cwd, 'scripts'), { recursive: true });
		await fs.mkdir(path.join(cwd, 'build'));
		await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ type: 'module' }));
		for (const script of ['init-db.mjs', 'seed.mjs'])
			await fs.writeFile(path.join(cwd, 'scripts', script), '');
		await fs.writeFile(
			path.join(cwd, 'build', 'dependency.mjs'),
			`
		await new Promise((resolve) => {
			process.stdin.once('end', resolve);
			process.stdin.resume();
		});
		export const loaded = true;
	`
		);
		await fs.writeFile(
			path.join(cwd, 'build', 'index.js'),
			`
		import { loaded } from './dependency.mjs';
		process.on('message', (message) => {
			if (message.type === 'restore-activation-confirmed' && message.id === 'stdin-regression') process.exit(9);
		});
		process.send({ type: 'fixture-ready', loaded });
	`
		);
		const supervisorUrl = pathToFileURL(path.join(process.cwd(), 'scripts', 'start-app.mjs')).href;
		await fs.writeFile(
			path.join(cwd, 'wrapper.mjs'),
			`
		import { superviseApp } from ${JSON.stringify(supervisorUrl)};
		import { spawn } from 'node:child_process';
		process.stdin.on('data', () => process.emit('SIGTERM'));
		let ready = false;
		let finalized = false;
		let rolledBack = false;
		const result = await superviseApp({
			detectPersistence: async () => true,
			activationApi: {
				applyPendingActivation: async () => ({ id: 'stdin-regression' }),
				finalizeActivation: async () => { finalized = true; },
				rollbackActivation: async () => { rolledBack = true; }
			},
			spawnProcess(executable, args, options) {
				const child = spawn(executable, args, options);
				child.on('message', (message) => { if (message.type === 'fixture-ready' && message.loaded) ready = true; });
				return child;
			},
			checkHealth: async () => ready,
			readinessTimeoutMs: 3000, pollIntervalMs: 10, shutdownTimeoutMs: 500, killTimeoutMs: 500
		});
		console.log(JSON.stringify({ result, ready, finalized, rolledBack }));
		process.exit(result === 9 && ready && finalized && !rolledBack ? 0 : 1);
	`
		);
		const wrapper = spawn(process.execPath, ['wrapper.mjs'], {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: 8000,
			killSignal: 'SIGKILL'
		});
		let output = '';
		wrapper.stdout.on('data', (data) => {
			output += data;
		});
		wrapper.stderr.on('data', (data) => {
			output += data;
		});
		const closed = new Promise((resolve, reject) => {
			wrapper.once('error', reject);
			wrapper.once('close', (code, signal) => resolve({ code, signal }));
		});
		t.after(async () => {
			if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.stdin.end('stop');
			await closed;
		});
		const result = await closed;
		assert.equal(result.code, 0, output);
		assert.equal(result.signal, null, output);
		assert.deepEqual(JSON.parse(output.trim()), {
			result: 9,
			ready: true,
			finalized: true,
			rolledBack: false
		});
	}
);

test('real offline engine idle status allows ordinary startup without persistence or filesystem mutation', async (t) => {
	const cwd = path.join(process.cwd(), 'tests', `.start-app-activation-${randomUUID()}`);
	t.after(() => fs.rm(cwd, { recursive: true, force: true }));
	await fs.mkdir(cwd);
	assert.deepEqual(activationFiles.activationStatus({ cwd }), { state: 'idle' });
	const f = fixture({ activation: null });
	f.options.cwd = cwd;
	f.options.detectPersistence = async () => false;
	delete f.options.activationApi;
	assert.equal(await superviseApp(f.options), 7);
	assert.deepEqual(
		f.children.map(({ args }) => args[0]),
		['scripts/init-db.mjs', 'scripts/seed.mjs', 'build']
	);
	assert.ok(f.children.every(({ options }) => options.cwd === cwd));
	assert.equal(f.children[2].options.env.RESTORE_ACTIVATION_DATA_PERSISTED, '0');
	assert.equal(f.children[2].options.env.RESTORE_ACTIVATION_PENDING, '');
	assert.ok(!names(f.events).includes('send'));
	assert.deepEqual(await fs.readdir(cwd), []);
	assert.deepEqual(activationFiles.activationStatus({ cwd }), { state: 'idle' });
});

test('real offline engine pending activation without persistence fails before apply or launch and changes no files', async (t) => {
	const disk = await offlineActivationFixture(t);
	const before = await activationTree(disk.cwd, ['.']);
	const f = fixture();
	f.options.cwd = disk.cwd;
	f.options.detectPersistence = async () => false;
	delete f.options.activationApi;
	assert.equal(await superviseApp(f.options), 1);
	assert.equal(f.children.length, 0);
	assert.ok(!names(f.events).includes('send'));
	assert.deepEqual(activationFiles.activationStatus({ cwd: disk.cwd }), disk.queued);
	assert.deepEqual(await activationTree(disk.cwd, ['.']), before);
	assert.deepEqual(await activationRootIdentities(disk.cwd), disk.identities);
});

test('real offline engine installs before fake DB scripts and finalizes before confirming IPC, retaining originals', async (t) => {
	const disk = await offlineActivationFixture(t);
	const f = fixture();
	f.options.cwd = disk.cwd;
	delete f.options.activationApi;
	const originalSpawn = f.options.spawnProcess;
	f.options.spawnProcess = (...args) => {
		assert.equal(activationFiles.activationStatus({ cwd: disk.cwd }).state, 'installed');
		assert.equal(activationDatabaseValue(disk.cwd), 'installed');
		const child = originalSpawn(...args);
		if (args[1][0] === 'build') {
			const originalSend = child.send;
			child.send = (message, callback) => {
				assert.equal(activationFiles.activationStatus({ cwd: disk.cwd }).state, 'completed');
				assert.deepEqual(message, { type: 'restore-activation-confirmed', id: disk.queued.id });
				originalSend(message, callback);
				setImmediate(() => child.finish(7));
			};
		}
		return child;
	};
	f.options.checkHealth = async () => {
		assert.equal(activationFiles.activationStatus({ cwd: disk.cwd }).state, 'installed');
		assert.equal(activationDatabaseValue(disk.cwd), 'installed');
		return true;
	};
	assert.equal(await superviseApp(f.options), 7);
	assert.deepEqual(
		f.children.map(({ args }) => args[0]),
		['scripts/init-db.mjs', 'scripts/seed.mjs', 'build']
	);
	assert.equal(f.children[2].options.env.RESTORE_ACTIVATION_PENDING, disk.queued.id);
	assert.equal(f.children[2].options.env.RESTORE_ACTIVATION_DATA_PERSISTED, '1');
	assert.equal(f.events.filter(([name]) => name === 'send').length, 1);
	const status = activationFiles.activationStatus({ cwd: disk.cwd });
	assert.equal(status.id, disk.queued.id);
	assert.equal(status.state, 'completed');
	assert.deepEqual(await activationTree(disk.cwd), disk.installed);
	assert.deepEqual(
		await activationTree(path.join(disk.cwd, status.rollbackDirectory)),
		disk.original
	);
	assert.deepEqual(await activationRootIdentities(disk.cwd), disk.identities);
});

test('real offline engine rolls back an installed unconfirmed activation before scripts and sends no confirmation', async (t) => {
	const disk = await offlineActivationFixture(t);
	const pending = await activationFiles.applyPendingActivation({ cwd: disk.cwd });
	assert.equal(pending.id, disk.queued.id);
	assert.equal(pending.state, 'installed');
	assert.deepEqual(await activationTree(disk.cwd), disk.installed);
	const f = fixture();
	f.options.cwd = disk.cwd;
	delete f.options.activationApi;
	const originalSpawn = f.options.spawnProcess;
	f.options.spawnProcess = (...args) => {
		assert.equal(activationFiles.activationStatus({ cwd: disk.cwd }).state, 'rolled_back');
		assert.equal(activationDatabaseValue(disk.cwd), 'original');
		return originalSpawn(...args);
	};
	assert.equal(await superviseApp(f.options), 7);
	assert.equal(f.children.length, 3);
	assert.equal(f.children[2].options.env.RESTORE_ACTIVATION_PENDING, '');
	assert.equal(f.children[2].options.env.RESTORE_ACTIVATION_DATA_PERSISTED, '1');
	assert.ok(!names(f.events).includes('send'));
	const status = activationFiles.activationStatus({ cwd: disk.cwd });
	assert.equal(status.id, disk.queued.id);
	assert.equal(status.state, 'rolled_back');
	assert.equal(activationDatabaseValue(disk.cwd), 'original');
	assert.deepEqual(await activationTree(disk.cwd), disk.original);
	assert.deepEqual(
		await activationTree(path.join(disk.cwd, status.rollbackDirectory)),
		disk.original
	);
	assert.deepEqual(await activationRootIdentities(disk.cwd), disk.identities);
});

test('applies offline, initializes, seeds, checks readiness, finalizes, then confirms via IPC', async () => {
	const f = fixture();
	assert.equal(await superviseApp(f.options), 7);
	assert.deepEqual(
		f.events
			.filter(([name]) => !['exit'].includes(name))
			.map(([name, detail]) => (name === 'spawn' ? detail : name)),
		['apply', 'scripts/init-db.mjs', 'scripts/seed.mjs', 'build', 'health', 'finalize', 'send']
	);
	assert.deepEqual(f.events.find(([name]) => name === 'finalize')[1], {
		cwd: process.cwd(),
		id: 'restore-123'
	});
	assert.deepEqual(f.events.find(([name]) => name === 'send')[1], {
		type: 'restore-activation-confirmed',
		id: 'restore-123'
	});
	const server = f.children[2];
	assert.equal(server.command, process.execPath);
	assert.deepEqual(server.args, ['build', '--host', '0.0.0.0', '--port', '5173']);
	assert.deepEqual(server.options.stdio, ['ignore', 'inherit', 'inherit', 'ipc']);
	assert.equal(server.options.env.PORT, '5173');
	assert.equal(server.options.env.RESTORE_ACTIVATION_SUPERVISED, '1');
	assert.equal(server.options.env.RESTORE_ACTIVATION_DATA_PERSISTED, '1');
	assert.equal(server.options.env.RESTORE_ACTIVATION_PENDING, 'restore-123');
	assert.match(server.options.env.RESTORE_STARTUP_TOKEN, /^[a-f0-9]{64}$/);
	assert.equal(f.signals.listenerCount('SIGTERM'), 0);
	assert.equal(f.signals.listenerCount('SIGINT'), 0);
});

test('capability inspection completes before apply and passes cwd to the injected detector', async () => {
	const f = fixture();
	let finishDetection;
	f.options.detectPersistence = ({ cwd }) => {
		assert.equal(cwd, process.cwd());
		return new Promise((resolve) => {
			finishDetection = resolve;
		});
	};
	const running = superviseApp(f.options);
	await tick();
	assert.deepEqual(f.events, []);
	finishDetection(true);
	assert.equal(await running, 7);
});

for (const state of [
	'queued',
	'backing_up',
	'installing',
	'installed',
	'rolling_back',
	'error',
	'blocked'
]) {
	test(`pending ${state} activation without persistence fails before apply, migrations, or rollback`, async () => {
		const f = fixture();
		f.options.detectPersistence = async () => false;
		f.api.activationStatus = () => ({ id: 'restore-123', state });
		assert.equal(await superviseApp(f.options), 1);
		assert.equal(f.children.length, 0);
		assert.ok(!names(f.events).includes('apply'));
		assert.ok(!names(f.events).includes('rollback'));
	});
}

for (const status of [null, { state: 'idle' }, { state: 'completed' }, { state: 'rolled_back' }]) {
	test(`ordinary startup without persistence works for status ${status?.state || 'none'}`, async () => {
		const f = fixture({ activation: null });
		f.options.detectPersistence = async () => false;
		f.options.env.RESTORE_ACTIVATION_DATA_PERSISTED = '1';
		f.api.activationStatus = () => status;
		assert.equal(await superviseApp(f.options), 7);
		assert.equal(f.children[2].options.env.RESTORE_ACTIVATION_DATA_PERSISTED, '0');
		assert.equal(f.children[2].options.env.RESTORE_ACTIVATION_PENDING, '');
		assert.ok(
			!names(f.events).some((name) => ['apply', 'finalize', 'rollback', 'send'].includes(name))
		);
	});
}

test('a failed capability detector disables activation but permits ordinary startup', async () => {
	const f = fixture({ activation: null });
	f.options.detectPersistence = async () => {
		throw new Error('mountinfo unavailable');
	};
	assert.equal(await superviseApp(f.options), 7);
	assert.equal(f.children[2].options.env.RESTORE_ACTIVATION_DATA_PERSISTED, '0');
	assert.ok(!names(f.events).includes('apply'));
});

test('a failed capability detector cannot bypass a pending activation', async () => {
	const f = fixture();
	f.options.detectPersistence = async () => {
		throw new Error('mountinfo unavailable');
	};
	assert.equal(await superviseApp(f.options), 1);
	assert.equal(f.children.length, 0);
	assert.ok(!names(f.events).includes('apply'));
});

test('read-only pending inspection errors fail closed before apply', async () => {
	const f = fixture();
	f.options.detectPersistence = async () => false;
	f.api.activationStatus = () => {
		throw new Error('unreadable journal');
	};
	assert.equal(await superviseApp(f.options), 1);
	assert.equal(f.children.length, 0);
	assert.ok(!names(f.events).includes('apply'));
});

test('truthy non-boolean capability results cannot enable activation', async () => {
	const f = fixture({ activation: null });
	f.options.detectPersistence = async () => '1';
	assert.equal(await superviseApp(f.options), 7);
	assert.equal(f.children[2].options.env.RESTORE_ACTIVATION_DATA_PERSISTED, '0');
});

test('successful offline crash rollback returning null does not require health confirmation', async () => {
	const f = fixture();
	f.api.applyPendingActivation = async () => null;
	assert.equal(await superviseApp(f.options), 7);
	assert.equal(f.children[2].options.env.RESTORE_ACTIVATION_PENDING, '');
	assert.ok(!names(f.events).some((name) => ['finalize', 'rollback', 'send'].includes(name)));
});

test('never spawns scripts or app until offline apply finishes', async () => {
	const f = fixture();
	let finishApply;
	f.api.applyPendingActivation = () =>
		new Promise((resolve) => {
			finishApply = resolve;
		});
	const running = superviseApp(f.options);
	await tick();
	assert.equal(f.children.length, 0);
	finishApply({ id: 'restore-123' });
	assert.equal(await running, 7);
});

test('apply errors fail closed without touching DB scripts or attempting a guessed rollback', async () => {
	const f = fixture();
	f.api.applyPendingActivation = async () => {
		throw new Error('apply failure');
	};
	assert.equal(await superviseApp(f.options), 1);
	assert.equal(f.children.length, 0);
	assert.ok(!names(f.events).includes('rollback'));
});

for (const stageFailure of ['scripts/init-db.mjs', 'scripts/seed.mjs']) {
	test(`${stageFailure} failure rolls back only after the script exited; app never launches`, async () => {
		const f = fixture({ stageFailure });
		assert.equal(await superviseApp(f.options), 1);
		assert.ok(!f.children.some(({ args }) => args[0] === 'build'));
		assert.ok(names(f.events).lastIndexOf('exit') < names(f.events).indexOf('rollback'));
		assert.deepEqual(f.events.at(-1), ['rollback', { cwd: process.cwd(), id: 'restore-123' }]);
	});
}

test('no pending activation preserves configured port/env and does not finalize or confirm', async () => {
	const f = fixture({ activation: null });
	f.options.env = { PORT: '6210', KEEP_SETTING: 'yes' };
	f.options.checkHealth = async ({ port, token }) => {
		assert.equal(port, '6210');
		assert.equal(token, f.children[2].options.env.RESTORE_STARTUP_TOKEN);
		setImmediate(() => f.children[2].child.finish(0));
		return true;
	};
	assert.equal(await superviseApp(f.options), 1);
	assert.equal(f.children[2].options.env.RESTORE_ACTIVATION_PENDING, '');
	assert.equal(f.children[2].options.env.KEEP_SETTING, 'yes');
	assert.equal(f.children[2].args.at(-1), '6210');
	assert.ok(!names(f.events).some((name) => ['finalize', 'rollback', 'send'].includes(name)));
});

test('readiness tolerates listener/database boot latency before finalizing', async () => {
	const f = fixture();
	let attempts = 0;
	f.options.checkHealth = async () => {
		if (++attempts < 3) {
			assert.ok(!names(f.events).includes('finalize'));
			return false;
		}
		setImmediate(() => f.children[2].child.finish(8));
		return true;
	};
	assert.equal(await superviseApp(f.options), 8);
	assert.equal(attempts, 3);
});

test('readiness timeout stops child, escalates SIGKILL, then rolls back', async () => {
	const f = fixture({ ignoreTerm: true });
	f.options.readinessTimeoutMs = 10;
	f.options.checkHealth = () => new Promise(() => {});
	assert.equal(await superviseApp(f.options), 1);
	assert.deepEqual(
		f.events.filter(([name]) => name === 'kill').map((e) => e[2]),
		['SIGTERM', 'SIGKILL']
	);
	assert.ok(names(f.events).lastIndexOf('exit') < names(f.events).indexOf('rollback'));
	assert.ok(!names(f.events).includes('finalize'));
});

test('readiness probe failure stops child before rollback', async () => {
	const f = fixture();
	f.options.checkHealth = async () => {
		throw new Error('health failure');
	};
	assert.equal(await superviseApp(f.options), 1);
	assert.ok(names(f.events).lastIndexOf('exit') < names(f.events).indexOf('rollback'));
});

test('server exit during readiness cannot confirm activation, even if health returns success', async () => {
	const f = fixture();
	f.options.checkHealth = async () => {
		f.children[2].child.finish(0);
		return true;
	};
	assert.equal(await superviseApp(f.options), 1);
	assert.ok(names(f.events).includes('rollback'));
	assert.ok(!names(f.events).includes('finalize'));
	assert.ok(!names(f.events).includes('send'));
});

test('finalization failure stops child before rollback and never sends confirmation', async () => {
	const f = fixture();
	f.api.finalizeActivation = async () => {
		throw new Error('finalize failure');
	};
	assert.equal(await superviseApp(f.options), 1);
	assert.ok(names(f.events).lastIndexOf('exit') < names(f.events).indexOf('rollback'));
	assert.ok(!names(f.events).includes('send'));
});

test('failed spawn is handled without waiting for a nonexistent process', async () => {
	const f = fixture();
	f.options.spawnProcess = () => {
		const child = new EventEmitter();
		queueMicrotask(() => child.emit('error', new Error('spawn failed')));
		return child;
	};
	assert.equal(await superviseApp(f.options), 1);
	assert.ok(names(f.events).includes('rollback'));
});

for (const signal of ['SIGTERM', 'SIGINT']) {
	test(`${signal} forwards to live child and retains journal for next boot instead of rolling back`, async () => {
		const f = fixture({ ignoreTerm: true });
		f.options.checkHealth = async () => {
			f.signals.emit(signal);
			return false;
		};
		assert.equal(await superviseApp(f.options), signal === 'SIGTERM' ? 143 : 130);
		assert.deepEqual(
			f.events.filter(([name]) => name === 'kill').map((e) => e[2]),
			[signal, 'SIGKILL']
		);
		assert.ok(!names(f.events).includes('rollback'));
		assert.ok(!names(f.events).includes('send'));
	});
}

test('external shutdown while applying waits for offline operation and never starts app', async () => {
	const f = fixture();
	let finishApply;
	f.api.applyPendingActivation = () =>
		new Promise((resolve) => {
			finishApply = resolve;
		});
	const running = superviseApp(f.options);
	await tick();
	f.signals.emit('SIGTERM');
	finishApply({ id: 'restore-123' });
	assert.equal(await running, 143);
	assert.equal(f.children.length, 0);
	assert.ok(!names(f.events).includes('rollback'));
});

test('external shutdown during database initialization stops that process without opening the app', async () => {
	const f = fixture();
	const originalSpawn = f.options.spawnProcess;
	f.options.spawnProcess = (...args) => {
		const child = originalSpawn(...args);
		queueMicrotask(() => f.signals.emit('SIGTERM'));
		return child;
	};
	assert.equal(await superviseApp(f.options), 143);
	assert.equal(f.children.length, 1);
	assert.ok(f.children[0].child.stopped);
	assert.ok(!names(f.events).includes('rollback'));
});

test('durable live activation request stops child and exits nonzero without in-process restart', async () => {
	const f = fixture();
	f.options.checkHealth = async () => {
		setImmediate(() =>
			f.children[2].child.emit('message', {
				type: 'restore-activation-requested',
				id: 'next-restore'
			})
		);
		return true;
	};
	assert.equal(await superviseApp(f.options), 1);
	assert.equal(f.children.length, 3);
	assert.deepEqual(
		f.events.filter(([name]) => name === 'kill').map((e) => e[2]),
		['SIGTERM']
	);
	assert.ok(!names(f.events).includes('rollback'));
	assert.ok(f.children[2].child.stopped);
});

test('live activation request escalates to SIGKILL when graceful shutdown stalls', async () => {
	const f = fixture({ ignoreTerm: true });
	f.options.checkHealth = async () => {
		setImmediate(() =>
			f.children[2].child.emit('message', {
				type: 'restore-activation-requested',
				id: 'next-restore'
			})
		);
		return true;
	};
	assert.equal(await superviseApp(f.options), 1);
	assert.deepEqual(
		f.events.filter(([name]) => name === 'kill').map((e) => e[2]),
		['SIGTERM', 'SIGKILL']
	);
	assert.ok(!names(f.events).includes('rollback'));
	assert.equal(f.children.length, 3);
});

test('external shutdown interrupts stalled finalization and stops child without rollback', async () => {
	const f = fixture();
	f.options.checkHealth = async () => true;
	f.api.finalizeActivation = () => {
		setImmediate(() => f.signals.emit('SIGTERM'));
		return new Promise(() => {});
	};
	assert.equal(await superviseApp(f.options), 143);
	assert.ok(f.children[2].child.stopped);
	assert.ok(!names(f.events).includes('rollback'));
	assert.ok(!names(f.events).includes('send'));
});

test('server death during finalization never sends confirmation or rolls back a committed activation', async () => {
	const f = fixture();
	f.options.checkHealth = async () => true;
	f.api.finalizeActivation = async () => {
		f.children[2].child.finish(3);
	};
	assert.equal(await superviseApp(f.options), 1);
	assert.ok(!names(f.events).includes('send'));
	assert.ok(!names(f.events).includes('rollback'));
});

test('malformed IPC requests cannot stop the server', async () => {
	const f = fixture();
	f.options.checkHealth = async () => {
		f.children[2].child.emit('message', { type: 'restore-activation-requested' });
		f.children[2].child.emit('message', { type: 'restore-activation-requested', id: 1 });
		f.children[2].child.emit('message', { type: 'unrelated', id: 'x' });
		setImmediate(() => f.children[2].child.finish(9));
		return true;
	};
	assert.equal(await superviseApp(f.options), 9);
	assert.ok(!names(f.events).includes('kill'));
});

test('unconfirmed termination never rolls back against a possibly live process', async () => {
	const f = fixture({ ignoreTerm: true, ignoreKill: true });
	f.options.readinessTimeoutMs = 5;
	f.options.checkHealth = () => new Promise(() => {});
	assert.equal(await superviseApp(f.options), 1);
	assert.ok(!names(f.events).includes('rollback'));
	assert.ok(!f.children[2].child.stopped);
});

test('rollback errors fail closed without another child launch', async () => {
	const f = fixture({ stageFailure: 'scripts/init-db.mjs' });
	f.api.rollbackActivation = async () => {
		throw new Error('rollback failure');
	};
	assert.equal(await superviseApp(f.options), 1);
	assert.equal(f.children.length, 1);
});

test('health probe sends private token on the configured local endpoint and requires 204', async () => {
	let status = 503;
	const server = http.createServer((request, response) => {
		assert.equal(request.url, '/__restore-health');
		assert.equal(request.headers['x-restore-startup-token'], 'private-nonce');
		response.writeHead(status).end();
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const options = { port: server.address().port, token: 'private-nonce' };
		assert.equal(await probeRestoreHealth(options), false);
		status = 200;
		assert.equal(await probeRestoreHealth(options), false);
		status = 204;
		assert.equal(await probeRestoreHealth(options), true);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});
