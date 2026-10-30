import { audioModel, audioModelSampleRate } from '../audio-models.js';
import { generateGeminiAudioText } from './gemini-audio.js';
import { generateRealtimeAudioText } from './realtime-audio.js';
import { normalizeAudioTranscriptOutput } from './audio-transcript-output.js';

export async function generateAudioModelText(settings, data, instructions, task) {
	const model = audioModel(settings);
	const options = { model: settings.model, audio: { data, format: 'wav', sampleRate: audioModelSampleRate(settings) }, instructions, task };
	if (model?.transport === 'gemini') return generateGeminiAudioText(options);
	if (model?.transport === 'realtime') return generateRealtimeAudioText(options);
	throw new Error('Select a supported generative audio model.');
}

export function normalizeProviderTranscript(text, provider) {
	try {
		return normalizeAudioTranscriptOutput(text);
	} catch (error) {
		if (provider === 'gemini') error.message = error.message.replace(/^OpenAI/, 'Gemini');
		throw error;
	}
}
