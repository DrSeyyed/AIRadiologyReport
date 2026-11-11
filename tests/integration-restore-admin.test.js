import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { INTEGRATION_FIELDS } from '../src/lib/server/integration-settings.js';
import {
	integrationRestoreSelection, validateIntegrationRestoreSelection,
	pendingRestoreMetadata, withRestoreIntegrationMetadata
} from '../src/lib/server/integration-restore-admin.js';

function form(fields = [], confirmation) {
	const body = new FormData();
	body.set('jobId', '42');
	body.set('confirmation', 'ACTIVATE RESTORE');
	body.set('acknowledgement', 'on');
	for (const field of fields) body.append('integrationField', field);
	if (confirmation !== undefined) body.set('integrationConfirmation', confirmation);
	return body;
}

test('credential restore defaults to retaining all current fields and requires a separate exact confirmation', () => {
	assert.deepEqual(integrationRestoreSelection(form()), []);
	assert.deepEqual(integrationRestoreSelection(form([], '')), []);
	for (const { key } of INTEGRATION_FIELDS) {
		assert.deepEqual(integrationRestoreSelection(form([key], 'RESTORE CREDENTIALS')), [key]);
		for (const confirmation of [undefined, '', 'restore credentials', ' RESTORE CREDENTIALS', 'RESTORE CREDENTIALS '])
			assert.throws(() => integrationRestoreSelection(form([key], confirmation)));
	}
	const keys = INTEGRATION_FIELDS.map(({ key }) => key);
	assert.deepEqual(integrationRestoreSelection(form(keys, 'RESTORE CREDENTIALS')), keys);
});

test('credential restore rejects duplicate, unknown, file, excessive and master-key selections', () => {
	for (const fields of [['OPENAI_API_KEY', 'OPENAI_API_KEY'], ['STORAGE_ENCRYPTION_KEY'], ['unknown'], [null], {}, 'OPENAI_API_KEY', Array(8).fill('OPENAI_API_KEY')])
		assert.throws(() => validateIntegrationRestoreSelection(fields));
	for (const fields of [['STORAGE_ENCRYPTION_KEY'], ['OPENAI_API_KEY', 'OPENAI_API_KEY'], ['unknown']])
		assert.throws(() => integrationRestoreSelection(form(fields, 'RESTORE CREDENTIALS')));
	const file = form([], 'RESTORE CREDENTIALS');
	file.set('integrationField', new Blob(['OPENAI_API_KEY']), 'field.txt');
	assert.throws(() => integrationRestoreSelection(file));
	const duplicated = form(['OPENAI_API_KEY'], 'RESTORE CREDENTIALS');
	duplicated.append('integrationConfirmation', 'RESTORE CREDENTIALS');
	assert.throws(() => integrationRestoreSelection(duplicated));
	const unknown = form();
	unknown.set('STORAGE_ENCRYPTION_KEY', 'private-untrusted-value');
	assert.throws(() => integrationRestoreSelection(unknown));
});

test('pending metadata fails closed without revealing ciphertext or errors', () => {
	const pending = { pending: true, fields: ['OPENAI_API_KEY'], backupId: `1800000000-${randomUUID()}` };
	assert.equal(pendingRestoreMetadata({}, () => pending), pending);
	const failed = pendingRestoreMetadata({}, () => { throw new Error('private-secret-and-ciphertext'); });
	assert.equal(failed.pending, true);
	assert.deepEqual(failed.fields, []);
	assert.doesNotMatch(JSON.stringify(failed), /private-secret-and-ciphertext/);
});

test('verified copy metadata binds staged directory and registered backup, returning labels only', () => {
	const restoreId = randomUUID();
	const backupId = `1800000000-${randomUUID()}`;
	const restore = { id: 42, directory: `restore-staging/${restoreId}` };
	const db = { prepare: () => ({ get: () => ({ result: JSON.stringify({ restoreId, id: backupId }) }) }) };
	const fields = [{ key: 'OPENAI_API_KEY', label: 'OpenAI API key', configured: true }];
	const calls = [];
	const options = { cwd: process.cwd(), read: (...args) => { calls.push(args); return fields; } };
	const result = withRestoreIntegrationMetadata(db, { preparedRestores: [restore], other: 1 }, options);
	assert.equal(result.other, 1);
	assert.deepEqual(result.preparedRestores[0].integrationFields, fields);
	assert.deepEqual(calls, [[path.join(process.cwd(), 'restore-staging', restoreId), { backupId }]]);
	assert.equal(restore.integrationFields, undefined);
	assert.deepEqual(withRestoreIntegrationMetadata(db, { preparedRestores: [restore] }, { ...options, read: () => [] }).preparedRestores[0].integrationFields, []);
});

test('unsafe, mismatched, corrupt and unreadable staged copies expose no selectable credentials', () => {
	const restoreId = randomUUID();
	const base = { id: 42, directory: `restore-staging/${restoreId}` };
	const db = { prepare: () => ({ get: () => ({ result: JSON.stringify({ restoreId, id: `1800000000-${randomUUID()}` }) }) }) };
	for (const restore of [{ ...base, directory: 'restore-staging/../db' }, { ...base, directory: `uploads/${restoreId}` }, { ...base, id: 0 }, { ...base, directory: `restore-staging/${randomUUID()}` }]) {
		const result = withRestoreIntegrationMetadata(db, { preparedRestores: [restore] }, { read: () => assert.fail('must reject before reading file') });
		assert.equal(result.preparedRestores[0].integrationUnavailable, true);
		assert.deepEqual(result.preparedRestores[0].integrationFields, []);
	}
	const result = withRestoreIntegrationMetadata(db, { preparedRestores: [base] }, { read: () => { throw new Error('private-secret'); } });
	assert.equal(result.preparedRestores[0].integrationUnavailable, true);
	assert.doesNotMatch(JSON.stringify(result), /private-secret/);
});
