<script>
	import { enhance } from '$app/forms';
	import { DIRECT_AUDIO_MODEL, REPORT_GENERATION_MODES } from '$lib/report-generation-models.js';

	let { data, form } = $props();
	let selection = $state(null);
	let saving = $state(false);
	let mode = $derived(selection ?? form?.settings?.mode ?? data.settings.mode);
</script>

<section class="w-full min-w-0 max-w-3xl space-y-4 break-words">
	<h1 class="text-2xl font-semibold">Reporting settings</h1>
	<p>Choose how future report processing uses recordings. Changing the selection does nothing until you explicitly Save settings.</p>
	<p id="pipeline-help">Transcribe, then generate remains the default: audio is transcribed using the existing Transcription settings (OpenAI or ElevenLabs), then the fixed gpt-6.1-sol step generates the report.</p>
	<p id="direct-help">Direct audio sends all ordered audio parts, templates, and the assigned attending's English preference directly to OpenAI {DIRECT_AUDIO_MODEL} for text output only. It skips separate OpenAI/ElevenLabs transcription and the fixed gpt-6.1-sol report step. Transcription settings are retained for the transcription pipeline.</p>
	<p>Direct audio is experimental; accuracy is not guaranteed. Review generated reports before signing. Both modes require OPENAI_API_KEY, configured on the server, not on this page.</p>
	<p>Direct audio supports a maximum of 10 minutes of total audio per report. Over-limit recordings produce a safe error, with no automatic fallback. Docker installs ffmpeg automatically; non-Docker deployments need ffmpeg on PATH or FFMPEG_PATH configured.</p>
	<p id="scope-help">Saved changes affect future processing only. There is no automatic fallback or regeneration. Signed reports and existing clinical permissions remain unchanged.</p>
	{#if data.recoveryWarning}<div class="alert alert-warning" role="alert">{data.recoveryWarning}</div>{/if}
	{#if !data.configured.openai}
		<div class="alert alert-warning" role="alert">OPENAI_API_KEY is missing. Report generation is unavailable in both modes. You may save now and configure the key later.</div>
	{/if}
	{#if form?.error}<div class="alert alert-error" role="alert">{form.error}</div>{/if}
	{#if form?.success}<div class="alert alert-success" role="status">Reporting settings saved.</div>{/if}
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
		<select id="reporting-mode" name="mode" class="select select-bordered w-full min-w-0 max-w-full" value={mode} onchange={(event) => selection = event.currentTarget.value} aria-describedby="pipeline-help direct-help scope-help" disabled={saving}>
			{#each REPORT_GENERATION_MODES as entry (entry.id)}
				<option value={entry.id}>{entry.label}</option>
			{/each}
		</select>
		<button class="btn btn-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
	</form>
</section>
