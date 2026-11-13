<script>
	let { text = '-' } = $props();
	const expandable = $derived(text.length > 140 || text.includes('\n'));
</script>

{#if expandable}
	<details class="study-description">
		<summary>
			<span class="description-preview" dir="auto">{text}</span>
			<span class="description-toggle show-label">Show full description</span>
			<span class="description-toggle hide-label">Hide full description</span>
		</summary>
		<p class="description-full" dir="auto">{text}</p>
	</details>
{:else}
	<span class="description-full" dir="auto">{text}</span>
{/if}

<style>
	.study-description,
	.description-full {
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	summary {
		cursor: pointer;
		list-style: none;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	summary:focus-visible {
		outline: 2px solid currentColor;
		outline-offset: 3px;
	}

	.description-preview {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
		overflow: hidden;
	}

	.description-toggle {
		display: block;
		margin-top: 0.25rem;
		font-size: 0.75rem;
		text-decoration: underline;
	}

	.hide-label,
	.study-description[open] .show-label,
	.study-description[open] .description-preview {
		display: none;
	}

	.study-description[open] .hide-label {
		display: block;
	}

	.description-full {
		margin: 0.25rem 0 0;
	}
</style>
