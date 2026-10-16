<script>
	import { onMount } from 'svelte';
	import { studyLabel } from '$lib/study-label.js';
	let { study, onClose, onDeleted } = $props();
	let detail = $state(null);
	let loading = $state(true);
	let busy = $state(false);
	let confirmed = $state(false);
	let error = $state('');

	async function refresh() {
		loading = true;
		detail = null;
		error = '';
		confirmed = false;
		try {
			const response = await fetch(`/api/studies/${study.id}`);
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Unable to check linked voices.');
			detail = result;
		} catch (caught) { error = caught.message; }
		finally { loading = false; }
	}
	onMount(() => { refresh(); });

	async function remove() {
		if (busy || loading || !detail || (detail.telegram_voice_count && !confirmed)) return;
		busy = true;
		error = '';
		try {
			const response = await fetch(`/api/studies/${study.id}`, {
				method: 'DELETE', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ confirm_voices: confirmed, telegram_voice_count: detail.telegram_voice_count })
			});
			const result = await response.json();
			if (!response.ok) {
				if (response.status === 409) await refresh();
				throw new Error(result.error || 'Delete failed');
			}
			await onDeleted(result);
		} catch (caught) { error = caught.message || 'Delete failed'; }
		finally { busy = false; }
	}
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape' && !busy) onClose(); }} />
<div class="modal modal-open">
	<div role="dialog" aria-modal="true" aria-labelledby="delete-study-title" class="modal-box space-y-4">
		<h3 id="delete-study-title" class="text-lg font-bold">Delete study — {studyLabel(study)}</h3>
		<p>Delete this study and all its recordings and reports? This cannot be undone.</p>
		<p class="text-sm">The linked Telegram study message and voices will also be removed. If Telegram cannot delete any message (for example, its time limit or missing permissions), the study stays on the website as disabled and read-only. The remaining study message is marked disabled where possible, and new voice replies are not processed.</p>
		{#if loading}<p role="status">Checking linked Telegram voices…</p>
		{:else if detail}
			<p>{detail.recording_count} recordings · {detail.telegram_voice_count} linked Telegram voice/audio messages remaining.</p>
			{#if detail.telegram_voice_count}
				<label class="flex items-start gap-2"><input type="checkbox" class="checkbox checkbox-error" bind:checked={confirmed} disabled={busy} /><span>I confirm deletion of all {detail.telegram_voice_count} linked Telegram voice/audio messages.</span></label>
			{/if}
		{/if}
		{#if error}<p role="alert" class="text-error">{error}</p><button class="btn btn-sm btn-outline" disabled={busy || loading} onclick={refresh}>Recheck linked voices</button>{/if}
		<div class="modal-action">
			<button class="btn" disabled={busy} onclick={onClose}>Cancel</button>
			<button class="btn btn-error" disabled={busy || loading || !detail || (detail.telegram_voice_count > 0 && !confirmed)} onclick={remove}>{busy ? 'Deleting…' : 'Delete study and Telegram messages'}</button>
		</div>
	</div>
</div>
