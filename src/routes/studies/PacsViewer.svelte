<script>
	import { invalidateAll } from '$app/navigation';
	import { pacsViewerLink } from '$lib/pacs-viewer.js';

	let { study, template, user } = $props();
	let error = $state('');
	let saving = $state(false);
	let enteringKey = $state(false);
	let key = $state('');
	const canSave = $derived(['admin', 'attending', 'resident'].includes(user?.role));
	const link = $derived(pacsViewerLink(template || '', study.study_key));
	const enteredLink = $derived(pacsViewerLink(template || '', key));

	async function saveKey(event) {
		if (saving || !enteredLink) {
			event.preventDefault();
			return;
		}
		error = '';
		if (!canSave) return;
		saving = true;
		try {
			const response = await fetch(`/api/studies/${study.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ study_key: key.trim() })
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Unable to save Study key.');
			await invalidateAll();
		} catch (caught) {
			error = `Study key was not saved: ${caught.message || 'Please try again.'}`;
		} finally {
			saving = false;
		}
	}
</script>

{#if template && !study.disabled}
	<div class="mb-2">
		{#if link}
			<!-- External PACS URLs are not application routes. -->
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<a class="btn btn-outline btn-xs" href={link} target="_blank" rel="noopener noreferrer">Open PACS</a>
		{:else if enteringKey}
			<div class="min-w-48 space-y-2">
				<label class="form-control">
					<span class="label-text">PACS Study key</span>
					<input class="input input-bordered input-sm" type="text" maxlength="128" bind:value={key} disabled={saving} />
				</label>
				<p class="text-xs">{canSave ? 'The key will be saved to this study.' : 'Temporary key; typists cannot save it.'}</p>
				<div class="flex gap-2">
					{#if enteredLink && !saving}
						<!-- External PACS URLs are not application routes. -->
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
						<a class="btn btn-outline btn-xs" href={enteredLink} target="_blank" rel="noopener noreferrer" onclick={saveKey}>Open PACS</a>
					{:else}
						<button class="btn btn-outline btn-xs" disabled>{saving ? 'Saving key…' : 'Open PACS'}</button>
					{/if}
					<button class="btn btn-ghost btn-xs" disabled={saving} onclick={() => { enteringKey = false; key = ''; error = ''; }}>Cancel</button>
				</div>
			</div>
		{:else}
			<button class="btn btn-outline btn-xs" onclick={() => { enteringKey = true; }}>Open PACS</button>
		{/if}
		{#if error}<p class="text-error text-xs" role="alert">{error}</p>{/if}
	</div>
{/if}
