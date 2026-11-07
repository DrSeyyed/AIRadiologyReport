import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { hashStorageFile, linkStorageFile } from '../src/lib/server/storage-shell.js';
import { abortStorageSession, assertStorageSession } from '../src/lib/server/storage-session.js';

const digest = 'abcdef0123456789'.repeat(4);
const secret = 'private-path username password host';
const safeError = { message: 'Storage shell operation failed.' };

function mockSession(open = (callback, channel) => callback(null, channel)) {
	const channel = new PassThrough();
	channel.stderr = new PassThrough();
	const calls = { commands: [], destroyed: 0 };
	let callback;
	const client = {
		client: {
			exec(command, cb) {
				calls.commands.push(command);
				callback = cb;
				open(cb, channel);
			},
			destroy() {
				calls.destroyed++;
			}
		}
	};
	return { client, channel, calls, callback: (...args) => callback(...args) };
}

function complete(channel, output = '', code = 0, signal) {
	if (output) channel.write(output);
	channel.emit('exit', code, signal);
	channel.emit('close');
}

async function rejectsSafely(promise) {
	await assert.rejects(promise, (error) => {
		assert.equal(error.message, safeError.message);
		assert.equal(error.cause, undefined);
		assert.doesNotMatch(error.stack, /private-path|username|password|host/);
		return true;
	});
}

test('hash uses only the existing exec session, quotes paths and returns lowercase SHA256', async () => {
	const mock = mockSession();
	const path = "/archive/O'Brien $(touch nope); `nope` file";
	const progress = [];
	let activeChecks = 0;
	const result = hashStorageFile(
		mock.client,
		path,
		{},
		{
			assertActive: () => activeChecks++,
			onProgress: (bytes) => progress.push(bytes)
		}
	);
	assert.deepEqual(mock.calls.commands, [
		"sha256sum -- '/archive/O'\\''Brien $(touch nope); `nope` file'"
	]);
	const output = `${digest.toUpperCase()}  ${path}\n`;
	mock.channel.write(output.slice(0, 19));
	mock.channel.write(output.slice(19));
	mock.channel.emit('exit', 0);
	mock.channel.emit('close');
	assert.equal(await result, digest);
	assert.equal(
		progress.reduce((sum, count) => sum + count, 0),
		Buffer.byteLength(output)
	);
	assert.ok(activeChecks >= 5);
	assert.equal(mock.calls.destroyed, 0);
});

test('link quotes both paths and has no force, overwrite or interactive flags', async () => {
	const mock = mockSession();
	const result = linkStorageFile(mock.client, "/archive/source's", "/archive/target's");
	assert.deepEqual(mock.calls.commands, ["ln -- '/archive/source'\\''s' '/archive/target'\\''s'"]);
	complete(mock.channel);
	assert.equal(await result, undefined);
	assert.equal(mock.calls.destroyed, 0);
});

test('buffered stdout is not consumed before data handlers are ready', async () => {
	const mock = mockSession((callback, channel) => {
		channel.write(`${digest}  /file\n`);
		channel.stderr.write('warning');
		callback(null, channel);
	});
	const progress = [];
	const result = hashStorageFile(mock.client, '/file', {}, { onProgress: (n) => progress.push(n) });
	await nextTurn();
	mock.channel.emit('exit', 0);
	mock.channel.emit('close');
	assert.equal(await result, digest);
	assert.equal(
		progress.reduce((sum, n) => sum + n, 0),
		72 + 7
	);
});

test('invalid or traversing paths reject before executing, with no path leakage', async () => {
	for (const path of [
		undefined,
		'',
		'relative',
		'/',
		'//file',
		'/dir//file',
		'/dir/',
		'/dir/../file',
		'/dir/./file',
		'/dir/secret\0',
		'/dir/secret\n',
		'/dir/secret\r',
		'/dir/secret\\file',
		'/dir/secret\u007f',
		'/dir/secret\u2028',
		'/' + 'a'.repeat(4096)
	]) {
		const mock = mockSession();
		await rejectsSafely(hashStorageFile(mock.client, path));
		await rejectsSafely(linkStorageFile(mock.client, path, '/target'));
		await rejectsSafely(linkStorageFile(mock.client, '/source', path));
		assert.deepEqual(mock.calls.commands, []);
	}
});

