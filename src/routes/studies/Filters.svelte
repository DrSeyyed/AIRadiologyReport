<script>
	import { patientName } from '$lib/patient-name.js';
	import { examinationDateRange, studyDatePresets } from '$lib/study-date-ranges.js';
	import { studySortOptions } from '$lib/study-sorting.js';
	import SearchableSelect from '$lib/components/SearchableSelect.svelte';
	import { resolve } from '$app/paths';
	import StudyPagination from './StudyPagination.svelte';

	let { data } = $props();
	let showMore = $state(false);
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

	const hasAdvancedFilters = $derived(['favorites', 'modality_id', 'exam_type_id', 'corresponding_attending_id', 'corresponding_resident_id', 'resident_checked', 'attending_checked', 'typist_checked'].some(key => data.filters[key] != null && data.filters[key] !== ''));
</script>

<div class="worklist-controls min-w-0 w-full">
	<form class="study-filters" method="GET" action={resolve('/studies')}>
		<div class="quick-filters">
			<label class="form-control code-filter">
				<span class="label-text">Patient code</span>
				<input name="patient_code" class="input-bordered input input-sm" value={data.filters.patient_code} placeholder="Patient code" />
			</label>
			<label class="form-control name-filter">
				<span class="label-text">Full name</span>
				<input name="patient_fullname" class="input-bordered input input-sm" value={patientName(data.filters)} placeholder="Patient name" />
			</label>
			<label class="form-control date-filter">
				<span class="label-text">Examination date</span>
				<select name="date_range" class="select select-sm" value={dateRange} onchange={selectDateRange}>
					<option value="">{dateFrom || dateTo ? 'Custom range' : 'All dates'}</option>
					{#each studyDatePresets as preset (preset.value)}<option value={preset.value}>{preset.label}</option>{/each}
				</select>
			</label>
			<button class="btn btn-sm btn-primary" type="submit">Search</button>
			<button class="btn btn-sm btn-ghost" type="button" aria-expanded={showMore} aria-controls="advanced-study-filters" onclick={() => (showMore = !showMore)}>More filters{hasAdvancedFilters ? ' •' : ''}</button>
		</div>
		<div id="advanced-study-filters" class="advanced-filters" hidden={!showMore}>
			<h3>Filters &amp; sorting</h3>
		<label class="form-control w-56">
			<span class="label-text mb-1 text-sm">My favorites</span>
			<select name="favorites" class="select select-sm h-9" value={data.filters.favorites ?? ''}>
				<option value="">All studies</option>
				<option value="all">All favorites ({data.favorites?.total ?? 0})</option>
				{#each data.favorites?.categories ?? [] as category (category.id)}
					<option value={String(category.id)}>{category.name || `Unnamed category #${category.id}`} ({category.total})</option>
				{/each}
			</select>
		</label>
		<input type="hidden" name="status" value={data.filters.status || ''} />
		<input type="hidden" name="page" value="1" />

		<div class="w-48 max-w-full">
			<SearchableSelect label="Modality" name="modality_id" options={data.modalities} value={String(data.filters.modality_id || '')} compact />
		</div>

		<div class="w-48 max-w-full">
			<SearchableSelect label="Exam Type" name="exam_type_id" options={data.exam_types} value={String(data.filters.exam_type_id || '')} compact />
		</div>

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

		<input type="hidden" name="rowcount" value={String(data.paging?.rowcount ?? 20)} />

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

		<button class="btn btn-sm btn-primary h-9" type="submit">Apply filters</button>
		<a class="btn btn-sm btn-accent h-9" href={resolve('/studies')}>Reset</a>
		</div>
	</form>
	<div class="top-pagination"><StudyPagination paging={data.paging} position="above table" inline /></div>
</div>

<style>
	.worklist-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 0.75rem; padding: 0.75rem 1rem; border-top: 1px solid #e2e8f0; }
	.study-filters { display: contents; }
	.quick-filters { display: flex; flex-wrap: wrap; align-items: end; gap: 0.375rem; grid-column: 1; grid-row: 1; min-width: 0; }
	.quick-filters .label-text { margin-bottom: 0.25rem; font-size: 0.6875rem; }
	.code-filter { width: 6rem; }
	.name-filter { width: 7.5rem; }
	.date-filter { width: 9rem; }
	.quick-filters input, .quick-filters select { height: 2rem; font-size: 0.75rem; padding-left: 0.5rem; padding-right: 0.5rem; }
	.quick-filters .btn { padding-left: 0.5rem; padding-right: 0.5rem; font-size: 0.6875rem; }
	.top-pagination { grid-column: 2; grid-row: 1; min-width: 0; }
	.advanced-filters { grid-column: 1 / -1; grid-row: 2; display: flex; flex-wrap: wrap; align-items: end; gap: 0.75rem; min-width: 0; padding-top: 0.75rem; border-top: 1px solid #e2e8f0; }
	.advanced-filters[hidden] { display: none; }
	h3 { width: 100%; font-size: 0.8125rem; font-weight: 600; }
	@media (max-width: 54rem) {
		.worklist-controls { grid-template-columns: minmax(0, 1fr); }
		.top-pagination { grid-column: 1; grid-row: 2; }
		.advanced-filters { grid-row: 3; }
	}

	.study-filters :global(.input),
	.study-filters :global(.select) {
		border: 1px solid #cbd5e1;
	}

	.study-filters :global(.input:focus),
	.study-filters :global(.select:focus) {
		border-color: #6366f1;
	}

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
