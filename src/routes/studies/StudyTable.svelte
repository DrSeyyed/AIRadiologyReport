<script>
	import Filters from './Filters.svelte';
	import { patientName } from '$lib/patient-name.js';
	import StudyAttention from './StudyAttention.svelte';
	import StudyDescription from './StudyDescription.svelte';
	import PacsViewer from './PacsViewer.svelte';
	import DeleteStudyModal from './DeleteStudyModal.svelte';
	import FavoriteCategories from './FavoriteCategories.svelte';
	import StudyFavorite from './StudyFavorite.svelte';
	import FavoriteStudyModal from './FavoriteStudyModal.svelte';
	import { canImportStudies } from '$lib/study-permissions.js';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { studySortHref } from '$lib/study-sorting.js';
	import { studyRowStatus, studyRowStatuses, studyStatusHref } from '$lib/study-row-status.js';

	let { data, showNewModal = $bindable(), showEditModal = $bindable(), recordingsForStudy = $bindable() } = $props();
	let warning = $state('');
	let deleteForStudy = $state(null);
	let favoriteForStudy = $state(null);
	const isAdmin = $derived(data.user?.role === 'admin');
	const readOnly = $derived(data.user?.role === 'typist');
	const hasFilters = $derived(Object.entries(data.filters).some(([key, value]) => key !== 'status' && value != null && value !== '' && value !== 0 && value !== '0'));
	const headers = [
		{ label: 'Patient', columns: [{ key: 's.patient_code', label: 'Code' }, { key: 's.patient_fullname', label: 'Full name' }, { key: 's.patient_age', label: 'Age' }] },
		{ label: 'Examination', columns: [{ key: 's.exam_date_jalali', label: 'Date / time' }, { key: 'source_modality', label: 'Source modality' }, { key: 'source_description', label: 'Source description' }] },
		{ label: 'Review team', columns: [{ key: 'attending_fullname', label: 'Study attending' }, { key: 'residents', label: 'Resident' }] },
		{ label: 'Reporting', columns: [{ key: 'recording_count', label: 'Recordings' }, { key: 'report_count', label: 'Reports' }, { key: 'resident_checked_count', label: 'R', name: 'Resident signatures' }, { key: 'attending_checked_count', label: 'A', name: 'Attending signatures' }, { key: 'typist_checked_count', label: 'T', name: 'Typist signatures' }] },
		{ label: 'Actions', columns: [{ key: 'is_favorite', label: 'My favorites' }] }
	];
	const signatureRoles = [
		{ key: 'resident_checked_count', label: 'Resident', short: 'R' },
		{ key: 'attending_checked_count', label: 'Attending', short: 'A' },
		{ key: 'typist_checked_count', label: 'Typist', short: 'T' }
	];

	function canDelete(study) {
		return isAdmin || !study.attending_checked_count || (data.user?.role === 'attending' && data.user.id === study.corresponding_attending_id);
	}

	async function deleted(result) {
		deleteForStudy = null;
		warning = result.notification_warning || '';
		await invalidateAll();
	}
</script>

