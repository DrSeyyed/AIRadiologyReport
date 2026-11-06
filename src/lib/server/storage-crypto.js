import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const FILE_PREFIX = Buffer.from('ARRSTG\x01', 'binary');
const HEADER_LENGTH = FILE_PREFIX.length + IV_LENGTH;
const SECRET_AAD = Buffer.from('AIRadiologyReport/storage/secret/v1');
const SALT = Buffer.from('AIRadiologyReport/storage/v1');

function readKey() {
	const encoded = process.env.STORAGE_ENCRYPTION_KEY;
	if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
		throw new Error('Storage encryption key is invalid.');
	}
	const key = Buffer.from(encoded, 'base64');
	if (key.length !== 32 || key.toString('base64') !== encoded) {
		key.fill(0);
		throw new Error('Storage encryption key is invalid.');
	}
	return key;
}

function deriveKey(context) {
	const master = readKey();
	try {
		return Buffer.from(hkdfSync('sha256', master, SALT, Buffer.from(context), 32));
	} finally {
		master.fill(0);
	}
}

/** Validate a canonical, padded base64 encoding of 32 bytes; never return the key. */
export function assertStorageKey() {
	readKey().fill(0);
}

/** Return v1:base64(iv[12] || ciphertext || tag[16]), using the secret-only HKDF key. */
export function encryptSecret(value) {
	let key;
	try {
		if (typeof value !== 'string') throw new Error();
		key = deriveKey('secrets/v1');
		const iv = randomBytes(IV_LENGTH);
		const cipher = createCipheriv(ALGORITHM, key, iv);
		cipher.setAAD(SECRET_AAD);
		const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
		return `v1:${Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64')}`;
	} catch {
		throw new Error('Storage secret encryption failed.');
	} finally {
		key?.fill(0);
	}
}

/** Authenticate a versioned secret before returning its UTF-8 plaintext. */
export function decryptSecret(value) {
	let key;
	try {
		if (
			typeof value !== 'string' ||
			!/^v1:(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
		) {
			throw new Error();
		}
		const encoded = value.slice(3);
		const frame = Buffer.from(encoded, 'base64');
		if (frame.length < IV_LENGTH + TAG_LENGTH || frame.toString('base64') !== encoded) {
			throw new Error();
		}
		key = deriveKey('secrets/v1');
		const decipher = createDecipheriv(ALGORITHM, key, frame.subarray(0, IV_LENGTH));
		decipher.setAAD(SECRET_AAD);
		decipher.setAuthTag(frame.subarray(-TAG_LENGTH));
		return Buffer.concat([
			decipher.update(frame.subarray(IV_LENGTH, -TAG_LENGTH)),
			decipher.final()
		]).toString('utf8');
	} catch {
		throw new Error('Storage secret decryption failed.');
	} finally {
		key?.fill(0);
	}
}

async function readExactly(handle, length, position) {
	const buffer = Buffer.alloc(length);
	let offset = 0;
	while (offset < length) {
		const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
		if (!bytesRead) throw new Error();
		offset += bytesRead;
	}
	return buffer;
}

async function writeChunks(handle, chunks) {
	for await (const chunk of chunks) await handle.writeFile(chunk);
}

async function transformFile(source, destination, decrypt) {
	let key;
	let input;
	let output;
	let created = false;
	let complete = false;
	try {
		key = deriveKey('backup-file/v1');
		input = await open(source, 'r');
		const stat = await input.stat();
		if (!stat.isFile()) throw new Error();
		let cipher;
		let header;
		if (decrypt) {
			if (stat.size < HEADER_LENGTH + TAG_LENGTH) throw new Error();
			header = await readExactly(input, HEADER_LENGTH, 0);
			if (!header.subarray(0, FILE_PREFIX.length).equals(FILE_PREFIX)) throw new Error();
			cipher = createDecipheriv(ALGORITHM, key, header.subarray(FILE_PREFIX.length));
			cipher.setAuthTag(await readExactly(input, TAG_LENGTH, stat.size - TAG_LENGTH));
		} else {
			const iv = randomBytes(IV_LENGTH);
			header = Buffer.concat([FILE_PREFIX, iv]);
			cipher = createCipheriv(ALGORITHM, key, iv);
		}
		cipher.setAAD(header);
		// Exclusive creation avoids clobbering an existing file or following a destination symlink.
		output = await open(destination, 'wx', 0o600);
		created = true;
		if (!decrypt) await output.writeFile(header);
		const length = decrypt ? stat.size - HEADER_LENGTH - TAG_LENGTH : stat.size;
		if (length) {
			await pipeline(
				input.createReadStream({
					start: decrypt ? HEADER_LENGTH : 0,
					end: (decrypt ? stat.size - TAG_LENGTH : stat.size) - 1,
					autoClose: false
				}),
				cipher,
				(chunks) => writeChunks(output, chunks)
			);
		} else {
			await output.writeFile(cipher.final());
		}
		if (!decrypt) await output.writeFile(cipher.getAuthTag());
		await output.close();
		output = undefined;
		await input.close();
		input = undefined;
		complete = true;
	} catch {
		throw new Error(`Storage file ${decrypt ? 'decryption' : 'encryption'} failed.`);
	} finally {
		key?.fill(0);
		await Promise.all([input?.close().catch(() => {}), output?.close().catch(() => {})]);
		if (created && !complete) await unlink(destination).catch(() => {});
	}
}

/**
 * Stream to a NEW mode-0600 file: ASCII ARRSTG || version byte 1 || iv[12] || ciphertext || tag[16].
 * The header is authenticated; HKDF uses the backup-file context, distinct from secrets.
 * On failure the newly created destination is removed; existing destinations are preserved.
 */
export async function encryptFile(source, destination) {
	await transformFile(source, destination, false);
}

/** Stream/authenticate a v1 backup into a NEW mode-0600 file; remove partial output on any failure. */
export async function decryptFile(source, destination) {
	await transformFile(source, destination, true);
}
