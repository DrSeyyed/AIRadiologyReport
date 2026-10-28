<script>
	import { enhance } from '$app/forms';
	import { REPORT_GENERATION_MODES } from '$lib/report-generation-models.js';

	let { data, form } = $props();
	let selection = $state(null);
	let saving = $state(false);
	let mode = $derived(selection ?? form?.settings?.mode ?? data.settings.mode);
</script>

<section class="w-full min-w-0 max-w-3xl space-y-4 break-words">
	<h1 class="text-2xl font-semibold">Reporting settings</h1>
	<p id="mode-help" class="text-sm">Applies to future processing only. Existing reports are unchanged.</p>
	{#if mode === 'direct_audio'}
		<p class="text-sm">Requires FFmpeg. Maximum 10 minutes of total audio per report.</p>
	{/if}
	<p class="text-sm">Review generated reports before signing.</p>
	{#if data.recoveryWarning}<div class="alert alert-warning" role="alert">{data.recoveryWarning}</div>{/if}
	{#if !data.configured.openai}
		<div class="alert alert-warning" role="alert">OPENAI_API_KEY is missing. Report generation is unavailable.</div>
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
		<select id="reporting-mode" name="mode" class="select select-bordered w-full min-w-0 max-w-full" value={mode} onchange={(event) => selection = event.currentTarget.value} aria-describedby="mode-help" disabled={saving}>
			{#each REPORT_GENERATION_MODES as entry (entry.id)}
				<option value={entry.id}>{entry.label}</option>
			{/each}
		</select>
		<button class="btn btn-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
	</form>
</section>
