<script>
	import { invalidateAll } from '$app/navigation';
	let { study, onCategories } = $props();
	let busy = $state(false);
	let error = $state('');

	async function toggle() {
		if (busy) return;
		busy = true;
		error = '';
		try {
			const response = await fetch(`/api/study-favorites/${study.id}`, {
				method: study.is_favorite ? 'DELETE' : 'PUT',
				...(study.is_favorite ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category_ids: [] }) })
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Unable to update favorite.');
			await invalidateAll();
		} catch (caught) { error = caught.message || 'Unable to update favorite.'; }
		finally { busy = false; }
	}
</script>

<div class="flex flex-col items-start gap-1">
	<button class="btn btn-sm btn-outline" aria-pressed={study.is_favorite} aria-label={`${study.is_favorite ? 'Remove' : 'Add'} ${study.patient_code} ${study.is_favorite ? 'from' : 'to'} favorites`} disabled={busy} onclick={toggle}>{study.is_favorite ? '★ Saved' : '☆ Favorite'}</button>
	<button class="btn btn-xs btn-ghost" aria-label={`Choose favorite categories for ${study.patient_code}`} disabled={busy} onclick={() => onCategories(study)}>Categories{study.favorite_category_ids?.length ? ` (${study.favorite_category_ids.length})` : ''}</button>
	{#if error}<p class="text-error text-sm" role="alert">{error}</p>{/if}
</div>

<style>
	button {
		white-space: nowrap;
		width: max-content;
	}
</style>
