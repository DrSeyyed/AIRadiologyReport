import { AUDIO_MODEL_PROVIDERS } from './audio-models.js';

export const TRANSCRIPTION_PROVIDERS = [
	{
		id: 'openai', label: 'OpenAI', models: [
			{ id: 'gpt-transcribe', label: 'GPT Transcribe (current default)' },
			...AUDIO_MODEL_PROVIDERS.find((provider) => provider.id === 'openai').models,
			{ id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe (legacy)' },
			{ id: 'gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe (legacy)' },
			{ id: 'whisper-1', label: 'Whisper-1 (legacy)' }
		]
	},
	AUDIO_MODEL_PROVIDERS.find((provider) => provider.id === 'gemini'),
	{
		id: 'elevenlabs', label: 'ElevenLabs', models: [
			{ id: 'scribe_v2_medical', label: 'Scribe v2 Medical' },
			{ id: 'scribe_v2', label: 'Scribe v2' }
		]
	}
];

export const DEFAULT_TRANSCRIPTION_SETTINGS = { provider: 'openai', model: 'gpt-transcribe' };

export function normalizeTranscriptionSettings(value) {
	const provider = TRANSCRIPTION_PROVIDERS.find((entry) => entry.id === value?.provider);
	if (!provider) throw new Error('Select a supported transcription provider.');
	if (!provider.models.some((entry) => entry.id === value.model))
		throw new Error('Select a supported model for the transcription provider.');
	return { provider: provider.id, model: value.model };
}
