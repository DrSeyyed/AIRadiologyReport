import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramDiagnostic, telegramErrorDetails } from '../src/lib/server/telegram-diagnostics.js';
import { downloadFile } from '../src/lib/server/telegram.js';

test('diagnostics allowlist metadata, reject arbitrary strings and never serialize errors or payloads', (t) => {
	const logs = [];
	t.mock.method(console, 'info', (...args) => logs.push(args));
	const secret = 'PRIVATE_TOKEN_PASSWORD_PATIENT';
	const error = Object.assign(new Error(secret), { code: secret, status: 503, telegram_error_code: 429, cause: { code: 'ETIMEDOUT', message: secret } });
	telegramDiagnostic('voice_retry', {
		updateId: 12, messageId: 43, replyMessageId: 42, studyId: 1, jobId: 2, recordingId: 3,
		retryAt: 300, stage: 'download', reason: 'retryable_failure', media: 'voice', kind: 'message',
		...telegramErrorDetails(error), text: secret, caption: secret, file_id: secret,
		username: secret, password: secret, token: secret, error, body: { secret }
	});
	const row = JSON.parse(logs[0][1]);
	assert.deepEqual(row, {
		timestamp: row.timestamp, event: 'voice_retry', updateId: 12, messageId: 43,
		replyMessageId: 42, studyId: 1, jobId: 2, recordingId: 3, retryAt: 300,
		httpStatus: 503, telegramStatus: 429, reason: 'retryable_failure', stage: 'download',
		kind: 'message', media: 'voice', errorCode: 'ETIMEDOUT'
	});
	assert.ok(Number.isFinite(Date.parse(row.timestamp)));
	telegramDiagnostic('voice_ignored', { messageId: secret, studyId: -1, jobId: 1.5, recordingId: Infinity, reason: secret, stage: secret, media: secret, kind: secret, errorCode: secret, httpStatus: 999, telegramStatus: secret });
	assert.deepEqual(Object.keys(JSON.parse(logs[1][1])), ['timestamp', 'event']);
	telegramDiagnostic(secret, { text: secret });
	assert.equal(logs.length, 2);
	assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_TOKEN_PASSWORD_PATIENT/);
	assert.deepEqual(telegramErrorDetails(new Error(secret)), { errorCode: 'unexpected' });
	assert.deepEqual(telegramErrorDetails({ name: 'TimeoutError' }), { errorCode: 'TimeoutError' });
});

test('logging failures do not break webhook or worker operations', (t) => {
	t.mock.method(console, 'info', () => { throw new Error('synthetic logging failure'); });
	assert.doesNotThrow(() => telegramDiagnostic('voice_queued', { jobId: 1 }));
});

test('Telegram download errors retain safe provider status without changing worker rejection semantics', async (t) => {
	const previous = process.env.TELEGRAM_BOT_TOKEN;
	process.env.TELEGRAM_BOT_TOKEN = 'synthetic-token';
	t.after(() => {
		if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
		else process.env.TELEGRAM_BOT_TOKEN = previous;
	});
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => {
		calls++;
		if (calls === 1) return { json: async () => ({ ok: true, result: { file_path: 'synthetic.ogg' } }) };
		return { ok: false, status: 503, statusText: 'PRIVATE_PROVIDER_TEXT' };
	});
	await assert.rejects(downloadFile('PRIVATE_FILE_ID', 'unused.ogg'), error => {
		assert.equal(error.status, undefined);
		assert.equal(error.telegram_error_code, undefined);
		assert.deepEqual(telegramErrorDetails(error), { errorCode: 'unexpected', telegramStatus: 503 });
		return true;
	});
	t.mock.method(globalThis, 'fetch', async () => ({ status: 403, json: async () => { throw new Error('PRIVATE_NON_JSON'); } }));
	await assert.rejects(downloadFile('PRIVATE_FILE_ID', 'unused.ogg'), error => {
		assert.equal(error.status, undefined);
		assert.equal(error.telegram_error_code, undefined);
		assert.equal(telegramErrorDetails(error).telegramStatus, 403);
		return true;
	});
});
