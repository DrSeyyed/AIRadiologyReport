import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
	withStorage,
	probeStorageHost,
	storagePath,
	hashRemote
} from '../src/lib/server/storage-transport.js';

const hostKey = Buffer.from('synthetic SSH server public key');
const fingerprint = `SHA256:${createHash('sha256').update(hostKey).digest('base64').replace(/=$/, '')}`;
const config = {
	host: 'storage.invalid',
	port: 2222,
	username: 'synthetic-user',
	password: 'synthetic-password',
	fingerprint,
	root: '/backups/reports'
};
const rawError = new Error(`connect ${config.host} ${config.username} ${config.password}`);

function mockClient(overrides = {}) {
	const calls = { connect: [], end: 0, lstat: [], reads: [] };
	const client = {
		async connect(options) {
			calls.connect.push(options);
			if (!options.hostVerifier(hostKey)) throw rawError;
		},
		async end() {
			calls.end += 1;
		},
		async lstat(remotePath) {
			calls.lstat.push(remotePath);
			return { isDirectory: true, isSymbolicLink: false };
		},
		createReadStream(remotePath) {
			calls.reads.push(remotePath);
			return Readable.from([Buffer.from('file contents')]);
		},
		...overrides
	};
	return { client, calls, factory: () => client };
}

async function rejectsSafely(operation) {
	await assert.rejects(operation, (error) => {
		assert.equal(error.message, 'Storage operation failed.');
		assert.equal(error.cause, undefined);
		assert.doesNotMatch(error.stack, /synthetic-password|synthetic-user|storage\.invalid/);
		return true;
	});
}

function remoteFile(mock, file = '/backups/reports/object') {
	const original = mock.client.lstat;
	mock.client.lstat = async (remotePath) => {
		if (remotePath === file) {
			mock.calls.lstat.push(remotePath);
			return { isFile: true };
		}
		return original(remotePath);
	};
	return file;
}

test('withStorage pins the raw key, uses password auth only, returns the callback result and ends', async () => {
	const mock = mockClient();
	const result = await withStorage(
		config,
		(client) => {
			assert.equal(client, mock.client);
			return { ok: true };
		},
		async () => mock.client
	);
	assert.deepEqual(result, { ok: true });
	const [options] = mock.calls.connect;
	assert.equal(options.host, config.host);
	assert.equal(options.port, config.port);
	assert.equal(options.username, config.username);
	assert.equal(options.password, config.password);
	assert.equal(options.readyTimeout, 20_000);
	assert.equal(options.tryKeyboard, false);
	assert.equal(options.retries, 0);
	assert.deepEqual(options.authHandler, ['password']);
	for (const field of ['privateKey', 'agent', 'hostHash', 'debug']) {
		assert.equal(options[field], undefined);
	}
	assert.deepEqual(mock.calls.lstat, ['/', '/backups', '/backups/reports']);
	assert.equal(mock.calls.end, 1);
});

test('canonical padded pins and the default SSH port are supported', async () => {
	const mock = mockClient();
	await withStorage(
		{ ...config, fingerprint: `${fingerprint}=`, port: undefined },
		() => {},
		mock.factory
	);
	assert.equal(mock.calls.connect[0].port, 22);
});

test('missing, malformed and noncanonical pins are rejected before connecting', async () => {
	for (const pin of [
		undefined,
		'',
		'MD5:ab',
		'SHA256:bad',
		`${fingerprint}\n`,
		'SHA256:' + 'A'.repeat(42) + 'B'
	]) {
		let created = false;
		await rejectsSafely(
			withStorage(
				{ ...config, fingerprint: pin },
				() => {},
				() => {
					created = true;
					return mockClient().client;
				}
			)
		);
		assert.equal(created, false);
	}
});

test('mismatched host key never reaches callback, even when connect ignores verifier rejection', async () => {
	for (const ignoresFailure of [false, true]) {
		const mock = mockClient({
			async connect(options) {
				assert.equal(options.hostVerifier(Buffer.from('different key')), false);
				if (!ignoresFailure) throw rawError;
			}
		});
		let invoked = false;
		await rejectsSafely(
			withStorage(
				config,
				() => {
					invoked = true;
				},
				mock.factory
			)
		);
		assert.equal(invoked, false);
		assert.equal(mock.calls.end, 1);
	}
});

