<script>
	import { invalidateAll } from '$app/navigation';
	import { pacsViewerLink } from '$lib/pacs-viewer.js';

	let { study, template, user } = $props();
	let error = $state('');
	let saving = $state(false);
	const canSave = $derived(['admin', 'attending', 'resident'].includes(user?.role));
	const link = $derived(pacsViewerLink(template || '', study.study_key));

	async function openViewer() {
		if (saving) return;
		error = '';
		const key = window.prompt(canSave
			? 'Enter the PACS Study key (saved to this study):'
			: 'Enter the PACS Study key (used only to open the viewer; not saved):');
		if (key === null) return;
		const url = pacsViewerLink(template, key);
		if (!url) {
			error = 'Enter a Study key of 1–128 characters.';
			return;
		}
		window.open(url, '_blank', 'noopener,noreferrer');
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
		{:else}
			<button class="btn btn-outline btn-xs" disabled={saving} onclick={openViewer}>{saving ? 'Saving key…' : 'Open PACS'}</button>
		{/if}
		{#if error}<p class="text-error text-xs" role="alert">{error}</p>{/if}
	</div>
{/if}
