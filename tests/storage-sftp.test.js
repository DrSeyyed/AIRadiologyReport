import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import ssh2 from 'ssh2';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadStorageFile } from '../src/lib/server/storage-upload.js';
import { hashRemote, withStorage } from '../src/lib/server/storage-transport.js';

const { privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
	publicKeyEncoding: { type: 'spki', format: 'pem' }
});
const publicKey = ssh2.utils.parseKey(privateKey).getPublicSSH();
const fingerprint = `SHA256:${createHash('sha256').update(publicKey).digest('base64').replace(/=$/, '')}`;

for (const [operation, phase] of [
	['verification', 'OPEN'],
	['verification', 'READ'],
	['verification', 'CLOSE'],
	['upload', 'OPEN'],
	['upload', 'WRITE'],
	['upload', 'CLOSE']
]) {
	test(
		`real SFTP ${operation} aborts a server that never acknowledges ${phase}`,
		{ timeout: 10_000 },
		async (t) => {
			const connections = new Set();
			let stalledRequests = 0;
			const contents = Buffer.from('synthetic encrypted audio');
			const directory = await mkdtemp(join(tmpdir(), 'storage-sftp-'));
			t.after(() => rm(directory, { recursive: true, force: true }));
			const local = join(directory, 'audio.enc');
			await writeFile(local, contents);
			const server = new ssh2.Server({ hostKeys: [privateKey] }, (connection) => {
				connections.add(connection);
				connection.on('error', () => {});
				connection.on('close', () => connections.delete(connection));
				connection.on('authentication', (context) => {
					if (
						context.method === 'password' &&
						context.username === 'test' &&
						context.password === 'test'
					)
						context.accept();
					else context.reject();
				});
				connection.on('ready', () => {
					connection.on('session', (accept) => {
						accept().on('sftp', (acceptSftp) => {
							const sftp = acceptSftp();
							sftp.on('LSTAT', (id, path) =>
								sftp.attrs(id, {
									mode: path.endsWith('/object') ? 0o100600 : 0o040700,
									size: contents.length
								})
							);
							const stalled = (name) => {
								if (phase !== name) return false;
								stalledRequests++;
								return true;
							};
							sftp.on('OPEN', (id) => {
								if (!stalled('OPEN')) sftp.handle(id, Buffer.from('test-handle'));
							});
							sftp.on('READ', (id, handle, offset, length) => {
								if (stalled('READ')) return;
								if (offset >= contents.length) sftp.status(id, ssh2.utils.sftp.STATUS_CODE.EOF);
								else sftp.data(id, contents.subarray(offset, offset + length));
							});
							sftp.on('WRITE', (id) => {
								if (!stalled('WRITE')) sftp.status(id, ssh2.utils.sftp.STATUS_CODE.OK);
							});
							sftp.on('CLOSE', (id) => {
								if (!stalled('CLOSE')) sftp.status(id, ssh2.utils.sftp.STATUS_CODE.OK);
							});
						});
					});
				});
			});
			t.after(async () => {
				for (const connection of connections) connection.destroy();
				await new Promise((resolve) => server.close(resolve));
			});
			server.listen(0, '127.0.0.1');
			await once(server, 'listening');
			let disconnected = 0;
			await assert.rejects(
				withStorage(
					{
						host: '127.0.0.1',
						port: server.address().port,
						username: 'test',
						password: 'test',
						fingerprint,
						root: '/backups/reports'
					},
					(client) => {
						const destroy = client.client.destroy.bind(client.client);
						client.client.destroy = () => {
							disconnected++;
							return destroy();
						};
						return operation === 'verification'
							? hashRemote(client, '/backups/reports/object', { verificationTimeoutSeconds: 1 })
							: uploadStorageFile(client, local, '/backups/reports/object', {
									uploadTimeoutSeconds: 1
								});
					}
				),
				/Storage operation failed/
			);
			assert.ok(stalledRequests > 0);
			assert.equal(disconnected, 1);
		}
	);
}
