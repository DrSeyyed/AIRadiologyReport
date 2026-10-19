<script>
	import Filters from './Filters.svelte';
	import { patientName } from '$lib/patient-name.js';
	import StudyAttention from './StudyAttention.svelte';
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
	import { studyRowStatus, studyRowStatuses } from '$lib/study-row-status.js';

	let { data, showNewModal = $bindable(), showEditModal = $bindable(), recordingsForStudy = $bindable() } = $props();
	let warning = $state('');
	let deleteForStudy = $state(null);
	let favoriteForStudy = $state(null);
	const isAdmin = $derived(data.user?.role === 'admin');
	const readOnly = $derived(data.user?.role === 'typist');
	const headers = [
		{ label: 'Code', columns: [{ key: 's.patient_code', label: 'Code' }] },
		{ label: 'Full name', columns: [{ key: 's.patient_fullname', label: 'Full name' }] },
		{ label: 'Age', columns: [{ key: 's.patient_age', label: 'Age' }] },
		{ label: 'Source modality', columns: [{ key: 'source_modality', label: 'Source modality' }] },
		{ label: 'Source description (reference)', columns: [{ key: 'source_description', label: 'Source description (reference)' }] },
		{ label: 'Date / time', columns: [{ key: 's.exam_date_jalali', label: 'Date / time' }] },
		{ label: 'Study attending', columns: [{ key: 'attending_fullname', label: 'Study attending' }] },
		{ label: 'Resident', columns: [{ key: 'residents', label: 'Resident' }] },
		{ label: 'Recordings / reports', columns: [{ key: 'recording_count', label: 'Recordings' }, { key: 'report_count', label: 'Reports' }] },
		{ label: 'Signed (R/A/T)', columns: [{ key: 'resident_checked_count', label: 'R', name: 'Resident signatures' }, { key: 'attending_checked_count', label: 'A', name: 'Attending signatures' }, { key: 'typist_checked_count', label: 'T', name: 'Typist signatures' }] },
		{ label: 'Attention', columns: [] },
		{ label: 'My favorites', columns: [{ key: 'is_favorite', label: 'My favorites' }] },
		{ label: 'Actions', columns: [] }
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

<FavoriteCategories {data} />
{#if favoriteForStudy}
	{#key favoriteForStudy.id}
		<FavoriteStudyModal study={favoriteForStudy} categories={data.favorites.categories} onClose={() => (favoriteForStudy = null)} onSaved={async () => { favoriteForStudy = null; await invalidateAll(); }} />
	{/key}
{/if}
<div class="flex flex-wrap items-end gap-3">
	<Filters {data} />
	<div class="flex-1"></div>
	{#if canImportStudies(data.user)}<a class="btn btn-outline" href={resolve('/studies/import')}>Import studies</a>{/if}
	{#if !readOnly}<button class="btn btn-secondary" onclick={() => (showNewModal = true)}>+ New Study</button>{/if}
</div>
{#if warning}<div class="alert alert-warning" role="status">{warning}</div>{/if}
{#if deleteForStudy}<DeleteStudyModal study={deleteForStudy} onClose={() => (deleteForStudy = null)} onDeleted={deleted} />{/if}
<ul class="flex flex-wrap gap-2 text-xs" aria-label="Study row colors">
	{#each studyRowStatuses as status (status.key)}
		<li class="study-status rounded border px-2 py-1" data-study-status={status.key}>{status.label}</li>
	{/each}
</ul>
<div class="overflow-x-auto rounded-box border">
	<table class="table table-sm">
		<thead class="bg-base-200">
			<tr>
				{#each headers as header (header.label)}
					<th scope="col" aria-sort={header.columns.length ? header.columns.some((column) => column.key === data.paging.orderedby) ? data.paging.orderdir === 'ASC' ? 'ascending' : 'descending' : 'none' : undefined}>
						{#if !header.columns.length}{header.label}{/if}
						{#if header.columns.length > 1}<div>{header.label}</div>{/if}
						<div class="flex flex-wrap gap-2">
							{#each header.columns as column (column.key)}
								{@const active = data.paging.orderedby === column.key}
								{@const nextDirection = active && data.paging.orderdir === 'ASC' ? 'descending' : 'ascending'}
								<a class="sort-link" class:sort-active={active}
									href={resolve(studySortHref(page.url.search, column.key, data.paging.orderedby, data.paging.orderdir))}
									aria-label={`Sort by ${column.name || column.label}, ${nextDirection}`}>
									{column.label} <span aria-hidden="true">{active ? data.paging.orderdir === 'ASC' ? '↑' : '↓' : '↕'}</span>
								</a>
							{/each}
						</div>
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each data.studies as study (study.id)}
				<tr class="study-status" data-study-status={studyRowStatus(study)}>
					<td><span class:line-through={Boolean(study.disabled)}>{study.patient_code}</span>{#if study.disabled}<div class="badge badge-error">Disabled</div>{/if}</td>
					<td>{patientName(study)}</td>
					<td>{study.patient_age == null ? '-' : `${study.patient_age} ${study.patient_age_unit ?? 'Y'}`}</td>
					<td>{study.source_modality || study.modality_code || '-'}</td>
					<td class="max-w-xs whitespace-normal">{study.source_description || study.description || '-'}</td>
					<td>{study.exam_date_jalali}<div>{study.exam_time}</div></td>
					<td>{study.attending_fullname ?? '-'}</td>
					<td class="max-w-xs whitespace-normal">
						{#each study.residents as resident (resident.id)}
							<div>{resident.full_name}</div>
						{:else}-{/each}
					</td>
					<td>
						<div>{study.recording_count ?? 0} recordings · {study.report_count ?? 0} reports</div>
						<button class="btn btn-sm btn-primary mt-1" onclick={() => { recordingsForStudy = study; }}>Recordings & reports</button>
					</td>
					<td>{study.resident_checked_count ?? 0} / {study.attending_checked_count ?? 0} / {study.typist_checked_count ?? 0}</td>
					<td><StudyAttention {study} user={data.user} /></td>
					<td><StudyFavorite {study} onCategories={(study) => (favoriteForStudy = study)} /></td>
					<td class="min-w-48 whitespace-normal"><PacsViewer {study} template={data.pacsViewerUrl} user={data.user} />{#if !readOnly}<div class="flex flex-wrap gap-2">
						<button class="btn btn-outline btn-xs shrink-0 whitespace-nowrap" disabled={Boolean(study.disabled)} onclick={() => (showEditModal = study)}>Edit study</button>
						<button class="btn btn-outline btn-xs btn-error shrink-0 whitespace-nowrap" disabled={!canDelete(study)} onclick={() => { warning = ''; deleteForStudy = study; }}>{study.disabled ? 'Retry deletion' : 'Delete'}</button>
					</div>{/if}</td>
				</tr>
			{:else}<tr><td colspan="13">No studies found.</td></tr>{/each}
		</tbody>
	</table>
</div>

<style>
	.study-status {
		color: #1f2937;
		border-color: #cbd5e1;
	}

	.study-status[data-study-status='attention'] {
		background-color: #fef9c3;
	}

	.study-status[data-study-status='no-recording'] {
		background-color: #fee2e2;
	}

	.study-status[data-study-status='unsigned'] {
		background-color: #fce7f3;
	}

	.study-status[data-study-status='signed'] {
		background-color: #dcfce7;
	}

	.sort-link {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		white-space: nowrap;
	}

	.sort-link:hover,
	.sort-active {
		text-decoration: underline;
	}

	.sort-link:focus-visible {
		outline: 2px solid currentColor;
		outline-offset: 3px;
	}
</style>
