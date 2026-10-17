<script>
	import { enhance } from '$app/forms';
	let { data, form } = $props();
</script>

<svelte:head><title>PACS viewer settings</title></svelte:head>

<section class="max-w-3xl space-y-4">
	<h1 class="text-2xl font-semibold">PACS viewer settings</h1>
	<p>Studies open directly in the user's browser. Each user signs in to PACS there; no PACS credentials are stored here.</p>
	{#if form?.error}<div class="alert alert-error" role="alert">{form.error}</div>{/if}
	{#if form?.success}<div class="alert alert-success" role="status">PACS viewer settings saved.</div>{/if}
	<form method="POST" use:enhance class="space-y-4">
		<label class="form-control">
			<span class="label-text">Viewer URL template</span>
			<input class="input input-bordered w-full" type="text" name="viewerUrl" maxlength="2048" value={form?.viewerUrl ?? data.viewerUrl} aria-describedby="viewer-help" />
		</label>
		<p id="viewer-help" class="text-sm">Include <code>{'{studyKey}'}</code> where the study key belongs. Leave blank to hide viewer links. Missing study keys are requested when opening a study.</p>
		<button class="btn btn-primary" type="submit">Save settings</button>
	</form>
</section>
