import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportTypographyStorage } from '../src/lib/report-typography-client.js';

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

function response(value, ok = true) {
	return { ok, json: async () => value };
}

test('loads saved account typography without writing defaults and reloads on every open', async () => {
	const calls = [];
	let saved = { font: 'Times New Roman', size: 11 };
	const storage = createReportTypographyStorage(async (url, options) => {
		calls.push({ url, options });
		return response(saved);
	});
	assert.deepEqual(await storage.load(1), saved);
	saved = { font: 'Calibri', size: 14.5 };
	assert.deepEqual(await storage.load(1), saved);
	assert.equal(calls.length, 2);
	for (const { url, options } of calls) {
		assert.equal(url, '/api/account/report-typography');
		assert.equal(options.method, 'GET');
		assert.equal(options.credentials, 'same-origin');
		assert.equal(options.cache, 'no-store');
		assert.equal(options.body, undefined);
	}
});

test('serializes rapid changes and next-report loads behind the latest account save', async () => {
	const started = deferred();
	const release = deferred();
	const calls = [];
	let saved = { font: 'Times New Roman', size: 11 };
	const storage = createReportTypographyStorage(async (_url, options) => {
		calls.push(options.method);
		if (calls.length === 1) {
			started.resolve();
			await release.promise;
		}
		if (options.method === 'PATCH') {
			assert.equal(options.headers['Content-Type'], 'application/json');
			saved = JSON.parse(options.body);
			assert.equal(saved.user_id, undefined);
		}
		return response(saved);
	});
	const first = storage.save(1, { font: 'Arial', size: 12 });
	const last = storage.save(1, { font: 'Georgia', size: 13.5 });
	const nextReport = storage.load(1);
	await started.promise;
	assert.deepEqual(calls, ['PATCH']);
	release.resolve();
	await Promise.all([first, last]);
	assert.deepEqual(await nextReport, { font: 'Georgia', size: 13.5 });
	assert.deepEqual(calls, ['PATCH', 'PATCH', 'GET']);
});

test('account queues are independent and do not reuse another account values', async () => {
	const started = deferred();
	const release = deferred();
	let calls = 0;
	const storage = createReportTypographyStorage(async () => {
		if (++calls === 1) {
			started.resolve();
			await release.promise;
			return response({ font: 'Arial', size: 12 });
		}
		return response({ font: 'Times New Roman', size: 11 });
	});
	const firstAccount = storage.save(1, { font: 'Arial', size: 12 });
	await started.promise;
	assert.deepEqual(await storage.load(2), { font: 'Times New Roman', size: 11 });
	release.resolve();
	await firstAccount;
});

test('invalid and incomplete size edits never make a preference request', () => {
	let calls = 0;
	const storage = createReportTypographyStorage(async () => { calls++; });
	for (const size of ['', '11', 5, 73, NaN, Infinity]) {
		assert.throws(() => storage.save(1, { font: 'Arial', size }));
	}
	assert.throws(() => storage.save(1, { font: 'unknown', size: 11 }));
	assert.equal(calls, 0);
});

test('failed saves are surfaced and do not block subsequent saves or report loads', async () => {
	let calls = 0;
	const storage = createReportTypographyStorage(async () => {
		if (++calls === 1) return response({ error: 'Database unavailable' }, false);
		return response({ font: 'Georgia', size: 13 });
	});
	const failed = storage.save(1, { font: 'Arial', size: 12 });
	const retried = storage.save(1, { font: 'Georgia', size: 13 });
	await assert.rejects(failed, /Unable to save or load/);
	await retried;
	assert.deepEqual(await storage.load(1), { font: 'Georgia', size: 13 });
});

test('malformed or failed preference loads cannot replace the safe display defaults', async () => {
	for (const result of [response({}, false), response({ font: 'injected;style', size: 11 }), {
		ok: true, json: async () => { throw new Error('Invalid JSON'); }
	}]) {
		const storage = createReportTypographyStorage(async () => result);
		await assert.rejects(storage.load(1));
	}
});
