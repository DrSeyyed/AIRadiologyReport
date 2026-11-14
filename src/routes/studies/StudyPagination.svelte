<script>
	import { page } from '$app/state';
	import { resolve } from '$app/paths';

	let { paging, position, inline = false } = $props();
	const preserved = $derived([...page.url.searchParams].filter(([key]) => key !== 'page' && key !== 'rowcount'));

	function changePage(event) {
		const form = event.currentTarget.form;
		if (event.currentTarget.name === 'rowcount') form.elements.namedItem('page').value = '1';
		form.requestSubmit();
	}
</script>

<nav class="study-pagination" class:inline aria-label={`Study pagination ${position}`}>
	<form method="GET" action={resolve('/studies')}>
		{#each preserved as [name, value], index (index)}
			<input type="hidden" {name} {value} />
		{/each}
		<label>
			<span>Records per page</span>
			<select name="rowcount" class="select select-bordered select-sm" value={String(paging.rowcount ?? 20)} onchange={changePage}>
				{#each [10, 20, 50, 100] as count (count)}<option value={String(count)}>{count}</option>{/each}
			</select>
		</label>
		<label>
			<span>Page</span>
			<select name="page" class="select select-bordered select-sm" value={String(paging.page ?? 1)} onchange={changePage}>
				{#each Array.from({ length: paging.totalPages || 1 }, (_, i) => i + 1) as number (number)}<option value={String(number)}>{number}</option>{/each}
			</select>
			<span>of {paging.totalPages || 1}</span>
		</label>
		<button type="submit" class="btn btn-sm btn-ghost">Go</button>
	</form>
</nav>

<style>
	.study-pagination { padding: 0.75rem 1rem; border-top: 1px solid #e2e8f0; }
	.study-pagination.inline { padding: 0; border-top: 0; }
	.inline form { gap: 0.5rem; }
	.inline label { gap: 0.375rem; font-size: 0.6875rem; }
	.inline select { min-width: 3.5rem; padding-left: 0.5rem; padding-right: 1.5rem; }
	.inline .btn { padding-left: 0.5rem; padding-right: 0.5rem; font-size: 0.6875rem; }
	form { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 0.75rem; }
	label { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; min-width: 0; max-width: 100%; font-size: 0.75rem; color: #475569; }
	select { min-width: 4.5rem; max-width: 100%; height: 2rem; border: 1px solid #cbd5e1; }
</style>
