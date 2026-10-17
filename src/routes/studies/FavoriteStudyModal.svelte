<script>
	import { untrack } from 'svelte';
	import { studyLabel } from '$lib/study-label.js';
	let { study, categories, onClose, onSaved } = $props();
	let selected = $state(untrack(() => [...(study.favorite_category_ids ?? [])]));
	let busy = $state(false);
	let error = $state('');

	async function save(event) {
		event.preventDefault();
		if (busy) return;
		busy = true;
		error = '';
		try {
			const response = await fetch(`/api/study-favorites/${study.id}`, {
				method: 'PUT', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ category_ids: selected })
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Unable to save favorite categories.');
			await onSaved();
		} catch (caught) { error = caught.message || 'Unable to save favorite categories.'; }
		finally { busy = false; }
	}
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape' && !busy) onClose(); }} />
<div class="modal modal-open">
	<form role="dialog" aria-modal="true" aria-labelledby="favorite-study-title" class="modal-box space-y-4" onsubmit={save}>
		<h3 id="favorite-study-title" class="text-lg font-bold">Favorite categories — {studyLabel(study)}</h3>
		<p>This study will be saved in your Favorites list. Optionally select one or more categories.</p>
		<div class="space-y-2">
			{#each categories as category (category.id)}
				<label class="flex items-center gap-2"><input class="checkbox checkbox-sm" type="checkbox" value={category.id} bind:group={selected} disabled={busy} /><span>{category.name || `Unnamed category #${category.id}`}</span></label>
			{:else}<p>No categories yet. Use “My study favorites — manage categories” to create them.</p>{/each}
		</div>
		{#if error}<p class="text-error" role="alert">{error}</p>{/if}
		<div class="modal-action"><button type="button" class="btn" disabled={busy} onclick={onClose}>Cancel</button><button class="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save favorite'}</button></div>
	</form>
</div>
