<script>
	import { enhance } from '$app/forms';
	import { TRANSCRIPTION_PROVIDERS } from '$lib/transcription-models.js';

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
	<p>Choose the provider and model for transcription. Choosing a provider sends audio to that provider. There is no silent fallback to another provider.</p>
	<p>OpenAI remains required for report generation, even when ElevenLabs handles transcription. ElevenLabs transcription additionally requires ELEVENLABS_API_KEY. Keys are configured on the server, not on this page.</p>
	<p class="text-sm">Compare transcription accuracy for mixed Persian/English dictation using representative recordings; neither provider or model is guaranteed to be more accurate.</p>
	{#if data.recoveryWarning}<div class="alert alert-warning" role="alert">{data.recoveryWarning}</div>{/if}
	{#if !data.configured.openai}
		<div class="alert alert-warning" role="alert">OPENAI_API_KEY is missing. OpenAI report generation is unavailable.</div>
	{/if}
	{#if !data.configured[provider]}
		<div class="alert alert-warning" role="alert">The selected transcription provider's key is missing ({provider === 'openai' ? 'OPENAI_API_KEY' : 'ELEVENLABS_API_KEY'}). Transcription is unavailable for this selection. You may save now and configure the key later.</div>
	{/if}
	{#if form?.error}<div class="alert alert-error" role="alert">{form.error}</div>{/if}
	{#if form?.success}<div class="alert alert-success" role="status">Transcription settings saved.</div>{/if}
	<form method="POST" use:enhance={() => async ({ update }) => {
		await update();
		selection = null;
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
			<select name="model" class="select select-bordered w-full min-w-0" value={model} onchange={(event) => selection = { provider, model: event.currentTarget.value }} aria-describedby="model-help legacy-help">
				{#each models as entry (entry.id)}
					<option value={entry.id}>{entry.label}</option>
				{/each}
			</select>
		</label>
		<p id="model-help" class="text-sm">The default remains OpenAI / GPT Transcribe. Providers are never switched automatically. ElevenLabs offers Scribe v2 Medical and Scribe v2.</p>
		<p id="legacy-help" class="text-sm">OpenAI models labelled legacy are deprecated and scheduled to shut down on February 26, 2027. Prefer a current model.</p>
		<noscript><p>Enable JavaScript to change providers and update the available model options.</p></noscript>
		<button class="btn btn-primary" type="submit">Save settings</button>
	</form>
</section>
