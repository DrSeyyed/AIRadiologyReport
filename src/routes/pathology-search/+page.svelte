<script>
	import { resolve } from '$app/paths';
	import { studyDatePresets } from '$lib/study-date-ranges.js';
	let { data } = $props();
	function customDates(event) {
		event.currentTarget.form.elements.namedItem('date_range').value = 'custom';
	}
	function resultsPage(number) {
		const params = new URLSearchParams({ ...data.filters, page: String(number) });
		return `/pathology-search?${params}`;
	}
</script>

<section class="pathology-workspace" aria-labelledby="pathology-heading">
	<header>
		<p class="eyebrow">Clinical workspace</p>
		<h2 id="pathology-heading">Pathology search</h2>
		<p>Find report mentions using spelling variants, medical names and common abbreviations.</p>
	</header>
	<form method="GET" action={resolve('/pathology-search')} class="search-form">
		<label class="query-field">Pathology or organ + pathology
			<input name="q" type="search" required maxlength="160" value={data.filters.q || ''} placeholder="e.g. hemangioma, HCC, liver hemangioma" />
		</label>
		<div class="search-filters">
			<label>Examination modality
				<select name="modality" value={data.filters.modality || ''}>
					<option value="">All modalities</option>
					{#if data.filters.modality && !(data.modalities || []).includes(data.filters.modality)}<option value={data.filters.modality}>{data.filters.modality}</option>{/if}
					{#each data.modalities || [] as modality (modality)}<option value={modality}>{modality}</option>{/each}
				</select>
			</label>
			<label>Examination date
				<select name="date_range" value={data.filters.date_range || 'all'}>
					<option value="all">All dates</option>
					{#each studyDatePresets as preset (preset.value)}<option value={preset.value}>{preset.label}</option>{/each}
					<option value="custom">Custom Jalali range</option>
				</select>
			</label>
			<label>From (Jalali)<input name="date_from" value={data.filters.date_from || ''} placeholder="1405-01-01" oninput={customDates} /></label>
			<label>To (Jalali)<input name="date_to" value={data.filters.date_to || ''} placeholder="1405-12-29" oninput={customDates} /></label>
		</div>
		<div class="form-actions"><button class="btn btn-sm btn-primary" type="submit">Search reports</button><a class="btn btn-sm btn-ghost" href={resolve('/pathology-search')}>Reset</a></div>
		<p class="help-text">Modality uses the examination source modality (or the study modality when absent), not the recording/report template modality. Dates are inclusive examination dates, not report creation dates. All available recording reports are searched, including unsigned drafts and disabled studies. Older recordings appear later.</p>
	</form>
	<aside class="search-notice">
		<strong>Text search, not a diagnosis.</strong> Results include all matching wording, including negated, uncertain and historical mentions. Read the complete sentence and source report before using a result.
		<p>Terms must occur in the same sentence or clause. Organ matching is approximate and can miss matches. English aliases are curated, not a complete medical vocabulary. Other terms use literal whole-word matching. No report text is sent to AI.</p>
	</aside>
	{#if data.validationError}<p class="validation-error" role="alert">{data.validationError}</p>{/if}
	{#if data.search?.searched}
		<div class="results-heading" role="status"><h3>{data.search.total} matching {data.search.total === 1 ? 'report' : 'reports'}</h3><p>{data.search.scanned - data.search.unavailable} searchable reports checked{data.filters.date_range !== 'all' ? ` · ${data.filters.date_from} to ${data.filters.date_to}` : ' · All examination dates'}</p></div>
		{#if data.search.unavailable}<p class="unavailable" role="status">{data.search.unavailable} report(s) could not be searched because their text was missing, empty, unreadable or larger than 1 MB. Results may be incomplete.</p>{/if}
		<details class="expansions"><summary>Search vocabulary used</summary><ul>{#each data.search.expansions as group, index (index)}<li>{group.join(' / ')}</li>{/each}</ul></details>
		<div class="results">
			{#each data.search.rows as row (row.recording_id)}
				<article class="result-card">
					<div class="result-header">
						<div><h4 dir="auto">{row.patient_fullname || 'Unnamed patient'}</h4><p>ID <strong dir="auto">{row.patient_code}</strong> · {row.exam_date_jalali || 'Date unavailable'} {row.exam_time || ''} · {row.source_modality || 'Modality unavailable'} · Recording #{row.recording_id}</p></div>
						<a class="btn btn-sm btn-outline" href={resolve(`/studies?${new URLSearchParams({ patient_code: row.patient_code })}`)}>Open study</a>
					</div>
					<div class="report-state"><span class:unsigned={!row.attending_checked}>{row.attending_checked ? 'Attending signed' : 'Unsigned draft — not attending-signed'}</span>{#if row.disabled}<span>Disabled study</span>{/if}</div>
					{#each row.mentions as mention, index (index)}
						<div class="mention"><p dir="auto">{mention.excerpt}</p></div>
					{/each}
					{#if row.mentionCount > row.mentions.length}<p class="help-text">Showing {row.mentions.length} of {row.mentionCount} matching sentences. Open the study to review the full report.</p>{/if}
				</article>
			{:else}<p class="empty-state">{data.search.total ? 'No reports on this page. Use Previous to return to earlier results.' : 'No matching report text found. Try a broader term, another spelling or a wider date range.'}</p>{/each}
		</div>
		{#if data.search.totalPages > 1 || data.search.page > 1}
			<nav class="pagination" aria-label="Pathology search results pages">
				{#if data.search.page > 1}<a class="btn btn-sm btn-outline" href={resolve(resultsPage(data.search.page - 1))}>Previous</a>{/if}
				<span>Page {data.search.page} of {data.search.totalPages}</span>
				{#if data.search.page < data.search.totalPages}<a class="btn btn-sm btn-outline" href={resolve(resultsPage(data.search.page + 1))}>Next</a>{/if}
			</nav>
		{/if}
	{:else if !data.validationError}<p class="empty-state">Search for a pathology to explore available report text. Try “hemangioma”, “HCC” or “liver hemangioma”.</p>{/if}
</section>

<style>
	.pathology-workspace { max-width: 80rem; margin: 0 auto; min-width: 0; border: 1px solid #e2e8f0; border-radius: 0.875rem; background: #fff; color: #1e293b; overflow-wrap: anywhere; }
	header, .search-form, .results-heading, .results, .pagination { padding: 1.25rem 1.5rem; }
	.eyebrow { color: #64748b; text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.625rem; margin-bottom: 0.25rem; }
	h2 { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.035em; }
	header > p:last-child, .help-text, .results-heading p, .result-header p { margin-top: 0.375rem; color: #64748b; font-size: 0.75rem; }
	.search-form { border-top: 1px solid #e2e8f0; }
	label { display: grid; min-width: 0; gap: 0.375rem; font-size: 0.75rem; font-weight: 600; }
	input, select { width: 100%; min-width: 0; height: 2.5rem; border: 1px solid #cbd5e1; border-radius: 0.5rem; padding: 0 0.625rem; background-color: #fff; font-size: 0.8125rem; font-weight: 400; }
	input:focus-visible, select:focus-visible, summary:focus-visible, a:focus-visible, button:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }
	.query-field { max-width: 44rem; }
	.search-filters { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.875rem; margin-top: 1rem; }
	.form-actions, .report-state, .pagination { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
	.form-actions { margin-top: 1rem; }
	.search-notice { margin: 0 1.5rem; padding: 0.875rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.5rem; font-size: 0.75rem; color: #475569; line-height: 1.6; }
	.search-notice p { margin-top: 0.375rem; }
	.validation-error, .unavailable { margin: 1rem 1.5rem; padding: 0.75rem; border: 1px solid #fcd34d; background: #fffbeb; color: #854d0e; border-radius: 0.5rem; font-size: 0.8125rem; }
	h3 { font-size: 1rem; font-weight: 650; }
	.expansions { margin: 0 1.5rem; font-size: 0.75rem; color: #64748b; }
	summary { cursor: pointer; }
	.expansions ul { margin-top: 0.5rem; padding-left: 1rem; list-style: disc; }
	.results { display: grid; gap: 1rem; }
	.result-card { min-width: 0; padding: 1rem; border: 1px solid #e2e8f0; border-radius: 0.625rem; }
	.result-header { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 0.75rem; }
	.result-header > div { min-width: 0; flex: 1 1 16rem; }
	h4 { font-size: 0.9375rem; font-weight: 650; }
	.report-state { margin-top: 0.75rem; }
	.report-state span { display: inline-block; padding: 0.25rem 0.5rem; border-radius: 0.375rem; background: #f1f5f9; color: #475569; font-size: 0.6875rem; }
	.report-state .unsigned { color: #854d0e; background: #fef9c3; }
	.mention { border-top: 1px solid #edf2f7; margin-top: 0.875rem; padding-top: 0.875rem; }
	.mention p { margin-top: 0.5rem; font-size: 0.8125rem; line-height: 1.7; }
	.empty-state { padding: 2rem 1.5rem; color: #64748b; font-size: 0.8125rem; }
	.pagination { justify-content: center; border-top: 1px solid #e2e8f0; font-size: 0.75rem; }
	@media (max-width: 800px) { .search-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
	@media (max-width: 480px) {
		header, .search-form, .results-heading, .results, .pagination { padding: 1rem; }
		.search-notice, .validation-error, .unavailable, .expansions { margin-left: 1rem; margin-right: 1rem; }
		.search-filters { grid-template-columns: minmax(0, 1fr); }
	}
</style>
