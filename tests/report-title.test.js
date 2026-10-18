import test from 'node:test';
import assert from 'node:assert/strict';
import { reportTitle } from '../src/lib/report-title.js';

const mri = { modality_code: 'MR', modality_name: 'Magnetic Resonance' };

test('report titles place modality before the saved contrast description', () => {
	for (const contrast of ['without contrast', 'with contrast', 'with & without contrast', 'with and without contrast'])
		assert.equal(reportTitle({ ...mri, exam_type_name: `Brain ${contrast}` }), `Brain MRI ${contrast}`);
	assert.equal(reportTitle({ modality_code: 'CT', modality_name: 'Computed Tomography', exam_type_name: 'Chest without contrast' }), 'Chest CT without contrast');
});

test('saved side details prefix titles without inventing laterality or contrast', () => {
	assert.equal(reportTitle({ ...mri, exam_type_name: 'Hand', exam_details: 'left' }), 'Left Hand MRI');
	assert.equal(reportTitle({ ...mri, exam_type_name: 'Knee without contrast', exam_details: 'RIGHT' }), 'Right Knee MRI without contrast');
	assert.equal(reportTitle({ ...mri, exam_type_name: 'Hand', exam_details: 'bilateral' }), 'Bilateral Hand MRI');
	assert.equal(reportTitle({ ...mri, exam_type_name: 'Left Hand', exam_details: 'Left' }), 'Left Hand MRI');
	assert.equal(reportTitle({ ...mri, exam_type_name: 'Hand' }), 'Hand MRI');
});

test('titles preserve additional details, normalise spacing and do not mutate recordings', () => {
	const recording = { ...mri, exam_type_name: '  Brain  without contrast ', exam_details: ' postoperative  follow-up ' };
	const saved = { ...recording };
	assert.equal(reportTitle(recording), 'Brain MRI without contrast (postoperative follow-up)');
	assert.deepEqual(recording, saved);
});

test('examinations that already name their modality do not repeat it', () => {
	assert.equal(reportTitle({ ...mri, exam_type_name: 'Cardiac MRI without contrast' }), 'Cardiac MRI without contrast');
	assert.equal(reportTitle({ ...mri, exam_type_name: 'Brain MRA with contrast' }), 'Brain MRA with contrast');
	assert.equal(reportTitle({ modality_code: 'CT', exam_type_name: 'Brain CTA with contrast' }), 'Brain CTA with contrast');
	assert.equal(reportTitle({ modality_code: 'US', exam_type_name: 'Thyroid Ultrasound' }), 'Thyroid Ultrasound');
});

test('unknown and legacy selections use saved labels rather than guessing an examination', () => {
	assert.equal(reportTitle({ modality_code: 'XR', exam_type_name: 'Hand', exam_details: 'Left' }), 'Left Hand X-ray');
	assert.equal(reportTitle({ modality_code: 'CUSTOM', modality_name: 'Custom modality', exam_type_name: 'Brain' }), 'Brain Custom modality');
	assert.equal(reportTitle({ modality_code: 'MR', exam_type_code: 'BRAIN' }), 'BRAIN MRI');
	assert.equal(reportTitle({}), 'Radiology report');
	assert.equal(reportTitle(null), 'Radiology report');
});

test('a single explicit examination uses its own details instead of the legacy shared field', () => {
	const recording = { ...mri, exam_details: 'left', exam_types: [{ id: 3, name: 'Hand with contrast', exam_details: '' }] };
	assert.equal(reportTitle(recording), 'Hand MRI with contrast');
	assert.equal(reportTitle({ ...recording, exam_types: [{ ...recording.exam_types[0], exam_details: 'right' }] }), 'Right Hand MRI with contrast');
});

test('combined titles preserve examination order, individual contrast and shared details', () => {
	const recording = { ...mri, exam_details: 'Right', exam_types: [
		{ id: 2, name: 'Hand with contrast' }, { id: 1, name: 'Knee without contrast' }
	] };
	assert.equal(reportTitle(recording), 'Right Hand MRI with contrast + Right Knee MRI without contrast');
	assert.equal(reportTitle({ ...recording, exam_types: [...recording.exam_types].reverse() }), 'Right Knee MRI without contrast + Right Hand MRI with contrast');
	assert.equal(reportTitle({ ...recording, exam_details: 'follow-up' }), 'Hand MRI with contrast (follow-up) + Knee MRI without contrast (follow-up)');
});
