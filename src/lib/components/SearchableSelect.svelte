<script>
	import { filterSearchOptions } from '$lib/search-options.js';

	let { label, options, value = $bindable(''), name, emptyLabel = 'All', compact = false, resetOnSelect = false, onSelect } = $props();
	const id = $props.id();
	let query = $state('');
	const matches = $derived(filterSearchOptions(options, query));
	const selected = $derived(options.find((option) => String(option.id) === String(value)));
	const retained = $derived(selected && !matches.includes(selected) ? selected : null);

	function select(event) {
		const selectedValue = event.currentTarget.value;
		value = resetOnSelect ? '' : selectedValue;
		event.currentTarget.value = value;
		onSelect?.(selectedValue);
	}
</script>

<div class="form-control min-w-0 gap-1">
	<label class="label-text text-sm" for={id}>{label}</label>
	<input
		type="search"
		class={compact ? 'input input-bordered input-sm h-9 w-full min-w-0' : 'input input-bordered w-full min-w-0'}
		aria-label={`Search ${label}`}
		placeholder="Search code or name…"
		autocomplete="off"
		bind:value={query}
		onkeydown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
	/>
	<span class="text-xs opacity-70" role="status">{query.trim() ? `${matches.length} matching options` : 'Type above to narrow the list'}</span>
	<select
		{id}
		{name}
		class={compact ? 'select select-sm h-9 w-full min-w-0 leading-normal' : 'select select-bordered w-full min-w-0'}
		{value}
		onchange={select}
	>
		<option value="">{emptyLabel}</option>
		{#if retained}<option value={String(retained.id)}>{retained.code} — {retained.name} (current selection)</option>{/if}
		{#each matches as option (option.id)}
			<option value={String(option.id)}>{option.code} — {option.name}</option>
		{/each}
		{#if !matches.length}<option disabled>No matching options</option>{/if}
	</select>
</div>
