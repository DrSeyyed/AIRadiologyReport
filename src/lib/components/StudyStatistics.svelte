<script>
	import { statisticsPresets, statisticsMetrics } from '$lib/study-statistics-options.js';

	let { data } = $props();
	const summaryKeys = ['total', 'active', 'disabled'];
	const scopes = {
		all: 'All studies.',
		assigned: 'Studies assigned to you. For residents, this includes study-level or recording-level assignments; for attendings, study-level assignments only.',
		signed: 'Studies with at least one currently signed recording personally signed by you as typist.'
	};
</script>

<section class="w-full min-w-0 max-w-screen-xl space-y-6" aria-labelledby="statistics-heading">
	<header class="space-y-2">
		<h1 id="statistics-heading" class="text-2xl font-bold">Study statistics</h1>
		<p class="text-sm opacity-80">Aggregate study counts only; no patient details are shown.</p>
	</header>

	<form method="GET" class="space-y-3 rounded-box border border-base-300 bg-base-100 p-4" aria-label="Statistics date range">
		<div class="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
			<label class="form-control min-w-0">
				<span class="label-text mb-2">Date range</span>
				<select class="select select-bordered w-full" name="date_range" value={data.filters.date_range} aria-describedby="statistics-dates-help">
					{#if !statisticsPresets.some((preset) => preset.value === data.filters.date_range)}
						<option value={data.filters.date_range}>Invalid selection — choose a date range</option>
					{/if}
					{#each statisticsPresets as preset (preset.value)}
						<option value={preset.value}>{preset.label}</option>
					{/each}
				</select>
			</label>
			<label class="form-control min-w-0">
				<span class="label-text mb-2">From (Jalali, custom only)</span>
				<input class="input input-bordered w-full" type="text" name="date_from" value={data.filters.date_from} placeholder="YYYY-MM-DD" dir="ltr" aria-describedby="statistics-dates-help" />
			</label>
			<label class="form-control min-w-0">
				<span class="label-text mb-2">To (Jalali, custom only)</span>
				<input class="input input-bordered w-full" type="text" name="date_to" value={data.filters.date_to} placeholder="YYYY-MM-DD" dir="ltr" aria-describedby="statistics-dates-help" />
			</label>
			<button class="btn btn-primary self-end" type="submit">Apply range</button>
		</div>
		<p id="statistics-dates-help" class="text-sm opacity-80">Dates include both endpoints and use the study exam date (Jalali), not creation, reporting or signing activity. Presets end today in Tehran (Asia/Tehran). Custom dates are used only with Custom range.</p>
		{#if data.validationError}
			<p class="alert alert-error" role="alert">{data.validationError}</p>
		{/if}
	</form>

	{#if data.statistics}
		{@const statistics = data.statistics}
		<div class="space-y-2 text-sm">
			<p><strong>Scope:</strong> {scopes[statistics.scope]}</p>
			<p class="break-words"><strong>Exam dates:</strong> {statistics.range.label} · <span dir="ltr">{statistics.range.date_from}</span> to <span dir="ltr">{statistics.range.date_to}</span> (Jalali, inclusive; {statistics.range.timeZone})</p>
		</div>
		<section class="space-y-3" aria-labelledby="statistics-totals-heading">
			<h2 id="statistics-totals-heading" class="text-lg font-semibold">Study totals</h2>
			<div class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
				{#each statisticsMetrics.filter((metric) => summaryKeys.includes(metric.key)) as metric (metric.key)}
					<div class="min-w-0 rounded-box border border-base-300 bg-base-100 p-4">
						<h3 class="break-words text-sm">{metric.label}</h3>
						<p class="mt-2 break-words text-3xl font-bold tabular-nums">{statistics.totals[metric.key].toLocaleString('en-US')}</p>
					</div>
				{/each}
			</div>
		</section>
		<section class="space-y-3" aria-labelledby="statistics-status-heading">
			<h2 id="statistics-status-heading" class="text-lg font-semibold">Reporting and signature status</h2>
			<p class="text-sm opacity-80">Every count is unique studies, not recordings. Total includes active and disabled studies; all workflow counts below include active studies only and may overlap.</p>
			<div class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{#each statisticsMetrics.filter((metric) => !summaryKeys.includes(metric.key)) as metric (metric.key)}
					<div class="min-w-0 rounded-box border border-base-300 bg-base-100 p-4">
						<h3 class="break-words text-sm">{metric.label}</h3>
						<p class="mt-2 break-words text-3xl font-bold tabular-nums">{statistics.totals[metric.key].toLocaleString('en-US')}</p>
					</div>
				{/each}
			</div>
			<p class="text-sm opacity-80">Fully reported means at least one recording and a report file path on every recording. Fully signed means at least one recording and resident, attending and typist signatures on every recording. Role-signed counts require that role’s signature on every recording. Studies without recordings count as reports incomplete or missing, but not awaiting signatures.</p>
		</section>
	{/if}
</section>
