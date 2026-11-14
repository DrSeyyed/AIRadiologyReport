<script>
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	let { data } = $props();
	let name = $state('');
	let busy = $state(false);
	let error = $state('');

	async function change(method, id, value) {
		if (busy) return;
		if (method === 'DELETE' && !confirm('Delete this category? Its studies will remain in your Favorites list.')) return;
		busy = true;
		error = '';
		try {
			const response = await fetch(`/api/favorite-categories${id ? `/${id}` : ''}`, {
				method,
				...(method === 'DELETE' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: value }) })
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Unable to update favorite categories.');
			if (method === 'POST') name = '';
			await invalidateAll();
		} catch (caught) { error = caught.message || 'Unable to update favorite categories.'; }
		finally { busy = false; }
	}
</script>

<section class="space-y-4" aria-labelledby="favorite-categories-title">
	<h2 id="favorite-categories-title" class="text-xl font-semibold">Manage categories</h2>
	<a class="link" href={resolve('/studies?favorites=all')}>View all favorite studies ({data.favorites.total})</a>
	<div class="space-y-4">
		<p class="text-sm">Favorites and categories are private to your account. A study can belong to multiple categories. Names are optional; deleting a category keeps its studies in Favorites.</p>
		<form class="flex flex-wrap items-end gap-2" onsubmit={(event) => { event.preventDefault(); change('POST', null, name); }}>
			<label class="form-control"><span class="label-text">New category name (optional)</span><input class="input input-bordered input-sm" maxlength="100" bind:value={name} disabled={busy} /></label>
			<button class="btn btn-sm" disabled={busy}>Add category</button>
		</form>
		{#each data.favorites.categories as category (category.id)}
			<form class="flex flex-wrap items-end gap-2" onsubmit={(event) => { event.preventDefault(); change('PATCH', category.id, new FormData(event.currentTarget).get('name')); }}>
				<label class="form-control"><span class="label-text">{category.name || `Unnamed category #${category.id}`} ({category.total})</span><input class="input input-bordered input-sm" name="name" aria-label={`Name for category ${category.id}`} maxlength="100" value={category.name} disabled={busy} /></label>
				<button class="btn btn-sm btn-outline" disabled={busy}>Rename</button>
				<button type="button" class="btn btn-sm btn-outline btn-error" disabled={busy} onclick={() => change('DELETE', category.id)}>Delete category</button>
				<a class="link text-sm" href={resolve(`/studies?favorites=${category.id}`)}>View studies in {category.name || `Unnamed category #${category.id}`}</a>
			</form>
		{:else}<p class="text-sm">No categories yet. Studies can be saved directly to Favorites.</p>{/each}
		{#if error}<p role="alert" class="text-error">{error}</p>{/if}
	</div>
</section>

<style>
	section,
	form {
		min-width: 0;
		max-width: 100%;
	}

	label {
		width: 16rem;
		min-width: 0;
		max-width: 100%;
	}

	input {
		width: 100%;
		min-width: 0;
		max-width: 100%;
	}
</style>
