<script>
	import { untrack } from 'svelte';
	import { studyLabel } from '$lib/study-label.js';
	import SearchableSelect from '$lib/components/SearchableSelect.svelte';
	import { resolve } from '$app/paths';
	import { invalidateAll } from '$app/navigation';
	let { study, categories, onClose, onSaved } = $props();
	let selected = $state(untrack(() => [...(study.favorite_category_ids ?? [])]));
	let busy = $state(false);
	let error = $state('');
	let createdCategories = $state([]);
	let name = $state('');
	let notice = $state('');
	const availableCategories = $derived([...categories, ...createdCategories.filter((created) => !categories.some((category) => category.id === created.id))]);
	const options = $derived(availableCategories.filter((category) => !selected.includes(category.id)).map((category) => ({ id: category.id, name: category.name || `Unnamed category #${category.id}` })));

	function showDialog(node) {
		node.showModal();
		return { destroy: () => node.close() };
	}

	function selectCategory(id) {
		if (!busy && id && !selected.includes(Number(id))) selected = [...selected, Number(id)];
	}

	async function createCategory() {
		if (busy) return;
		busy = true;
		error = '';
		notice = '';
		try {
			const response = await fetch('/api/favorite-categories', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Unable to create favorite category.');
			createdCategories = [...createdCategories, result];
			selected = [...selected, result.id];
			name = '';
			notice = 'Category created and selected. Save favorite to assign this study.';
			await invalidateAll();
		} catch (caught) { error = caught.message || 'Unable to create favorite category.'; }
		finally { busy = false; }
	}

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

<dialog aria-modal="true" aria-labelledby="favorite-study-title" class="modal" use:showDialog
	oncancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
	<form class="modal-box space-y-4" onsubmit={save}>
		<h3 id="favorite-study-title" class="text-lg font-bold">Favorite categories — {studyLabel(study)}</h3>
		<p>This study will be saved in your Favorites list. Optionally select one or more categories. Favorites and categories are private to your account.</p>
		<fieldset class="min-w-0 space-y-3" disabled={busy}>
			<legend class="font-semibold">Categories for this study</legend>
			<SearchableSelect label="Find a saved category" {options} emptyLabel="Type to search categories" resetOnSelect onSelect={selectCategory} />
			<p class="text-sm">Type a few letters, then select a category to add it. Selected categories stay visible below.</p>
			<ul class="space-y-2" aria-label="Selected categories">
				{#each selected as id (id)}
					{@const category = availableCategories.find((item) => item.id === id)}
					<li class="flex flex-wrap items-center gap-2">
						<span class="min-w-0 break-words">{category?.name || `Unnamed category #${id}`}</span>
						<button type="button" class="btn btn-xs btn-outline" aria-label={`Remove ${category?.name || `Unnamed category #${id}`} from this study`} onclick={() => { selected = selected.filter((value) => value !== id); }}>Remove</button>
					</li>
				{:else}<li class="text-sm">No categories selected. The study will still be saved to Favorites.</li>{/each}
			</ul>
			{#if !availableCategories.length}<p class="text-sm">No categories yet. Create one below, or save without a category.</p>{/if}
			<label class="form-control gap-1">
				<span class="label-text">New category name (optional)</span>
				<input class="input input-bordered w-full" maxlength="100" bind:value={name} onkeydown={(event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); createCategory(); } }} />
			</label>
			<button type="button" class="btn btn-sm btn-outline" onclick={createCategory}>Create and select category</button>
			<p class="text-sm">New categories are created immediately. Save favorite to apply the selected categories to this study.</p>
		</fieldset>
		<p role="status" class="text-sm">{notice}</p>
		{#if error}<p class="text-error" role="alert">{error}</p>{/if}
		<a class="link text-sm" href={resolve('/studies/favorites')}>Manage my study favorites</a>
		<div class="modal-action"><button type="button" class="btn" disabled={busy} onclick={onClose}>Cancel</button><button class="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save favorite'}</button></div>
	</form>
</dialog>