test('invalid settings and unavailable exec are sanitized before dispatch', async () => {
	for (const value of [0, -1, 601, 1.5, null, '20']) {
		const mock = mockSession();
		await rejectsSafely(
			hashStorageFile(mock.client, '/file', { verificationTimeoutSeconds: value })
		);
		assert.deepEqual(mock.calls.commands, []);
	}
	await rejectsSafely(hashStorageFile({}, '/file'));
});

for (const [name, fail] of [
	['nonzero exit / existing destination', (channel) => complete(channel, '', 1)],
	['signal', (channel) => complete(channel, '', null, 'TERM')],
	['signal with zero code', (channel) => complete(channel, '', 0, 'TERM')],
	['missing status', (channel) => channel.emit('close')],
	['null status', (channel) => channel.emit('close', null)],
	['nonzero close', (channel) => channel.emit('close', 1)],
	['signalled close', (channel) => channel.emit('close', 0, 'TERM')],
	['channel error', (channel) => channel.emit('error', new Error(secret))],
	['stderr error', (channel) => channel.stderr.emit('error', new Error(secret))]
]) {
	test(`${name} fails safely and handles subsequent channel errors`, async () => {
		const mock = mockSession();
		const result = linkStorageFile(mock.client, '/source', '/target');
		mock.channel.stderr.write(secret);
		fail(mock.channel);
		await rejectsSafely(result);
		assert.equal(mock.calls.destroyed, 1);
		assert.throws(() => assertStorageSession(mock.client), /stopped/);
		mock.channel.emit('error', new Error(secret));
		mock.channel.stderr.emit('error', new Error(secret));
	});
}

test('zero close status is accepted without a separate exit event', async () => {
	const mock = mockSession();
	const result = linkStorageFile(mock.client, '/source', '/target');
	mock.channel.emit('close', 0);
	await result;
});

test('bad hash output, unexpected filenames and link output reject', async () => {
	for (const output of [
		'',
		`${digest}\n`,
		`${digest}  /other\n`,
		`${digest}  /file\nextra`,
		secret
	]) {
		const mock = mockSession();
		const result = hashStorageFile(mock.client, '/file');
		complete(mock.channel, output);
		await rejectsSafely(result);
	}
	const mock = mockSession();
	const result = linkStorageFile(mock.client, '/source', '/target');
	complete(mock.channel, secret);
	await rejectsSafely(result);
});

for (const stderr of [false, true]) {
	test(`${stderr ? 'stderr' : 'stdout'} is bounded independently`, async () => {
		const mock = mockSession();
		const result = hashStorageFile(mock.client, '/file');
		const stream = stderr ? mock.channel.stderr : mock.channel;
		stream.emit('data', Buffer.alloc(16 * 1024));
		stream.emit('data', Buffer.from('x'));
		await rejectsSafely(result);
		assert.equal(mock.calls.destroyed, 1);
	});
}

for (const phase of ['open', 'output', 'close']) {
	test(`total deadline covers ${phase} acknowledgement and aborts the session`, async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const mock = mockSession(phase === 'open' ? () => {} : undefined);
		let settled = false;
		const rejected = rejectsSafely(
			hashStorageFile(mock.client, '/file', { verificationTimeoutSeconds: 1 })
		).then(() => {
			settled = true;
		});
		if (phase === 'close') {
			mock.channel.write(`${digest}  /file\n`);
			mock.channel.emit('exit', 0);
		} else if (phase === 'output') {
			mock.channel.write(digest.slice(0, 10));
		}
		t.mock.timers.tick(999);
		await nextTurn();
		assert.equal(settled, false);
		t.mock.timers.tick(1);
		await rejected;
		assert.equal(mock.calls.destroyed, 1);
		if (phase === 'open') mock.callback(null, mock.channel);
		assert.equal(mock.channel.destroyed, true);
		mock.channel.emit('error', new Error(secret));
		mock.channel.stderr.emit('error', new Error(secret));
		mock.callback(new Error(secret));
	});
}

test('default deadline is 20 seconds and late error callbacks are drained', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const mock = mockSession(() => {});
	const rejected = rejectsSafely(hashStorageFile(mock.client, '/file'));
	t.mock.timers.tick(20_000);
	await rejected;
	mock.callback(new Error(secret), mock.channel);
	assert.equal(mock.channel.destroyed, true);
	mock.channel.emit('error', new Error(secret));
	mock.channel.stderr.emit('error', new Error(secret));
	assert.equal(mock.calls.destroyed, 1);
});

