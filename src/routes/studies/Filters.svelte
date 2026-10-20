<script>
	import { patientName } from '$lib/patient-name.js';
	import { examinationDateRange, studyDatePresets } from '$lib/study-date-ranges.js';
	import { studySortOptions } from '$lib/study-sorting.js';
	import SearchableSelect from '$lib/components/SearchableSelect.svelte';

	let { data } = $props();
	let dateRange = $state('');
	let dateFrom = $state('');
	let dateTo = $state('');
	$effect(() => {
		dateRange = data.filters.date_range || '';
		dateFrom = data.filters.date_from || '';
		dateTo = data.filters.date_to || '';
	});

	function selectDateRange(event) {
		dateRange = event.currentTarget.value;
		const range = examinationDateRange(dateRange);
		dateFrom = range?.date_from || '';
		dateTo = range?.date_to || '';
	}

	function applyFilters(e) {
		const fd = new FormData(e.currentTarget);
		const params = new URLSearchParams();
		for (const [k, v] of fd.entries()) {
			if (v) params.set(k, v);
		}
		const current = { ...data.filters, ...data.paging };
		if (['favorites', 'date_range', 'date_from', 'date_to', 'orderedby', 'orderdir', 'rowcount'].some((key) => (params.get(key) || '') !== String(current[key] ?? '')))
			params.set('page', '1');
		const url = `/studies?${params.toString()}`;
		window.location.href = url; // server-side load to refetch
	}
</script>

