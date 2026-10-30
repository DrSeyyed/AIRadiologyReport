<script>
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { TRANSCRIPTION_PROVIDERS } from '$lib/transcription-models.js';
	import { isAudioModel } from '$lib/audio-models.js';

	let { data, form } = $props();
	let selection = $state(null);
	let saved = $derived(form?.settings ?? data.settings);
	let provider = $derived(selection?.provider ?? saved.provider);
	let model = $derived(selection?.model ?? saved.model);
	let models = $derived(TRANSCRIPTION_PROVIDERS.find((entry) => entry.id === provider).models);

	function changeProvider(event) {
		const next = TRANSCRIPTION_PROVIDERS.find((entry) => entry.id === event.currentTarget.value);
		selection = { provider: next.id, model: next.models[0].id };
	}
</script>

<section class="w-full min-w-0 max-w-3xl space-y-4">
	<h1 class="text-2xl font-semibold">Transcription settings</h1>
	<p id="model-help" class="text-sm">Used only in Transcribe, then generate mode.</p>
	{#if data.recoveryWarning}<div class="alert alert-warning" role="alert">{data.recoveryWarning}</div>{/if}
	{#if !data.configured.openai}
		<div class="alert alert-warning" role="alert">OPENAI_API_KEY is missing. OpenAI report generation is unavailable.</div>
	{/if}
	{#if provider === 'elevenlabs' && !data.configured.elevenlabs}
		<div class="alert alert-warning" role="alert">ELEVENLABS_API_KEY is missing. ElevenLabs transcription is unavailable.</div>
	{/if}
	{#if provider === 'gemini' && !data.configured.gemini}
		<div class="alert alert-warning" role="alert">GEMINI_API_KEY is missing. Gemini transcription is unavailable.</div>
	{/if}
	{#if form?.error}<div class="alert alert-error" role="alert">{form.error}</div>{/if}
	{#if form?.success}<div class="alert alert-success" role="status">Transcription settings saved.</div>{/if}
	<form method="POST" use:enhance={() => async ({ result, update }) => {
		await update({ reset: false });
		if (result.type === 'success') selection = null;
	}} class="min-w-0 space-y-4">
		<label class="form-control min-w-0">
			<span class="label-text">Transcription provider</span>
			<select name="provider" class="select select-bordered w-full min-w-0" value={provider} onchange={changeProvider}>
				{#each TRANSCRIPTION_PROVIDERS as entry (entry.id)}
					<option value={entry.id}>{entry.label}</option>
				{/each}
			</select>
		</label>
		<label class="form-control min-w-0">
			<span class="label-text">Transcription model</span>
			<select name="model" class="select select-bordered w-full min-w-0" value={model} onchange={(event) => selection = { provider, model: event.currentTarget.value }} aria-describedby="model-help">
				{#each models as entry (entry.id)}
					<option value={entry.id}>{entry.label}</option>
				{/each}
			</select>
		</label>
		{#if models.find((entry) => entry.id === model)?.label.includes('(legacy)')}
			<p class="text-sm text-warning">This model retires on February 26, 2027.</p>
		{/if}
		{#if isAudioModel({ provider, model })}
			<p class="text-sm">Requires FFmpeg. The shared audio-model recording limit and substitute are configured in <a class="link" href={resolve('/admin/reporting')}>Reporting settings</a>.</p>
		{/if}
		<noscript><p>Enable JavaScript to change providers and update the available model options.</p></noscript>
		<button class="btn btn-primary" type="submit">Save settings</button>
	</form>
</section>