test('synchronous errors during force abort cannot escape cleanup', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const mock = mockSession();
	mock.client.client.destroy = () => {
		mock.calls.destroyed++;
		mock.channel.emit('error', new Error(secret));
		mock.channel.stderr.emit('error', new Error(secret));
		mock.channel.emit('close');
		throw new Error(secret);
	};
	const rejected = rejectsSafely(linkStorageFile(mock.client, '/source', '/target'));
	t.mock.timers.tick(20_000);
	await rejected;
	assert.equal(mock.calls.destroyed, 1);
});

test('continuous output does not extend the total deadline', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const mock = mockSession();
	const rejected = rejectsSafely(
		hashStorageFile(mock.client, '/file', { verificationTimeoutSeconds: 1 })
	);
	for (let i = 0; i < 5; i++) {
		mock.channel.stderr.write('activity');
		t.mock.timers.tick(200);
	}
	await rejected;
	assert.equal(mock.calls.destroyed, 1);
});

test('successful commands clear their deadline and retain session usability', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const mock = mockSession();
	const result = hashStorageFile(mock.client, '/file');
	complete(mock.channel, `${digest}  /file\n`);
	assert.equal(await result, digest);
	t.mock.timers.tick(60_000);
	assert.equal(mock.calls.destroyed, 0);
	assertStorageSession(mock.client);
	mock.channel.emit('error', new Error(secret));
	mock.channel.stderr.emit('error', new Error(secret));
});

test('exec callback errors and synchronous exec failures are sanitized and drained', async () => {
	for (const open of [
		(callback, channel) => callback(new Error(secret), channel),
		() => {
			throw new Error(secret);
		},
		(callback) => callback(null, undefined)
	]) {
		const mock = mockSession(open);
		await rejectsSafely(hashStorageFile(mock.client, '/file'));
		assert.equal(mock.calls.destroyed, 1);
	}
});

test('already cancelled ownership and stopped sessions never dispatch', async () => {
	const mock = mockSession();
	await rejectsSafely(
		linkStorageFile(
			mock.client,
			'/source',
			'/target',
			{},
			{
				assertActive() {
					throw new Error(secret);
				}
			}
		)
	);
	abortStorageSession(mock.client);
	await rejectsSafely(hashStorageFile(mock.client, '/file'));
	assert.deepEqual(mock.calls.commands, []);
});

for (const phase of ['open', 'data', 'close']) {
	test(`ownership cancellation at ${phase} aborts, sanitizes and drains`, async () => {
		let active = true;
		const mock = mockSession(phase === 'open' ? () => {} : undefined);
		const result = hashStorageFile(
			mock.client,
			'/file',
			{},
			{
				assertActive() {
					if (!active) throw new Error(secret);
				}
			}
		);
		active = false;
		if (phase === 'open') mock.callback(null, mock.channel);
		if (phase === 'data') mock.channel.write(`${digest}  /file\n`);
		if (phase === 'close') mock.channel.emit('close', 0);
		await rejectsSafely(result);
		assert.equal(mock.calls.destroyed, 1);
		assert.equal(mock.channel.destroyed, true);
		mock.channel.emit('error', new Error(secret));
		mock.channel.stderr.emit('error', new Error(secret));
	});
}

test('progress callback failure and cancellation during progress cannot report success', async () => {
	for (const fail of [false, true]) {
		const mock = mockSession();
		let active = true;
		const result = hashStorageFile(
			mock.client,
			'/file',
			{},
			{
				assertActive() {
					if (!active) throw new Error(secret);
				},
				onProgress() {
					if (fail) throw new Error(secret);
					active = false;
				}
			}
		);
		complete(mock.channel, `${digest}  /file\n`);
		await rejectsSafely(result);
		assert.equal(mock.calls.destroyed, 1);
	}
});

// A minimal channel catches accidental dependencies on downloading SFTP files.
test('exec-only emitter channels are supported', async () => {
	const channel = new EventEmitter();
	channel.stderr = new EventEmitter();
	const client = { client: { exec: (_command, callback) => callback(null, channel) } };
	const result = hashStorageFile(client, '/file');
	channel.emit('data', Buffer.from(`${digest}  /file\n`));
	channel.emit('exit', 0);
	channel.emit('close');
	assert.equal(await result, digest);
});