<div class="min-w-0 w-full">
	<form
		class="flex flex-wrap items-end gap-3"
		onsubmit={(e) => {
			e.preventDefault();
			applyFilters(e); // your existing function that reads FormData and updates the URL
		}}
	>
		<label class="form-control w-56">
			<span class="label-text mb-1 text-sm">My favorites</span>
			<select name="favorites" class="select select-sm h-9" value={data.filters.favorites ?? ''}>
				<option value="">All studies</option>
				<option value="all">All favorites ({data.favorites.total})</option>
				{#each data.favorites.categories as category (category.id)}
					<option value={String(category.id)}>{category.name || `Unnamed category #${category.id}`} ({category.total})</option>
				{/each}
			</select>
		</label>
		<input type="hidden" name="status" value={data.filters.status || ''} />
		<!-- Patient Code -->
		<label class="form-control w-48">
			<span class="label-text mb-1 text-sm">Patient Code</span>
			<input
				name="patient_code"
				class="input-bordered input input-sm h-9"
				value={data.filters.patient_code}
				placeholder="e.g., 157626"
			/>
		</label>

		<!-- Patient Full Name -->
		<label class="form-control w-48">
			<span class="label-text mb-1 text-sm">Full name</span>
			<input
				name="patient_fullname"
				class="input-bordered input input-sm h-9"
				value={patientName(data.filters)}
				placeholder="e.g., Ali Ahmadi"
			/>
		</label>

		<div class="w-48 max-w-full">
			<SearchableSelect label="Modality" name="modality_id" options={data.modalities} value={String(data.filters.modality_id || '')} compact />
		</div>

		<div class="w-48 max-w-full">
			<SearchableSelect label="Exam Type" name="exam_type_id" options={data.exam_types} value={String(data.filters.exam_type_id || '')} compact />
		</div>

		<label class="form-control w-56">
			<span class="label-text mb-1 text-sm">Examination date</span>
			<select name="date_range" class="select select-sm h-9" value={dateRange} onchange={selectDateRange}>
				<option value="">All dates / custom range</option>
				{#each studyDatePresets as preset (preset.value)}
					<option value={preset.value}>{preset.label}</option>
				{/each}
			</select>
		</label>

		<!-- Date From -->
		<label class="form-control w-32">
			<span class="label-text mb-1 text-sm">From (Jalali)</span>
			<input
				name="date_from"
				class="input-bordered input input-sm h-9"
				bind:value={dateFrom}
				oninput={() => (dateRange = '')}
				placeholder="1403-01-01"
			/>
		</label>

		<!-- Date To -->
		<label class="form-control w-32">
			<span class="label-text mb-1 text-sm">To (Jalali)</span>
			<input
				name="date_to"
				class="input-bordered input input-sm"
				bind:value={dateTo}
				oninput={() => (dateRange = '')}
				placeholder="1403-12-29"
			/>
		</label>

		<label class="form-control w-48 max-w-full">
			<span class="label-text mb-1 text-sm">Attending</span>
			<select name="corresponding_attending_id" class="select select-sm h-9" value={data.filters.corresponding_attending_id ? Number(data.filters.corresponding_attending_id) : ''}>
				<option value="">All</option>
				{#each data.attendings as attending (attending.id)}
					<option value={attending.id}>{attending.full_name}</option>
				{/each}
			</select>
		</label>
		<label class="form-control w-48 max-w-full">
			<span class="label-text mb-1 text-sm">Resident</span>
			<select name="corresponding_resident_id" class="select select-sm h-9" value={data.filters.corresponding_resident_id ? Number(data.filters.corresponding_resident_id) : ''}>
				<option value="">All</option>
				{#each data.residents as resident (resident.id)}
					<option value={resident.id}>{resident.full_name}</option>
				{/each}
			</select>
		</label>

		{#each ['resident', 'attending', 'typist'] as role (role)}
			<label class="form-control w-40 max-w-full">
				<span class="label-text mb-1 text-sm">{role === 'resident' ? 'Resident' : role === 'attending' ? 'Attending' : 'Typist'} signature</span>
				<select name={`${role}_checked`} class="select select-sm h-9" value={data.filters[`${role}_checked`] ?? ''}>
					<option value="">All</option>
					<option value="1">Checked</option>
					<option value="0">Unchecked</option>
				</select>
			</label>
		{/each}

		<!-- Records Per Page -->
		<label class="form-control w-16">
			<span class="label-text mb-1 text-sm">Records</span>
			<select
				name="rowcount"
				class="select select-sm leading-normal h-9"
				value={String(data.paging?.rowcount ?? 20)}
			>
				<option value="10">10</option>
				<option value="20">20</option>
				<option value="50">50</option>
				<option value="100">100</option>
			</select>
		</label>

		<!-- Page -->
		<label class="form-control w-16">
			<span class="label-text mb-1 text-sm">Page</span>
			<select
				name="page"
				class="select select-sm leading-normal h-9"
				value={Number(data.paging?.page ?? 1)}
			>
				{#each Array.from({ length: data.paging?.totalPages ?? 1 }, (_, i) => i + 1) as p}
					<option value={p}>{p}</option>
				{/each}
			</select>
		</label>

		<!-- Order By -->
		<label class="form-control w-32">
			<span class="label-text mb-1 text-sm">Order By</span>
			<select
				name="orderedby"
				class="select select-sm leading-normal h-9"
				value={data.paging?.orderedby || 's.exam_date_jalali'}
			>
				{#each studySortOptions as option (option.value)}
					<option value={option.value}>{option.label}</option>
				{/each}
			</select>
		</label>

		<!-- Direction -->
		<label class="form-control w-24">
			<span class="label-text mb-1 text-sm">Direction</span>
			<select
				name="orderdir"
				class="select select-sm leading-normal h-9"
				value={data.paging?.orderdir || 'DESC'}
			>
				<option value="ASC">ASC</option>
				<option value="DESC">DESC</option>
			</select>
		</label>

		<button class="btn btn-sm btn-primary  h-9" type="submit">Filter</button>
		<button
			class="btn btn-sm btn-accent  h-9"
			type="button"
			onclick={() => {
				// optional convenience: clear all filters quickly
				const url = new URL(location.href);
				url.search = '';
				location.href = url.toString();
			}}
		>
			Reset
		</button>
	</form>
</div>

<style>
	label {
		min-width: 0;
		max-width: 100%;
	}

	input,
	select {
		width: 100%;
		min-width: 0;
		max-width: 100%;
		height: 2.25rem;
		line-height: 1.5;
		padding-top: 0;
		padding-bottom: 0;
	}
</style>
