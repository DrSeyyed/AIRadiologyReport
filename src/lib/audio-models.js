export const DIRECT_AUDIO_MODEL = 'gpt-audio-1.5';
export const AUDIO_MODEL_PROVIDERS = [
	{
		id: 'openai', label: 'OpenAI', models: [
			{ id: DIRECT_AUDIO_MODEL, label: 'GPT Audio 1.5', transport: 'chat' },
			{ id: 'gpt-realtime-2', label: 'GPT Realtime 2', transport: 'realtime' },
			{ id: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1', transport: 'realtime' },
			{ id: 'gpt-realtime-2.1-mini', label: 'GPT Realtime 2.1 Mini', transport: 'realtime' }
		]
	},
	{
		id: 'gemini', label: 'Google Gemini', models: [
			{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', transport: 'gemini' },
			{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', transport: 'gemini' },
			{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', transport: 'gemini' }
		]
	}
];
export const DEFAULT_DIRECT_AUDIO_SETTINGS = { provider: 'openai', model: DIRECT_AUDIO_MODEL };

export function audioModel(settings) {
	return AUDIO_MODEL_PROVIDERS.find((provider) => provider.id === settings?.provider)
		?.models.find((model) => model.id === settings?.model);
}

export function isAudioModel(settings) {
	return Boolean(audioModel(settings));
}

export function audioModelSampleRate(settings) {
	return audioModel(settings)?.transport === 'realtime' ? 24000 : 16000;
}
