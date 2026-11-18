import test from 'node:test';
import assert from 'node:assert/strict';
import { reasoningEfforts, normalizeReasoningEffort, reasoningEffortFromForm, TEXT_REPORT_MODEL } from '../src/lib/reasoning-effort.js';
import { normalizeTranscriptionSettings, TRANSCRIPTION_PROVIDERS } from '../src/lib/transcription-models.js';
import { normalizeReportGenerationSettings, DEFAULT_REPORT_GENERATION_SETTINGS } from '../src/lib/report-generation-models.js';

const realtime = { provider: 'openai', model: 'gpt-realtime-2.1' };

test('only supported models expose their model-specific reasoning levels', () => {
	for (const model of ['gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini']) {
		assert.deepEqual(reasoningEfforts({ provider: 'openai', model }), ['minimal', 'low', 'medium', 'high', 'xhigh']);
	}
	for (const model of ['gemini-3.8-flash', 'gemini-2.5-pro', 'gemini-2.5-flash']) {
		assert.deepEqual(reasoningEfforts({ provider: 'gemini', model }), ['low', 'medium', 'high']);
	}
	assert.deepEqual(reasoningEfforts({ provider: 'openai', model: TEXT_REPORT_MODEL }), ['low', 'medium', 'high', 'xhigh', 'max']);
	for (const provider of TRANSCRIPTION_PROVIDERS) for (const model of provider.models) {
		const settings = { provider: provider.id, model: model.id };
		assert.deepEqual(normalizeTranscriptionSettings(settings), settings);
		assert.deepEqual(normalizeTranscriptionSettings({ ...settings, reasoningEffort: 'default' }), settings);
		for (const effort of reasoningEfforts(settings)) {
			assert.deepEqual(normalizeTranscriptionSettings({ ...settings, reasoningEffort: effort }), { ...settings, reasoningEffort: effort });
		}
		if (!reasoningEfforts(settings).length) assert.throws(() => normalizeTranscriptionSettings({ ...settings, reasoningEffort: 'medium' }));
	}
	assert.deepEqual(reasoningEfforts({ provider: 'gemini', model: realtime.model }), []);
	const levels = reasoningEfforts(realtime);
	levels.push('invalid');
	assert.ok(!reasoningEfforts(realtime).includes('invalid'));
});

test('invalid efforts fail validation rather than silently falling back', () => {
	for (const effort of [null, '', 'MEDIUM', 'none', 'max', 1, {}, [], new Blob(['medium'])]) {
		assert.throws(() => normalizeReasoningEffort(realtime, effort), /supported reasoning effort/);
	}
	assert.equal(normalizeReasoningEffort(realtime, undefined), undefined);
	assert.equal(normalizeReasoningEffort(realtime, 'default'), undefined);
});

test('reporting stores independent direct and text effort and accepts old saved settings', () => {
	assert.deepEqual(normalizeReportGenerationSettings({ mode: 'direct_audio' }), { ...DEFAULT_REPORT_GENERATION_SETTINGS, mode: 'direct_audio' });
	for (const mode of ['direct_audio', 'transcribe_then_generate']) {
		const settings = { mode, ...realtime, reasoningEffort: 'medium', textReasoningEffort: 'high' };
		assert.deepEqual(normalizeReportGenerationSettings(settings), settings);
		assert.deepEqual(normalizeReportGenerationSettings({ mode, textReasoningEffort: 'max' }), { ...DEFAULT_REPORT_GENERATION_SETTINGS, mode, textReasoningEffort: 'max' });
		assert.deepEqual(normalizeReportGenerationSettings({ ...settings, reasoningEffort: 'default', textReasoningEffort: 'default' }), { mode, ...realtime });
	}
	for (const value of [
		{ ...DEFAULT_REPORT_GENERATION_SETTINGS, reasoningEffort: 'medium' },
		{ ...DEFAULT_REPORT_GENERATION_SETTINGS, textReasoningEffort: 'minimal' },
		{ ...DEFAULT_REPORT_GENERATION_SETTINGS, textReasoningEffort: null },
		{ mode: 'direct_audio', provider: 'openai', reasoningEffort: 'medium' },
		{ ...DEFAULT_REPORT_GENERATION_SETTINGS, unexpected: true }
	]) assert.throws(() => normalizeReportGenerationSettings(value));
});

test('form effort parsing rejects duplicate fields and files', () => {
	const form = new FormData();
	assert.equal(reasoningEffortFromForm(form), undefined);
	form.set('reasoningEffort', 'medium');
	assert.equal(reasoningEffortFromForm(form), 'medium');
	form.append('reasoningEffort', 'high');
	assert.throws(() => reasoningEffortFromForm(form));
	form.set('reasoningEffort', new Blob(['medium']));
	assert.throws(() => reasoningEffortFromForm(form));
});
