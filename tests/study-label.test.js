import test from 'node:test';
import assert from 'node:assert/strict';
import { studyLabel } from '../src/lib/study-label.js';
import { buildStudyMessage } from '../src/lib/server/telegram.js';

test('study display uses the imported code and preserves leading zeros', () => {
	assert.equal(studyLabel({ id: 20, patient_code: ' 000123 ' }), 'Study 000123');
	assert.equal(studyLabel({ id: 20, patient_code: 0 }), 'Study 0');
	assert.equal(studyLabel({ id: 20, patient_code: 'PACS-123' }), 'Study PACS-123');
});

test('the internal ID is a fallback only when no imported code is available', () => {
	for (const patient_code of ['', '  ', null, undefined])
		assert.equal(studyLabel({ id: 20, patient_code }), 'Study #20');
	assert.equal(studyLabel(), 'Study #-');
	assert.match(buildStudyMessage({ id: 20 }), /Study #20/);
});
