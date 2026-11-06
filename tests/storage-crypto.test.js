import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createDecipheriv, hkdfSync } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, writeFile, stat, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
	assertStorageKey,
	encryptSecret,
	decryptSecret,
	encryptFile,
	decryptFile
} from '../src/lib/server/storage-crypto.js';

const masterKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const encodedKey = masterKey.toString('base64');
const privateText = 'synthetic-private-password گزارش محرمانه\nUnicode: 🔒';
const filePrefix = Buffer.from('ARRSTG\x01', 'binary');
const headerLength = filePrefix.length + 12;

function keyFixture(t) {
	const oldKey = process.env.STORAGE_ENCRYPTION_KEY;
	process.env.STORAGE_ENCRYPTION_KEY = encodedKey;
	t.after(() => {
		if (oldKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
		else process.env.STORAGE_ENCRYPTION_KEY = oldKey;
	});
}

async function fileFixture(t) {
	keyFixture(t);
	// Test fixtures stay inside this checkout rather than the OS temporary directory.
	const directory = await mkdtemp(path.join(process.cwd(), '.storage-crypto-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return (name) => path.join(directory, name);
}

function safeError(error, message) {
	assert.equal(error.message, message);
	assert.equal(error.cause, undefined);
	assert.equal(error.message.includes(privateText), false);
	assert.equal(error.message.includes(encodedKey), false);
	return true;
}

async function absent(file) {
	await assert.rejects(stat(file), { code: 'ENOENT' });
}

async function checksum(file) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest('hex');
}

test('assertStorageKey validates but never returns key material', (t) => {
	keyFixture(t);
	assert.equal(assertStorageKey(), undefined);
	assert.equal(process.env.STORAGE_ENCRYPTION_KEY, encodedKey);
});

test('missing, malformed, wrong-length and noncanonical keys fail closed', (t) => {
	keyFixture(t);
	const invalid = [
		undefined,
		'',
		'not-a-key',
		encodedKey.trimEnd() + '\n',
		' ' + encodedKey,
		encodedKey.replace(/=$/, ''),
		Buffer.alloc(31).toString('base64'),
		Buffer.alloc(33).toString('base64'),
		'A'.repeat(42) + 'B=',
		'-'.repeat(43) + '=',
		'🔒'.repeat(22)
	];
	for (const key of invalid) {
		if (key === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
		else process.env.STORAGE_ENCRYPTION_KEY = key;
		assert.throws(assertStorageKey, (error) =>
			safeError(error, 'Storage encryption key is invalid.')
		);
		assert.throws(
			() => encryptSecret(privateText),
			(error) => safeError(error, 'Storage secret encryption failed.')
		);
	}
});

test('secrets roundtrip empty, ASCII and Unicode strings with fresh authenticated IVs', (t) => {
	keyFixture(t);
	for (const plaintext of ['', 'password', privateText, 'a'.repeat(256 * 1024)]) {
		const first = encryptSecret(plaintext);
		const second = encryptSecret(plaintext);
		assert.match(first, /^v1:[A-Za-z0-9+/]+=*$/);
		assert.notEqual(first, second);
		assert.equal(decryptSecret(first), plaintext);
		assert.equal(decryptSecret(second), plaintext);
	}
});

test('secret frames use AES-256-GCM and their own HKDF context', (t) => {
	keyFixture(t);
	const frame = Buffer.from(encryptSecret(privateText).slice(3), 'base64');
	const key = Buffer.from(
		hkdfSync(
			'sha256',
			masterKey,
			Buffer.from('AIRadiologyReport/storage/v1'),
			Buffer.from('secrets/v1'),
			32
		)
	);
	const decipher = createDecipheriv('aes-256-gcm', key, frame.subarray(0, 12));
	decipher.setAAD(Buffer.from('AIRadiologyReport/storage/secret/v1'));
	decipher.setAuthTag(frame.subarray(-16));
	assert.equal(
		Buffer.concat([decipher.update(frame.subarray(12, -16)), decipher.final()]).toString('utf8'),
		privateText
	);
});

test('secret tampering, truncation, unknown versions and invalid encoding reveal no plaintext', (t) => {
	keyFixture(t);
	const encrypted = encryptSecret(privateText);
	const frame = Buffer.from(encrypted.slice(3), 'base64');
	const values = [
		undefined,
		null,
		3,
		'',
		'v1:',
		'v2:' + encrypted.slice(3),
		encrypted + '\n',
		encrypted + 'AAAA',
		'v1:not!base64',
		'v1:' + Buffer.alloc(27).toString('base64'),
		'v1:AAAA=AAA',
		'v1:' + frame.subarray(0, -1).toString('base64')
	];
	for (const index of [0, 12, frame.length - 1]) {
		const changed = Buffer.from(frame);
		changed[index] ^= 1;
		values.push('v1:' + changed.toString('base64'));
	}
	for (const value of values) {
		assert.throws(
			() => decryptSecret(value),
			(error) => safeError(error, 'Storage secret decryption failed.')
		);
	}
	for (const value of [undefined, null, 5, Buffer.from('secret')]) {
		assert.throws(
			() => encryptSecret(value),
			(error) => safeError(error, 'Storage secret encryption failed.')
		);
	}
});

test('changing or removing the master key prevents secret decryption', (t) => {
	keyFixture(t);
	const encrypted = encryptSecret(privateText);
	for (const key of [Buffer.alloc(32, 0xcc).toString('base64'), 'invalid']) {
		process.env.STORAGE_ENCRYPTION_KEY = key;
		assert.throws(
			() => decryptSecret(encrypted),
			(error) => safeError(error, 'Storage secret decryption failed.')
		);
	}
});

test('large files roundtrip using streams and versioned authenticated framing', async (t) => {
	const file = await fileFixture(t);
	const chunk = Buffer.alloc(64 * 1024);
	for (let index = 0; index < chunk.length; index += 1) chunk[index] = index % 251;
	await pipeline(
		Readable.from(
			(function* () {
				for (let index = 0; index < 160; index += 1) yield chunk;
			})()
		),
		createWriteStream(file('source'), { mode: 0o600 })
	);
	assert.equal(await encryptFile(file('source'), file('encrypted')), undefined);
	assert.equal(
		(await stat(file('encrypted'))).size,
		(await stat(file('source'))).size + headerLength + 16
	);
	assert.equal(await decryptFile(file('encrypted'), file('restored')), undefined);
	assert.equal(await checksum(file('restored')), await checksum(file('source')));
	if (process.platform !== 'win32') {
		for (const name of ['encrypted', 'restored'])
			assert.equal((await stat(file(name))).mode & 0o777, 0o600);
	}
});

test('empty files have valid GCM tags and fresh file IVs', async (t) => {
	const file = await fileFixture(t);
	await writeFile(file('source'), '');
	await encryptFile(file('source'), file('encrypted1'));
	await encryptFile(file('source'), file('encrypted2'));
	const first = await readFile(file('encrypted1'));
	const second = await readFile(file('encrypted2'));
	assert.equal(first.length, headerLength + 16);
	assert.equal(first.subarray(0, filePrefix.length).equals(filePrefix), true);
	assert.notDeepEqual(first, second);
	await decryptFile(file('encrypted1'), file('restored'));
	assert.equal((await readFile(file('restored'))).length, 0);
});

test('backup file key derivation and header authentication are independently verifiable', async (t) => {
	const file = await fileFixture(t);
	await writeFile(file('source'), privateText);
	await encryptFile(file('source'), file('encrypted'));
	const frame = await readFile(file('encrypted'));
	const key = Buffer.from(
		hkdfSync(
			'sha256',
			masterKey,
			Buffer.from('AIRadiologyReport/storage/v1'),
			Buffer.from('backup-file/v1'),
			32
		)
	);
	const decipher = createDecipheriv(
		'aes-256-gcm',
		key,
		frame.subarray(filePrefix.length, headerLength)
	);
	decipher.setAAD(frame.subarray(0, headerLength));
	decipher.setAuthTag(frame.subarray(-16));
	assert.equal(
		Buffer.concat([decipher.update(frame.subarray(headerLength, -16)), decipher.final()]).toString(
			'utf8'
		),
		privateText
	);
});

test('corrupted headers, IVs, ciphertext and tags fail generically and remove destination', async (t) => {
	const file = await fileFixture(t);
	await writeFile(file('source'), privateText.repeat(4096));
	await encryptFile(file('source'), file('encrypted'));
	const encrypted = await readFile(file('encrypted'));
	for (const index of [
		0,
		filePrefix.length - 1,
		filePrefix.length,
		headerLength,
		encrypted.length - 1
	]) {
		const corrupted = Buffer.from(encrypted);
		corrupted[index] ^= 1;
		await writeFile(file('corrupted'), corrupted);
		await assert.rejects(decryptFile(file('corrupted'), file('partial')), (error) =>
			safeError(error, 'Storage file decryption failed.')
		);
		await absent(file('partial'));
	}
	assert.equal((await readFile(file('encrypted'))).equals(encrypted), true);
});

test('truncated and appended frames are rejected with no partial destination', async (t) => {
	const file = await fileFixture(t);
	await writeFile(file('source'), privateText);
	await encryptFile(file('source'), file('encrypted'));
	const encrypted = await readFile(file('encrypted'));
	const corruptions = [
		0,
		1,
		filePrefix.length,
		headerLength - 1,
		headerLength + 15,
		headerLength + 16,
		encrypted.length - 1
	].map((length) => encrypted.subarray(0, length));
	corruptions.push(Buffer.concat([encrypted, Buffer.from('extra bytes')]));
	for (const corrupted of corruptions) {
		await writeFile(file('corrupted'), corrupted);
		await assert.rejects(decryptFile(file('corrupted'), file('partial')), (error) =>
			safeError(error, 'Storage file decryption failed.')
		);
		await absent(file('partial'));
	}
});

test('wrong file keys fail authentication and remove even large partial plaintext', async (t) => {
	const file = await fileFixture(t);
	await writeFile(file('source'), privateText.repeat(8192));
	await encryptFile(file('source'), file('encrypted'));
	process.env.STORAGE_ENCRYPTION_KEY = Buffer.alloc(32, 0xfe).toString('base64');
	await assert.rejects(decryptFile(file('encrypted'), file('partial')), (error) =>
		safeError(error, 'Storage file decryption failed.')
	);
	await absent(file('partial'));
});

test('secret and backup ciphertext cannot be substituted for each other', async (t) => {
	const file = await fileFixture(t);
	const secret = Buffer.from(encryptSecret(privateText).slice(3), 'base64');
	await writeFile(file('secret-as-file'), Buffer.concat([filePrefix, secret]));
	await assert.rejects(decryptFile(file('secret-as-file'), file('partial')), (error) =>
		safeError(error, 'Storage file decryption failed.')
	);
	await absent(file('partial'));
	await writeFile(file('source'), privateText);
	await encryptFile(file('source'), file('encrypted'));
	const encrypted = await readFile(file('encrypted'));
	assert.throws(
		() => decryptSecret('v1:' + encrypted.subarray(filePrefix.length).toString('base64')),
		(error) => safeError(error, 'Storage secret decryption failed.')
	);
});

test('existing destinations are never overwritten or removed, including the source itself', async (t) => {
	const file = await fileFixture(t);
	await writeFile(file('source'), privateText);
	await encryptFile(file('source'), file('encrypted'));
	await writeFile(file('existing'), 'preserve me');
	await assert.rejects(encryptFile(file('source'), file('existing')), (error) =>
		safeError(error, 'Storage file encryption failed.')
	);
	await assert.rejects(decryptFile(file('encrypted'), file('existing')), (error) =>
		safeError(error, 'Storage file decryption failed.')
	);
	assert.equal(await readFile(file('existing'), 'utf8'), 'preserve me');
	await assert.rejects(
		encryptFile(file('source'), file('source')),
		/Storage file encryption failed/
	);
	assert.equal(await readFile(file('source'), 'utf8'), privateText);
});

test('missing sources, non-files and invalid keys fail safely without creating destinations', async (t) => {
	const file = await fileFixture(t);
	for (const operation of [encryptFile, decryptFile]) {
		await assert.rejects(
			operation(file('missing'), file('destination')),
			/Storage file (encryption|decryption) failed/
		);
		await absent(file('destination'));
	}
	await mkdir(file('directory'));
	await assert.rejects(
		encryptFile(file('directory'), file('destination')),
		/Storage file encryption failed/
	);
	await absent(file('destination'));
	await writeFile(file('source'), privateText);
	process.env.STORAGE_ENCRYPTION_KEY = 'invalid';
	await assert.rejects(
		encryptFile(file('source'), file('destination')),
		/Storage file encryption failed/
	);
	await absent(file('destination'));
});
