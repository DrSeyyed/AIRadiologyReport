import { DIRECT_AUDIO_MODEL } from './report-generation-models.js';
import { TRANSCRIPTION_PROVIDERS } from './transcription-models.js';

export const DEFAULT_GPT_AUDIO_SETTINGS = { limitSeconds: 600, substitute: null };
export const MAX_GPT_AUDIO_LIMIT_SECONDS = Math.floor((0xffffffff - 36) / 32000);
export const GPT_AUDIO_SUBSTITUTES = TRANSCRIPTION_PROVIDERS.map((provider) => ({
	...provider,
	models: provider.models.filter((model) => model.id !== DIRECT_AUDIO_MODEL)
})).filter((provider) => provider.models.length > 0);

function hasShape(value, keys) {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype &&
		Reflect.ownKeys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

export function normalizeGptAudioSettings(value) {
	if (!hasShape(value, ['limitSeconds', 'substitute']))
		throw new Error('Provide a GPT Audio duration limit and substitute.');
	if (
		!Number.isInteger(value.limitSeconds) ||
		value.limitSeconds <= 0 ||
		value.limitSeconds > MAX_GPT_AUDIO_LIMIT_SECONDS
	)
		throw new Error(
			`GPT Audio duration must be a positive whole number of seconds up to ${MAX_GPT_AUDIO_LIMIT_SECONDS}.`
		);
	let substitute = null;
	if (value.substitute !== null) {
		if (
			!hasShape(value.substitute, ['provider', 'model']) ||
			!GPT_AUDIO_SUBSTITUTES.some(
				(provider) =>
					provider.id === value.substitute.provider &&
					provider.models.some((model) => model.id === value.substitute.model)
			)
		)
			throw new Error('Select a supported dedicated transcription substitute.');
		substitute = { provider: value.substitute.provider, model: value.substitute.model };
	}
	return { limitSeconds: value.limitSeconds, substitute };
}