{#if favoriteForStudy}
	{#key favoriteForStudy.id}
		<FavoriteStudyModal study={favoriteForStudy} categories={data.favorites.categories} onClose={() => (favoriteForStudy = null)} onSaved={async () => { favoriteForStudy = null; await invalidateAll(); }} />
	{/key}
{/if}
{#if warning}<div class="alert alert-warning" role="status">{warning}</div>{/if}
{#if deleteForStudy}<DeleteStudyModal study={deleteForStudy} onClose={() => (deleteForStudy = null)} onDeleted={deleted} />{/if}
<section class="study-workspace" aria-label="Study worklist">
	<header class="worklist-toolbar">
		<div>
			<p class="eyebrow">Clinical workspace</p>
			<h2>Studies <span class="result-count">{data.paging.total ?? data.studies.length}</span></h2>
			<p class="toolbar-caption">Patient, examination and reporting progress at a glance.</p>
		</div>
		<div class="toolbar-actions">
			{#if canImportStudies(data.user)}<a class="btn btn-sm btn-outline" href={resolve('/studies/import')}>Import studies</a>{/if}
			{#if !readOnly}<button class="btn btn-sm btn-primary" onclick={() => (showNewModal = true)}>+ New Study</button>{/if}
		</div>
	</header>
	<details class="worklist-filters">
		<summary>Filters & sorting <span class="filter-caption">{hasFilters ? 'Filtered view' : 'All studies'} · Search, dates and reviewers</span></summary>
		<div class="filter-content"><Filters {data} /></div>
	</details>
	<div class="worklist-favorites"><FavoriteCategories {data} /></div>
	<nav class="status-navigation" aria-label="Study status filters">
		<ul>
			{#each [{ key: '', label: 'All studies' }, ...studyRowStatuses] as status (status.key)}
				<li>
					<a class="study-status status-filter" data-study-status={status.key}
						aria-current={(data.filters.status || '') === status.key ? 'true' : undefined}
						href={resolve(studyStatusHref(page.url.search, status.key))}>
						<span class="status-dot" aria-hidden="true"></span>{status.label}
					</a>
				</li>
			{/each}
		</ul>
	</nav>
	<p class="table-scroll-hint">Scroll horizontally to see all columns <span aria-hidden="true">→</span></p>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to focus this region to scroll the table.) -->
	<div class="study-table-scroll w-full min-w-0 max-w-full overflow-x-auto" role="region" aria-label="Studies table, scroll horizontally on smaller screens" tabindex="0">
		<table class="study-table">
			<caption class="sr-only">Study worklist grouped by patient, examination, review team, reporting and actions.</caption>
			<colgroup><col class="patient-column" /><col class="examination-column" /><col class="team-column" /><col class="reporting-column" /><col class="actions-column" /></colgroup>
			<thead>
				<tr>
					{#each headers as header (header.label)}
						{@const activeColumn = header.columns.find((column) => column.key === data.paging.orderedby)}
						<th scope="col" aria-sort={activeColumn ? data.paging.orderdir === 'ASC' ? 'ascending' : 'descending' : 'none'}>
							<div class="column-title">{header.label}</div>
							<details class="column-sort">
								<summary aria-label={`Sort ${header.label.toLowerCase()}`}>{activeColumn ? `${activeColumn.label} ${data.paging.orderdir === 'ASC' ? '↑' : '↓'}` : 'Sort'}</summary>
								<div class="sort-options">
									{#each header.columns as column (column.key)}
										{@const active = data.paging.orderedby === column.key}
										{@const nextDirection = active && data.paging.orderdir === 'ASC' ? 'descending' : 'ascending'}
										<a class="sort-link" class:sort-active={active}
											href={resolve(studySortHref(page.url.search, column.key, data.paging.orderedby, data.paging.orderdir))}
											aria-label={`Sort by ${column.name || column.label}, ${nextDirection}`}>
											{column.name || column.label} <span aria-hidden="true">{active ? data.paging.orderdir === 'ASC' ? '↑' : '↓' : '↕'}</span>
										</a>
									{/each}
								</div>
							</details>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each data.studies as study (study.id)}
					{@const status = studyRowStatus(study)}
					{@const recordingCount = study.recording_count ?? 0}
					<tr class="study-status" data-study-status={status}>
						<td>
							<div class="patient-name" class:line-through={Boolean(study.disabled)} dir="auto">{patientName(study)}</div>
							<div class="patient-meta"><span class="field-label">ID</span> <span class="patient-code" dir="auto">{study.patient_code}</span></div>
							<div class="secondary-text">Age {study.patient_age == null ? '—' : `${study.patient_age} ${study.patient_age_unit ?? 'Y'}`}</div>
							<span class="status-badge" class:disabled-badge={Boolean(study.disabled)}>{studyRowStatuses.find((item) => item.key === status)?.label}</span>
						</td>
						<td>
							<div class="exam-heading"><span class="modality-badge" dir="auto">{study.source_modality || study.modality_code || '—'}</span><span class="exam-date">{study.exam_date_jalali}<span class="exam-time">{study.exam_time}</span></span></div>
							<div class="exam-description"><StudyDescription text={study.source_description || study.description || '-'} /></div>
						</td>
						<td>
							<div class="reviewer"><span class="field-label">Attending</span><span dir="auto">{study.attending_fullname || 'Unassigned'}</span></div>
							<div class="reviewer"><span class="field-label">Resident</span><div>{#each study.residents as resident (resident.id)}<div dir="auto">{resident.full_name}</div>{:else}<span class="secondary-text">Unassigned</span>{/each}</div></div>
							<details class="attention-disclosure">
								<summary class:attention-active={Boolean(study.needs_attention)}>{study.needs_attention ? 'Needs attention' : study.attention_note ? 'Attention note' : readOnly || study.disabled ? 'Attention' : 'Add attention note'}</summary>
								<div class="attention-editor"><StudyAttention {study} user={data.user} /></div>
							</details>
							{#if study.attention_note}<p class="attention-preview" dir="auto">{study.attention_note}</p>{/if}
						</td>
						<td>
							<div class="report-metrics" aria-label="Recording and report counts">
								<div><strong>{recordingCount}</strong><span>Recordings</span></div>
								<div><strong>{study.report_count ?? 0}</strong><span>Reports</span></div>
							</div>
							<div class="signature-heading">Signatures <span>signed / recordings</span></div>
							<div class="signature-list">
								{#each signatureRoles as role (role.key)}
									{@const checked = study[role.key] ?? 0}
									<span class="signature-chip" class:signature-complete={recordingCount > 0 && checked === recordingCount} aria-label={`${role.label} signatures: ${checked} of ${recordingCount}`} title={`${role.label} signatures`}><span>{role.short}</span> {checked}/{recordingCount}</span>
								{/each}
							</div>
						</td>
						<td>
							<div class="row-actions">
								<button class="btn btn-sm btn-primary report-button" onclick={() => { recordingsForStudy = study; }}>Recordings & reports <span aria-hidden="true">→</span></button>
								<div class="quick-actions"><PacsViewer {study} template={data.pacsViewerUrl} user={data.user} /><StudyFavorite {study} compact /></div>
								<details class="more-actions">
									<summary aria-label={`More actions for study ${study.patient_code}`}>More actions</summary>
									<div class="action-list">
										<button class="action-button" onclick={() => (favoriteForStudy = study)}>Favorite categories{study.favorite_category_ids?.length ? ` (${study.favorite_category_ids.length})` : ''}</button>
										{#if !readOnly}
											<button class="action-button" disabled={Boolean(study.disabled)} onclick={() => (showEditModal = study)}>Edit study</button>
											<button class="action-button delete-action" disabled={!canDelete(study)} onclick={() => { warning = ''; deleteForStudy = study; }}>{study.disabled ? 'Retry deletion' : 'Delete'}</button>
										{/if}
									</div>
								</details>
							</div>
						</td>
					</tr>
				{:else}<tr><td colspan="5" class="empty-state"><strong>No studies found</strong><span>Try a different search, date range or status.</span></td></tr>{/each}
			</tbody>
		</table>
	</div>
</section>

<style>
	.study-workspace {
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
		border: 1px solid #dbe3ed;
		border-radius: 1rem;
		background: #fff;
		color: #1e293b;
		box-shadow: 0 4px 18px rgb(15 23 42 / 4%);
	}

	.worklist-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.5rem;
	}

	.eyebrow,
	.field-label {
		font-size: 0.6875rem;
		font-weight: 600;
		color: #64748b;
	}

	.eyebrow {
		text-transform: uppercase;
		letter-spacing: 0.12em;
		margin-bottom: 0.25rem;
	}

	h2 {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		font-size: 1.5rem;
		font-weight: 700;
		letter-spacing: -0.035em;
	}

	.result-count {
		padding: 0.125rem 0.5rem;
		border-radius: 0.5rem;
		background: #f1f5f9;
		color: #475569;
		font-size: 0.8125rem;
		letter-spacing: normal;
	}

	.toolbar-caption,
	.filter-caption,
	.secondary-text {
		font-size: 0.75rem;
		color: #64748b;
	}

	.toolbar-caption { margin-top: 0.25rem; }
	.toolbar-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
	.worklist-filters { border-top: 1px solid #e2e8f0; }
	.worklist-filters > summary { padding: 0.875rem 1.5rem; font-size: 0.8125rem; font-weight: 600; }
	.filter-caption { margin-left: 0.75rem; font-weight: 400; }
	.filter-content { display: grid; gap: 1rem; padding: 0.5rem 1.5rem 1.5rem; }
	.worklist-favorites { border-top: 1px solid #e2e8f0; padding: 0.75rem 1.5rem; }

	summary { cursor: pointer; }
	summary:focus-visible,
	a:focus-visible,
	button:focus-visible,
	.study-table-scroll:focus-visible { outline: 2px solid #4f46e5; outline-offset: -2px; }

	.status-navigation { border-top: 1px solid #e2e8f0; padding: 0.75rem 1.5rem; }
	.status-navigation ul { display: flex; flex-wrap: wrap; gap: 0.375rem; }
	.study-status { --status-ink: #475569; --status-tint: #f1f5f9; --status-dot: #94a3b8; }
	.study-status[data-study-status='attention'] { --status-ink: #854d0e; --status-tint: #fef9c3; --status-dot: #eab308; }
	.study-status[data-study-status='no-recording'] { --status-ink: #991b1b; --status-tint: #fef2f2; --status-dot: #ef4444; }
	.study-status[data-study-status='unsigned'] { --status-ink: #9d174d; --status-tint: #fdf2f8; --status-dot: #ec4899; }
	.study-status[data-study-status='signed'] { --status-ink: #166534; --status-tint: #f0fdf4; --status-dot: #22c55e; }
	.study-status[data-study-status='disabled'] { --status-ink: #4b5563; --status-tint: #f3f4f6; --status-dot: #9ca3af; }
	.status-filter { display: inline-flex; align-items: center; gap: 0.375rem; min-height: 2rem; padding: 0.375rem 0.625rem; border-radius: 0.5rem; font-size: 0.75rem; color: #64748b; }
	.status-filter:hover { background: #f8fafc; }
	.status-filter[aria-current='true'] { background: var(--status-tint); color: var(--status-ink); font-weight: 700; box-shadow: inset 0 0 0 1px var(--status-dot); }
	.status-dot { width: 0.375rem; height: 0.375rem; flex-shrink: 0; border-radius: 50%; background: var(--status-dot); }

	.table-scroll-hint { display: none; }
	.study-table-scroll { border-top: 1px solid #e2e8f0; }
	.study-table { width: 100%; min-width: 66rem; table-layout: fixed; border-collapse: collapse; text-align: left; font-size: 0.8125rem; }
	.patient-column { width: 20%; }
	.examination-column { width: 24%; }
	.team-column { width: 19%; }
	.reporting-column { width: 19%; }
	.actions-column { width: 18%; }
	.study-table th { vertical-align: top; padding: 0.875rem 1rem; background: #f8fafc; border-bottom: 1px solid #e2e8f0; font-weight: 500; }
	.study-table td { vertical-align: top; padding: 1.25rem 1rem; border-bottom: 1px solid #edf2f7; white-space: normal; overflow-wrap: anywhere; }
	.study-table tbody tr:last-child td { border-bottom: 0; }
	.study-table tbody tr:hover { background: #fafbff; }
	.study-table tbody tr[data-study-status='disabled'] { background: #f8fafc; }
	.study-table tbody td:first-child { border-left: 3px solid var(--status-dot); }
	.column-title { font-size: 0.75rem; font-weight: 700; color: #475569; }
	.column-sort { margin-top: 0.125rem; font-size: 0.6875rem; color: #64748b; }
	.column-sort > summary { width: fit-content; }
	.sort-options { display: grid; gap: 0.25rem; margin-top: 0.5rem; padding: 0.375rem; border: 1px solid #e2e8f0; border-radius: 0.5rem; background: #fff; }
	.sort-link { display: flex; justify-content: space-between; gap: 0.375rem; padding: 0.25rem; color: #475569; }
	.sort-link:hover,
	.sort-active { color: #4338ca; text-decoration: underline; }

	.patient-name { font-size: 0.9375rem; line-height: 1.5; font-weight: 650; }
	.patient-meta { display: flex; align-items: baseline; gap: 0.375rem; margin: 0.5rem 0 0.25rem; }
	.patient-code { min-width: 0; font-family: ui-monospace, monospace; font-size: 0.75rem; color: #475569; }
	.status-badge { display: inline-block; max-width: 100%; margin-top: 0.75rem; padding: 0.25rem 0.5rem; border-radius: 0.375rem; background: var(--status-tint); color: var(--status-ink); font-size: 0.6875rem; font-weight: 600; }
	.disabled-badge { width: max-content; white-space: nowrap; overflow-wrap: normal; flex-shrink: 0; }
	.exam-heading { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 0.625rem; }
	.modality-badge { max-width: 100%; padding: 0.25rem 0.5rem; background: #eef2ff; border: 1px solid #e0e7ff; border-radius: 0.375rem; color: #4338ca; font-size: 0.75rem; font-weight: 700; }
	.exam-date { font-size: 0.75rem; font-weight: 600; font-variant-numeric: tabular-nums; }
	.exam-time { display: block; margin-top: 0.125rem; color: #64748b; font-size: 0.6875rem; font-weight: 400; }
	.exam-description { margin-top: 0.875rem; line-height: 1.65; color: #475569; }
	.reviewer { display: grid; gap: 0.125rem; margin-bottom: 0.625rem; }
	.attention-disclosure { margin-top: 0.875rem; }
	.attention-disclosure > summary { font-size: 0.6875rem; color: #64748b; }
	.attention-disclosure > .attention-active { color: #854d0e; font-weight: 700; }
	.attention-editor { margin-top: 0.75rem; }
	.attention-preview { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; margin-top: 0.375rem; color: #854d0e; font-size: 0.6875rem; white-space: pre-wrap; }
	.report-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
	.report-metrics > div { padding: 0.5rem 0.625rem; border: 1px solid #e2e8f0; border-radius: 0.5rem; background: #fff; }
	.report-metrics strong { display: block; font-size: 1.125rem; font-weight: 650; line-height: 1.25; font-variant-numeric: tabular-nums; }
	.report-metrics span { font-size: 0.625rem; color: #64748b; }
	.signature-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem; margin: 0.875rem 0 0.375rem; font-size: 0.6875rem; font-weight: 600; color: #475569; }
	.signature-heading > span { font-weight: 400; font-size: 0.5625rem; color: #64748b; }
	.signature-list { display: flex; flex-wrap: wrap; gap: 0.25rem; }
	.signature-chip { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.25rem 0.375rem; border-radius: 0.375rem; background: #f1f5f9; color: #64748b; font-size: 0.625rem; font-variant-numeric: tabular-nums; }
	.signature-chip > span { font-weight: 700; }
	.signature-complete { background: #f0fdf4; color: #166534; }
	.row-actions { display: grid; gap: 0.625rem; }
	.report-button { display: flex; justify-content: space-between; width: 100%; height: auto; min-height: 2.25rem; padding: 0.5rem 0.625rem; font-size: 0.6875rem; }
	.quick-actions { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 0.5rem; }
	.more-actions > summary { width: fit-content; color: #64748b; font-size: 0.6875rem; }
	.action-list { display: grid; gap: 0.25rem; margin-top: 0.5rem; padding: 0.375rem; border: 1px solid #e2e8f0; border-radius: 0.5rem; background: #fff; }
	.action-button { padding: 0.375rem; border-radius: 0.25rem; text-align: left; font-size: 0.75rem; }
	.action-button:hover:not(:disabled) { background: #f1f5f9; }
	.action-button:disabled { cursor: not-allowed; opacity: 0.45; }
	.delete-action { color: #b91c1c; }
	.empty-state { text-align: center; padding: 3rem 1rem !important; }
	.empty-state strong { display: block; font-size: 1rem; }
	.empty-state span { display: block; margin-top: 0.5rem; color: #64748b; }

	@media (max-width: 1150px) {
		.table-scroll-hint { display: block; padding: 0.5rem 1rem; border-top: 1px solid #e2e8f0; background: #f8fafc; color: #64748b; font-size: 0.6875rem; }
	}

	@media (max-width: 640px) {
		.worklist-toolbar { padding: 1rem; }
		.worklist-favorites { padding: 0.75rem 1rem; }
		.worklist-filters > summary { padding: 0.875rem 1rem; }
		.filter-caption { display: block; margin: 0.25rem 0 0; }
		.filter-content { padding: 0.5rem 1rem 1rem; }
		.status-navigation { padding: 0.75rem 1rem; }
		.toolbar-caption { max-width: 17rem; }
	}
</style>
