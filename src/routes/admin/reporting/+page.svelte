<script>
	import { enhance } from '$app/forms';
	import { REPORT_GENERATION_MODES } from '$lib/report-generation-models.js';
	import { GPT_AUDIO_SUBSTITUTES, MAX_GPT_AUDIO_LIMIT_SECONDS } from '$lib/gpt-audio-settings.js';

	let { data, form } = $props();
	let selection = $state(null);
	let saving = $state(false);
	let mode = $derived(selection ?? form?.settings?.mode ?? data.settings.mode);
	let savingAudio = $state(false);
	let audioSelection = $state(null);
	let limitSelection = $state(null);
	let audio = $derived(form?.gptAudioSettings ?? data.gptAudioSettings);
	let limitSeconds = $derived(limitSelection ?? audio.limitSeconds);
	let substitute = $derived(audioSelection ?? (audio.substitute ? `${audio.substitute.provider}:${audio.substitute.model}` : ''));
</script>

<section class="w-full min-w-0 max-w-3xl space-y-4 break-words">
	<h1 class="text-2xl font-semibold">Reporting settings</h1>
	<p id="mode-help" class="text-sm">Applies to future processing only. Existing reports are unchanged.</p>
	{#if mode === 'direct_audio'}
		<p class="text-sm">Requires FFmpeg. Uses the shared GPT Audio total recording limit below.</p>
	{/if}
	<p class="text-sm">Review generated reports before signing.</p>
	{#if data.recoveryWarning}<div class="alert alert-warning" role="alert">{data.recoveryWarning}</div>{/if}
	{#if !data.configured.openai}
		<div class="alert alert-warning" role="alert">OPENAI_API_KEY is missing. Report generation is unavailable.</div>
	{/if}
	{#if form?.error && form.section !== 'gpt_audio'}<div class="alert alert-error" role="alert">{form.error}</div>{/if}
	{#if form?.success && form.section !== 'gpt_audio'}<div class="alert alert-success" role="status">Reporting settings saved.</div>{/if}
	<form method="POST" aria-busy={saving} use:enhance={() => {
		saving = true;
		return async ({ result, update }) => {
			try {
				await update();
				if (result.type === 'success') selection = null;
			} finally {
				saving = false;
			}
		};
	}} class="min-w-0 space-y-4">
		<label class="form-control min-w-0" for="reporting-mode">
			<span class="label-text">Reporting mode</span>
		</label>
		<select id="reporting-mode" name="mode" class="select select-bordered w-full min-w-0 max-w-full" value={mode} onchange={(event) => selection = event.currentTarget.value} aria-describedby="mode-help" disabled={saving}>
			{#each REPORT_GENERATION_MODES as entry (entry.id)}
				<option value={entry.id}>{entry.label}</option>
			{/each}
		</select>
		<button class="btn btn-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
	</form>

	<h2 class="text-xl font-semibold">GPT Audio duration policy</h2>
	<p id="audio-help" class="text-sm">For future direct reporting and GPT Audio transcription. Only above the total limit, substitute the entire recording, then generate with gpt-6.1-sol. Disabled substitution stops over-limit processing; never truncates audio. Primary transcription selection is unchanged.</p>
	{#if data.gptAudioRecoveryWarning}<div class="alert alert-warning" role="alert">{data.gptAudioRecoveryWarning}</div>{/if}
	{#if substitute.startsWith('elevenlabs:') && !data.configured.elevenlabs}
		<div class="alert alert-warning" role="alert">ELEVENLABS_API_KEY is missing. The selected substitute is unavailable when the limit is exceeded.</div>
	{/if}
	{#if form?.section === 'gpt_audio' && form.error}<div class="alert alert-error" role="alert">{form.error}</div>{/if}
	{#if form?.section === 'gpt_audio' && form.success}<div class="alert alert-success" role="status">GPT Audio settings saved.</div>{/if}
	<form method="POST" aria-busy={savingAudio} use:enhance={() => {
		savingAudio = true;
		return async ({ result, update }) => {
			try {
				await update();
				if (result.type === 'success') {
					audioSelection = null;
					limitSelection = null;
				}
			} finally {
				savingAudio = false;
			}
		};
	}} class="min-w-0 space-y-4">
		<input type="hidden" name="section" value="gpt_audio" />
		<label class="form-control min-w-0" for="gpt-audio-limit">
			<span class="label-text">Total recording limit (seconds)</span>
		</label>
		<input id="gpt-audio-limit" name="limitSeconds" type="number" min="1" max={MAX_GPT_AUDIO_LIMIT_SECONDS} step="1" required value={limitSeconds} oninput={(event) => limitSelection = event.currentTarget.value} aria-describedby="audio-help" class="input input-bordered w-full" disabled={savingAudio} />
		<label class="form-control min-w-0" for="gpt-audio-substitute">
			<span class="label-text">Over-limit transcription substitute</span>
		</label>
		<select id="gpt-audio-substitute" name="substitute" value={substitute} onchange={(event) => audioSelection = event.currentTarget.value} aria-describedby="audio-help" class="select select-bordered w-full min-w-0 max-w-full" disabled={savingAudio}>
			<option value="">Disabled (stop processing above the limit)</option>
			{#each GPT_AUDIO_SUBSTITUTES as provider (provider.id)}
				<optgroup label={provider.label}>
					{#each provider.models as model (model.id)}
						<option value={`${provider.id}:${model.id}`}>{model.label}</option>
					{/each}
				</optgroup>
			{/each}
		</select>
		<button class="btn btn-primary" type="submit" disabled={savingAudio}>{savingAudio ? 'Saving…' : 'Save GPT Audio settings'}</button>
	</form>
</section>