test('connect failure and callback failure are sanitized and always end the connection', async () => {
	const connection = mockClient({
		connect: async () => {
			throw rawError;
		}
	});
	await rejectsSafely(withStorage(config, () => {}, connection.factory));
	assert.equal(connection.calls.end, 1);
	const callback = mockClient();
	await rejectsSafely(
		withStorage(
			config,
			() => {
				throw rawError;
			},
			callback.factory
		)
	);
	assert.equal(callback.calls.end, 1);
	await rejectsSafely(
		withStorage(
			config,
			() => {},
			() => {
				throw rawError;
			}
		)
	);
});

test('end errors cannot leak details or replace callback success', async () => {
	let ended = 0;
	const mock = mockClient({
		end: async () => {
			ended += 1;
			throw rawError;
		}
	});
	assert.equal(await withStorage(config, () => 42, mock.factory), 42);
	assert.equal(ended, 1);
});

test('invalid connection settings fail without constructing a client', async () => {
	for (const invalid of [
		{ host: '' },
		{ host: 'sftp://host' },
		{ host: 'host\n' },
		{ port: 0 },
		{ port: 65536 },
		{ port: '22' },
		{ username: '' },
		{ username: 'user\n' },
		{ password: '' },
		{ root: 'relative' }
	]) {
		await rejectsSafely(
			withStorage(
				{ ...config, ...invalid },
				() => {},
				() => {
					assert.fail('must not create a client');
				}
			)
		);
	}
});

test('root and ancestor symlinks and non-directory roots are rejected before callback', async () => {
	for (const target of ['/', '/backups', config.root]) {
		for (const attributes of [{ isSymbolicLink: true }, { type: 'l' }, { isFile: true }]) {
			const mock = mockClient({
				lstat: async (remotePath) => (remotePath === target ? attributes : { isDirectory: true })
			});
			await rejectsSafely(withStorage(config, () => assert.fail('unsafe root'), mock.factory));
			assert.equal(mock.calls.end, 1);
		}
	}
});

test('probe captures an untrusted fingerprint, refuses the host key and sends no password', async () => {
	const mock = mockClient({
		async connect(options) {
			assert.equal(options.hostVerifier(hostKey), false);
			assert.equal(options.password, undefined);
			assert.equal(options.privateKey, undefined);
			assert.equal(options.agent, undefined);
			assert.equal(options.authHandler([], false), false);
			assert.notEqual(options.username, config.username);
			throw rawError;
		}
	});
	assert.equal(await probeStorageHost(config, mock.factory), fingerprint);
	assert.equal(mock.calls.end, 1);
	assert.deepEqual(mock.calls.lstat, []);
});

test('probe works without root, credentials or a pin and does not accept malformed key data', async () => {
	const mock = mockClient();
	assert.equal(await probeStorageHost({ host: config.host }, mock.factory), fingerprint);
	assert.equal(mock.calls.end, 1);
	const malformed = mockClient({
		connect: async (options) => {
			assert.equal(options.hostVerifier('not raw key bytes'), false);
			throw rawError;
		}
	});
	await rejectsSafely(probeStorageHost(config, malformed.factory));
	assert.equal(malformed.calls.end, 1);
});

test('probe failure before receiving a host key is sanitized and cleaned up', async () => {
	const mock = mockClient({
		connect: async () => {
			throw rawError;
		}
	});
	await rejectsSafely(probeStorageHost(config, mock.factory));
	assert.equal(mock.calls.end, 1);
});

test('storagePath normalizes absolute POSIX roots and preserves safe opaque names', () => {
	assert.equal(
		storagePath({ root: '//backups///reports/' }, 'object', 'file.enc'),
		'/backups/reports/object/file.enc'
	);
	assert.equal(storagePath({ root: '/' }, 'abc'), '/abc');
	assert.equal(storagePath(config), config.root);
	assert.equal(storagePath(config.root, 'object'), `${config.root}/object`);
	assert.throws(() => storagePath('/a/../b', 'object'), /Storage root/);
	assert.equal(storagePath(config, 'گزارش.enc'), `${config.root}/گزارش.enc`);
});

test('storagePath rejects traversal, separators, control characters and non-string components', () => {
	for (const root of [
		undefined,
		'',
		'relative',
		'C:\\backups',
		'/a/../b',
		'/a/./b',
		'/a\\b',
		'/a\n',
		'/a\0',
		'/a\x7f',
		'/a\u0085',
		'/a\u2028'
	]) {
		assert.throws(() => storagePath({ root }, 'file'), /Storage root/);
	}
	for (const segment of [
		'',
		'.',
		'..',
		'../file',
		'file/sub',
		'file\\sub',
		'/file',
		'a\0b',
		'a\nb',
		'a\rb',
		'a\tb',
		'a\u0085b',
		'a\u2029b',
		3,
		null
	]) {
		assert.throws(() => storagePath(config, segment), /Storage path segment/);
	}
});

