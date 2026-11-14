<script>
	import { onDestroy } from 'svelte';
	let { study, recording, user, disabled = false, busy = $bindable(false) } = $props();
	let text = $state('');
	let error = $state('');
	let controller;
	const unavailable = $derived(disabled || Boolean(study.disabled) || Boolean(recording.processing) || !(recording.audio_parts?.length || recording.audio_report_path));
	onDestroy(() => controller?.abort());

	async function transcribe() {
		if (user?.role !== 'admin' || busy || unavailable) return;
		busy = true;
		error = '';
		text = '';
		controller = new AbortController();
		try {
			const response = await fetch(`/api/studies/${study.id}/recordings/${recording.id}/transcribe-only`, {
				method: 'POST', signal: controller.signal
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(result.error || 'Transcription failed');
			text = result.text;
		} catch (caught) {
			if (caught.name !== 'AbortError') error = caught.message || 'Transcription failed';
		} finally {
			busy = false;
		}
	}
</script>

{#if user?.role === 'admin'}
	<section class="space-y-2" aria-label="Transcription preview" aria-busy={busy}>
		<button class="btn btn-sm btn-outline" disabled={busy || unavailable} onclick={transcribe}>{busy ? 'Transcribing…' : 'Transcribe only'}</button>
		{#if busy}<p class="text-sm" role="status">Transcribing audio without generating or changing the report…</p>{/if}
		{#if error}<p class="text-sm text-error" role="alert">{error}</p>{/if}
		{#if text}
			<label class="form-control gap-1">
				<span class="label-text">Transcription output · preview only, not saved</span>
				<textarea class="textarea textarea-bordered min-h-40 w-full" aria-label="Transcription output" dir="auto" readonly value={text}></textarea>
			</label>
		{/if}
	</section>
{/if}
