const REALTIME_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const GEMINI_EFFORTS = ['low', 'medium', 'high'];
export const TEXT_REPORT_MODEL = 'gpt-6.1-sol';

export function reasoningEfforts({ provider, model } = {}) {
	if (provider === 'openai') {
		if (['gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini'].includes(model)) return [...REALTIME_EFFORTS];
		if (model === TEXT_REPORT_MODEL) return ['low', 'medium', 'high', 'xhigh', 'max'];
	}
	if (provider === 'gemini' && ['gemini-3.8-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'].includes(model)) return [...GEMINI_EFFORTS];
	return [];
}

export function normalizeReasoningEffort(settings, effort) {
	if (effort === undefined || effort === 'default') return undefined;
	if (!reasoningEfforts(settings).includes(effort)) throw new Error('Select a supported reasoning effort for this model.');
	return effort;
}

export function reasoningSettings(settings, effort) {
	const reasoningEffort = normalizeReasoningEffort(settings, effort);
	return reasoningEffort === undefined ? {} : { reasoningEffort };
}

export function reasoningEffortFromForm(form, name = 'reasoningEffort') {
	if (!form.has(name)) return undefined;
	if (form.getAll(name).length !== 1 || typeof form.get(name) !== 'string') throw new Error('Select one reasoning effort.');
	return form.get(name);
}
