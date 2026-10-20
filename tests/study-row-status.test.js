import test from 'node:test';
import assert from 'node:assert/strict';
import { studyRowStatus, studyRowStatuses, studyStatusHref } from '../src/lib/study-row-status.js';

const signed = {
	recording_count: 2,
	resident_checked_count: 2,
	attending_checked_count: 2,
	typist_checked_count: 2
};

test('attention overrides missing recordings, missing signatures and full signing', () => {
	for (const study of [{}, { recording_count: 1 }, signed]) {
		assert.equal(studyRowStatus({ ...study, needs_attention: 1 }), 'attention');
	}
});

test('no recordings is red, never vacuously all signed', () => {
	assert.equal(studyRowStatus({}), 'no-recording');
	assert.equal(studyRowStatus({ recording_count: 0, resident_checked_count: 0, attending_checked_count: 0, typist_checked_count: 0 }), 'no-recording');
});

test('each recording must have every role signature for green', () => {
	assert.equal(studyRowStatus(signed), 'signed');
	assert.equal(studyRowStatus({ recording_count: 1, resident_checked_count: 1, attending_checked_count: 1, typist_checked_count: 1 }), 'signed');
	for (const key of ['resident_checked_count', 'attending_checked_count', 'typist_checked_count']) {
		for (const count of [0, 1, undefined]) {
			assert.equal(studyRowStatus({ ...signed, [key]: count }), 'unsigned');
		}
	}
	assert.equal(studyRowStatus({ recording_count: 1 }), 'unsigned');
});

test('status updates reflect attention removal and signature clearing without mutation', () => {
	const study = { ...signed, needs_attention: true };
	assert.equal(studyRowStatus(study), 'attention');
	study.needs_attention = false;
	assert.equal(studyRowStatus(study), 'signed');
	study.typist_checked_count = 1;
	const snapshot = { ...study };
	assert.equal(studyRowStatus(study), 'unsigned');
	assert.deepEqual(study, snapshot);
	study.needs_attention = true;
	assert.equal(studyRowStatus(study), 'attention');
});

test('status filters cover all active statuses plus disabled', () => {
	assert.deepEqual(studyRowStatuses.map(({ key }) => key), ['attention', 'no-recording', 'unsigned', 'signed', 'disabled']);
	assert.ok(studyRowStatuses.every(({ label }) => label.length > 0));
});

test('disabled studies are separate regardless of attention or signature state', () => {
	for (const study of [{}, { recording_count: 1 }, signed, { ...signed, needs_attention: 1 }])
		assert.equal(studyRowStatus({ ...study, disabled: 1 }), 'disabled');
});

test('status links preserve existing filters and sorting but reset the page', () => {
	const search = '?patient_fullname=Synthetic+Name&favorites=2&resident_checked=0&date_range=today&rowcount=10&orderedby=recording_count&orderdir=ASC&page=5&status=attention';
	for (const status of ['', ...studyRowStatuses.map(({ key }) => key)]) {
		const url = new URL(studyStatusHref(search, status), 'http://localhost');
		const expected = new URLSearchParams(search);
		expected.delete('status');
		expected.set('page', '1');
		if (status) expected.set('status', status);
		assert.equal(url.pathname, '/studies');
		assert.deepEqual([...url.searchParams].sort(), [...expected].sort());
	}
});
