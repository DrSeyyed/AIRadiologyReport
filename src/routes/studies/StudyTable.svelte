<script>
	import Filters from './Filters.svelte';
	import { patientName } from '$lib/patient-name.js';
	import StudyAttention from './StudyAttention.svelte';
	import PacsViewer from './PacsViewer.svelte';
	import DeleteStudyModal from './DeleteStudyModal.svelte';
	import { canImportStudies } from '$lib/study-permissions.js';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';

	let { data, showNewModal = $bindable(), showEditModal = $bindable(), recordingsForStudy = $bindable() } = $props();
	let warning = $state('');
	let deleteForStudy = $state(null);
	const isAdmin = $derived(data.user?.role === 'admin');
	const readOnly = $derived(data.user?.role === 'typist');

	function canDelete(study) {
		return isAdmin || !study.attending_checked_count || (data.user?.role === 'attending' && data.user.id === study.corresponding_attending_id);
	}

	async function deleted(result) {
		deleteForStudy = null;
		warning = result.notification_warning || '';
		await invalidateAll();
	}
</script>

<div class="flex flex-wrap items-end gap-3">
	<Filters {data} />
	<div class="flex-1"></div>
	{#if canImportStudies(data.user)}<a class="btn btn-outline" href={resolve('/studies/import')}>Import studies</a>{/if}
	{#if !readOnly}<button class="btn btn-secondary" onclick={() => (showNewModal = true)}>+ New Study</button>{/if}
</div>
{#if warning}<div class="alert alert-warning" role="status">{warning}</div>{/if}
{#if deleteForStudy}<DeleteStudyModal study={deleteForStudy} onClose={() => (deleteForStudy = null)} onDeleted={deleted} />{/if}
<div class="overflow-x-auto rounded-box border">
	<table class="table table-sm">
		<thead class="bg-base-200">
			<tr><th>Code</th><th>Full name</th><th>Age</th><th>Source modality</th><th>Source description (reference)</th><th>Date / time</th><th>Study attending</th><th>Resident</th><th>Recordings / reports</th><th>Signed (R/A/T)</th><th>Attention</th><th>Actions</th></tr>
		</thead>
		<tbody>
			{#each data.studies as study (study.id)}
				<tr>
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
					<td><PacsViewer {study} template={data.pacsViewerUrl} />{#if !readOnly}<div class="flex gap-2">
						<button class="btn btn-outline btn-xs" disabled={Boolean(study.disabled)} onclick={() => (showEditModal = study)}>Edit study</button>
						<button class="btn btn-outline btn-xs btn-error" disabled={!canDelete(study)} onclick={() => { warning = ''; deleteForStudy = study; }}>{study.disabled ? 'Retry deletion' : 'Delete'}</button>
					</div>{/if}</td>
				</tr>
			{:else}<tr><td colspan="12">No studies found.</td></tr>{/each}
		</tbody>
	</table>
</div>