test('hashRemote streams bytes and returns exactly lowercase SHA256 hex without shell execution', async () => {
	const chunk = Buffer.alloc(64 * 1024, 0xa7);
	const expected = createHash('sha256');
	for (let i = 0; i < 128; i += 1) expected.update(chunk);
	let stream;
	const mock = mockClient({
		createReadStream(remotePath) {
			assert.equal(remotePath, '/backups/reports/object');
			stream = Readable.from(
				(function* () {
					for (let i = 0; i < 128; i += 1) yield chunk;
				})()
			);
			return stream;
		},
		exec() {
			assert.fail('must not execute shell commands');
		}
	});
	const progress = [];
	const digest = await hashRemote(mock.client, remoteFile(mock), {
		onProgress: (bytes) => progress.push(bytes)
	});
	assert.deepEqual(progress, Array(128).fill(chunk.length));
	assert.equal(digest, expected.digest('hex'));
	assert.match(digest, /^[a-f0-9]{64}$/);
	assert.equal(stream.destroyed, true);
	assert.equal(mock.calls.end, 0);
});

test('hashRemote handles empty files and sanitizes stream/stat errors', async () => {
	const empty = mockClient({ createReadStream: () => Readable.from([]) });
	assert.equal(
		await hashRemote(empty.client, remoteFile(empty)),
		createHash('sha256').digest('hex')
	);
	const failed = mockClient({
		createReadStream: () =>
			Readable.from(
				(async function* () {
					yield Buffer.from('partial');
					throw rawError;
				})()
			)
	});
	await rejectsSafely(hashRemote(failed.client, remoteFile(failed)));
	const stat = mockClient({
		lstat: async () => {
			throw rawError;
		}
	});
	await rejectsSafely(hashRemote(stat.client, '/object'));
});

test('hashRemote destroys its stream and sanitizes a rejected progress callback', async () => {
	const stream = Readable.from([Buffer.from('synthetic bytes')]);
	const mock = mockClient({ createReadStream: () => stream });
	await rejectsSafely(
		hashRemote(mock.client, remoteFile(mock), {
			onProgress() {
				throw rawError;
			}
		})
	);
	assert.equal(stream.destroyed, true);
});

test('hashRemote rejects symlink files, ancestor links and traversal before reading', async () => {
	for (const target of ['/backups', '/backups/reports/object']) {
		const mock = mockClient({
			lstat: async (remotePath) => {
				if (remotePath === target) return { isSymbolicLink: () => true };
				return { isDirectory: () => true };
			}
		});
		await rejectsSafely(hashRemote(mock.client, '/backups/reports/object'));
		assert.deepEqual(mock.calls.reads, []);
	}
	const mock = mockClient();
	await rejectsSafely(hashRemote(mock.client, '/backups/../object'));
	assert.deepEqual(mock.calls.lstat, []);
});

test('handshake and callback timeouts are bounded and end the connection', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	for (const phase of ['connect', 'callback']) {
		let disconnected = 0;
		const mock = mockClient({
			...(phase === 'connect' ? { connect: () => new Promise(() => {}) } : {}),
			client: {
				destroy() {
					disconnected++;
				}
			}
		});
		const pending = rejectsSafely(
			withStorage(
				{ ...config, operationTimeoutMs: 30_000 },
				() => new Promise(() => {}),
				mock.factory
			)
		);
		await nextTurn();
		t.mock.timers.tick(phase === 'connect' ? 20_000 : 30_000);
		await pending;
		assert.equal(disconnected, 1);
		assert.equal(mock.calls.end, 1);
	}
});

test('callback defaults to one hour rather than the handshake timeout', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const mock = mockClient();
	let settled = false;
	const pending = rejectsSafely(withStorage(config, () => new Promise(() => {}), mock.factory));
	pending.then(() => {
		settled = true;
	});
	await nextTurn();
	t.mock.timers.tick(3_599_999);
	await nextTurn();
	assert.equal(settled, false);
	assert.equal(mock.calls.end, 0);
	t.mock.timers.tick(1);
	await pending;
	assert.equal(mock.calls.end, 1);
});

test('operation timeout accepts integer milliseconds from 1 through six hours only', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	for (const operationTimeoutMs of [1, 3_600_000, 21_600_000]) {
		const mock = mockClient();
		assert.equal(await withStorage({ ...config, operationTimeoutMs }, () => 42, mock.factory), 42);
		assert.equal(mock.calls.end, 1);
	}
	for (const operationTimeoutMs of [0, -1, 21_600_001, 1.5, NaN, Infinity, '3600000', null]) {
		await rejectsSafely(
			withStorage(
				{ ...config, operationTimeoutMs },
				() => {},
				() => {
					assert.fail('invalid timeout must fail before connecting');
				}
			)
		);
	}
});

