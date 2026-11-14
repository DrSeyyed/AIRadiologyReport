<script>
	import { enhance } from '$app/forms';
	let { data, form } = $props();
</script>


<section class="w-full min-w-0 max-w-3xl space-y-4">
	<h1 class="page-title">PACS viewer settings</h1>
	<p class="text-sm text-base-content/70">Configure how studies open in the PACS viewer.</p>
	{#if form?.error}<div class="alert alert-error" role="alert">{form.error}</div>{/if}
	{#if form?.success}<div class="alert alert-success" role="status">PACS viewer settings saved.</div>{/if}
	<div class="min-w-0 space-y-4 rounded-box border border-base-300 bg-base-100 p-4">
	<h2 class="section-title">Viewer connection</h2>
	<form method="POST" use:enhance class="space-y-4">
		<label class="form-control">
			<span class="label-text">Viewer URL template</span>
			<input class="input input-bordered w-full" type="text" name="viewerUrl" maxlength="2048" value={form?.viewerUrl ?? data.viewerUrl} aria-describedby="viewer-help" />
		</label>
		<p id="viewer-help" class="text-sm">Include <code>{'{studyKey}'}</code> where the study key belongs. Leave blank to hide viewer links.</p>
		<details class="text-sm">
			<summary class="cursor-pointer font-medium">How viewer links work</summary>
			<p class="mt-2">Studies open directly in the user's browser. Each user signs in to PACS there; no PACS credentials are stored here. Missing study keys are requested when opening a study.</p>
		</details>
		<button class="btn btn-primary" type="submit">Save settings</button>
	</form>
	</div>
</section>
