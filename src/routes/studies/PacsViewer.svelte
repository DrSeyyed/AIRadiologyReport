<script>
	import { pacsViewerLink } from '$lib/pacs-viewer.js';

	let { study, template } = $props();
	let error = $state('');
	const link = $derived(pacsViewerLink(template || '', study.study_key));

	function openViewer() {
		error = '';
		const key = window.prompt('Enter the PACS Study key (used only to open the viewer; not saved):');
		if (key === null) return;
		const url = pacsViewerLink(template, key);
		if (!url) {
			error = 'Enter a Study key of 1–128 characters.';
			return;
		}
		window.open(url, '_blank', 'noopener,noreferrer');
	}
</script>

{#if template && !study.disabled}
	<div class="mb-2">
		{#if link}
			<!-- External PACS URLs are not application routes. -->
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<a class="btn btn-outline btn-xs" href={link} target="_blank" rel="noopener noreferrer">Open PACS</a>
		{:else}
			<button class="btn btn-outline btn-xs" onclick={openViewer}>Open PACS</button>
		{/if}
		{#if error}<p class="text-error text-xs" role="alert">{error}</p>{/if}
	</div>
{/if}