test('a timed-out root check cannot invoke the callback after it eventually resolves', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let resolve;
	const mock = mockClient({
		lstat: () =>
			new Promise((done) => {
				resolve = done;
			})
	});
	let called = false;
	const pending = rejectsSafely(
		withStorage(
			{ ...config, operationTimeoutMs: 20_000 },
			() => {
				called = true;
			},
			mock.factory
		)
	);
	await nextTurn();
	t.mock.timers.tick(20_000);
	await pending;
	resolve({ isDirectory: true });
	await nextTurn();
	assert.equal(called, false);
	assert.equal(mock.calls.end, 1);
});

test('hashRemote permits transfers longer than 20 seconds while reads keep progressing', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const mock = mockClient({
		createReadStream: () =>
			Readable.from(
				(async function* () {
					for (let index = 0; index < 3; index += 1) {
						await new Promise((resolve) => setTimeout(resolve, 10_000));
						yield Buffer.from('chunk');
					}
				})()
			)
	});
	const pending = hashRemote(mock.client, remoteFile(mock));
	await nextTurn();
	for (let index = 0; index < 3; index += 1) {
		t.mock.timers.tick(10_000);
		await nextTurn();
	}
	assert.equal(await pending, createHash('sha256').update('chunkchunkchunk').digest('hex'));
});

for (const seconds of [undefined, 2, 45]) {
	test(`hashRemote bounds stalled reads at ${seconds ?? 20} seconds and destroys its stream`, async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const stream = new Readable({ read() {} });
		const mock = mockClient({ createReadStream: () => stream });
		let settled = false;
		const pending = rejectsSafely(
			hashRemote(mock.client, remoteFile(mock), { verificationTimeoutSeconds: seconds })
		).then(() => {
			settled = true;
		});
		await nextTurn();
		t.mock.timers.tick((seconds ?? 20) * 1000 - 1);
		await nextTurn();
		assert.equal(settled, false);
		t.mock.timers.tick(1);
		await pending;
		assert.equal(stream.destroyed, true);
	});
}

test('configured read timeout permits chunks more than the old 20 seconds apart', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const stream = new Readable({ read() {} });
	const mock = mockClient({ createReadStream: () => stream });
	const pending = hashRemote(mock.client, remoteFile(mock), { verificationTimeoutSeconds: 45 });
	await nextTurn();
	t.mock.timers.tick(25_000);
	stream.push(Buffer.from('chunk'));
	await nextTurn();
	t.mock.timers.tick(25_000);
	stream.push(null);
	assert.equal(await pending, createHash('sha256').update('chunk').digest('hex'));
});

test('verification timeout force-closes SSH even when a stream destroy waits for remote CLOSE', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let closeStream;
	let disconnected = 0;
	const stream = new Readable({
		read() {
			this.push(Buffer.from('data'));
			this.push(null);
		},
		destroy(error, callback) {
			closeStream = () => callback(error);
		}
	});
	const mock = mockClient({
		createReadStream: () => stream,
		client: {
			destroy() {
				disconnected++;
				closeStream?.();
			}
		}
	});
	const rejected = rejectsSafely(
		hashRemote(mock.client, remoteFile(mock), { verificationTimeoutSeconds: 30 })
	);
	await nextTurn();
	t.mock.timers.tick(30_000);
	await rejected;
	assert.equal(disconnected, 1);
	assert.equal(stream.closed, true);
});

test('a stuck graceful SSH shutdown is followed by socket destruction', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let disconnected = 0;
	const mock = mockClient({
		client: {
			destroy() {
				disconnected++;
			}
		},
		end: () => new Promise(() => {})
	});
	const pending = withStorage(config, () => 42, mock.factory);
	await nextTurn();
	t.mock.timers.tick(20_000);
	assert.equal(await pending, 42);
	assert.equal(disconnected, 1);
});

test('probe and cleanup are time bounded even when their promises stall', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let ended = 0;
	const mock = mockClient({
		connect: () => new Promise(() => {}),
		end: () => {
			ended += 1;
			return new Promise(() => {});
		}
	});
	const pending = rejectsSafely(probeStorageHost(config, mock.factory));
	await nextTurn();
	t.mock.timers.tick(20_000);
	await nextTurn();
	assert.equal(ended, 1);
	t.mock.timers.tick(20_000);
	await pending;
});
