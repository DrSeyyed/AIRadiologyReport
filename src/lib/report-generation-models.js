import { audioModel, DEFAULT_DIRECT_AUDIO_SETTINGS } from './audio-models.js';
export { DIRECT_AUDIO_MODEL } from './audio-models.js';
export const REPORT_GENERATION_MODES = [
	{ id: 'transcribe_then_generate', label: 'Transcribe, then generate (current default)' },
	{ id: 'direct_audio', label: 'Direct audio → report' }
];
export const DEFAULT_REPORT_GENERATION_SETTINGS = { mode: 'transcribe_then_generate', ...DEFAULT_DIRECT_AUDIO_SETTINGS };

export function normalizeReportGenerationSettings(value) {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		![1, 3].includes(Object.keys(value).length) ||
		Object.keys(value).some((key) => !['mode', 'provider', 'model'].includes(key)) ||
		!REPORT_GENERATION_MODES.some((entry) => entry.id === value.mode)
	)
		throw new Error('Select a supported report-generation mode.');
	const selection = Object.keys(value).length === 1 ? DEFAULT_DIRECT_AUDIO_SETTINGS : value;
	if (!audioModel(selection)) throw new Error('Select a supported direct audio provider and model.');
	return { mode: value.mode, provider: selection.provider, model: selection.model };
}
