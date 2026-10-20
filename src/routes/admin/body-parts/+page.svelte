<script>
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	let { data, form } = $props();
	let busy = $state(false);
	const selected = $derived(form?.values?.id !== undefined ? form.values : data.selected);
</script>


<section class="mx-auto min-w-0 max-w-4xl space-y-4">
	<h1 class="text-2xl font-semibold">Manage body parts</h1>
	<p>These entries populate the examination / body-part lists throughout the website. Include the contrast type when it distinguishes examinations.</p>
	<p>After adding an entry, create a <a class="link link-primary" href={resolve('/admin/templates')}>report template</a> for each modality you use with it.</p>
	{#if form?.error}<div class="alert alert-error" role="alert">{form.error}</div>{/if}
	{#if form?.success}<div class="alert alert-success" role="status">{form.message}</div>{/if}
	<div class="min-w-0 rounded-box border bg-base-100 p-4 space-y-3">
		<h2 class="text-lg font-semibold">{selected ? 'Edit body part' : 'Add body part'}</h2>
		{#if selected}<p class="text-sm">Changes update labels for existing recordings and templates. Saved report text and signatures are not modified.</p>{/if}
		<form method="POST" action={selected ? '?/update' : '?/create'} use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				try { await update(); } finally { busy = false; }
			};
		}}>
			<fieldset disabled={busy} class="min-w-0 space-y-3">
				{#if selected}<input type="hidden" name="id" value={selected.id} />{/if}
				<label class="form-control min-w-0">
					<span class="label-text">Code</span>
					<input class="input input-bordered w-full min-w-0" name="code" required maxlength="64" value={form?.values?.code ?? selected?.code ?? ''} placeholder="e.g. WRIST_WO" aria-describedby="body-part-code-help" />
				</label>
				<p id="body-part-code-help" class="text-sm">A unique short code, up to 64 characters. Codes are case-sensitive.</p>
				<label class="form-control min-w-0">
					<span class="label-text">Name</span>
					<input class="input input-bordered w-full min-w-0" name="name" required maxlength="200" value={form?.values?.name ?? selected?.name ?? ''} placeholder="e.g. Wrist without contrast" />
				</label>
				<div class="flex flex-wrap gap-2">
					<button class="btn btn-primary" type="submit">{busy ? 'Saving…' : selected ? 'Save changes' : 'Add body part'}</button>
					{#if selected}<a class="btn btn-outline" href={resolve('/admin/body-parts')}>Cancel / add new</a>{/if}
				</div>
			</fieldset>
		</form>
	</div>
	<h2 class="text-lg font-semibold">Existing body parts ({data.bodyParts.length})</h2>
	<div class="min-w-0 overflow-x-auto rounded-box border">
		<table class="table table-sm">
			<thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Actions</th></tr></thead>
			<tbody>
				{#each data.bodyParts as row (row.id)}
					<tr>
						<td class="break-words">{row.code}</td>
						<td class="break-words">{row.name}</td>
						<td><a class="btn btn-sm btn-outline" aria-label={`Edit ${row.name}`} href={resolve(`/admin/body-parts?edit=${row.id}`)}>Edit</a></td>
					</tr>
				{:else}<tr><td colspan="3">No body parts yet. Add the first entry above.</td></tr>{/each}
			</tbody>
		</table>
	</div>
</section>
