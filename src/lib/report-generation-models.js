export const DIRECT_AUDIO_MODEL = 'gpt-audio-1.5';
export const REPORT_GENERATION_MODES = [
	{ id: 'transcribe_then_generate', label: 'Transcribe, then generate (current default)' },
	{ id: 'direct_audio', label: 'Direct audio → report (GPT Audio 1.5)' }
];
export const DEFAULT_REPORT_GENERATION_SETTINGS = { mode: 'transcribe_then_generate' };

export function normalizeReportGenerationSettings(value) {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).length !== 1 ||
		!REPORT_GENERATION_MODES.some((entry) => entry.id === value.mode)
	)
		throw new Error('Select a supported report-generation mode.');
	return { mode: value.mode };
}
