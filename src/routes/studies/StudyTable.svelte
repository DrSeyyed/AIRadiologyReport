<script>
	import Filters from './Filters.svelte';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';

	let { data, showNewModal = $bindable(), showEditModal = $bindable(), recordingsForStudy = $bindable() } = $props();
	let error = $state('');
	let deleting = $state(null);
	const isAdmin = $derived(data.user?.role === 'admin');

	function canDelete(study) {
		return isAdmin || !study.attending_checked_count || (data.user?.role === 'attending' && data.user.id === study.corresponding_attending_id);
	}

	async function deleteStudy(study) {
		if (deleting || !confirm(`Delete study #${study.id} and all recordings/reports? This cannot be undone.`)) return;
		error = '';
		deleting = study.id;
		try {
			const response = await fetch(`/api/studies/${study.id}`, { method: 'DELETE' });
			if (!response.ok) {
				const result = await response.json().catch(() => ({}));
				throw new Error(result.error || 'Delete failed');
			}
			await invalidateAll();
		} catch (caught) {
			error = caught.message || 'Delete failed';
		} finally {
			deleting = null;
		}
	}
</script>

<div class="flex flex-wrap items-end gap-3">
	<Filters {data} />
	<div class="flex-1"></div>
	{#if isAdmin}<a class="btn btn-outline" href={resolve('/studies/import')}>Import studies</a>{/if}
	<button class="btn btn-secondary" onclick={() => (showNewModal = true)}>+ New Study</button>
</div>
{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
<div class="overflow-x-auto rounded-box border">
	<table class="table table-sm">
		<thead class="bg-base-200">
			<tr><th>Code</th><th>Firstname</th><th>Lastname</th><th>Age</th><th>Source modality</th><th>Source description (reference)</th><th>Date / time</th><th>Study attending</th><th>Recordings / reports</th><th>Signed (R/A)</th><th>Actions</th></tr>
		</thead>
		<tbody>
			{#each data.studies as study (study.id)}
				<tr>
					<td>{study.patient_code}</td>
					<td>{study.patient_firstname}</td>
					<td>{study.patient_lastname}</td>
					<td>{study.patient_age == null ? '-' : `${study.patient_age} ${study.patient_age_unit ?? 'Y'}`}</td>
					<td>{study.source_modality || study.modality_code || '-'}</td>
					<td class="max-w-xs whitespace-normal">{study.source_description || study.description || '-'}</td>
					<td>{study.exam_date_jalali}<div>{study.exam_time}</div></td>
					<td>{study.attending_fullname ?? '-'}</td>
					<td>
						<div>{study.recording_count ?? 0} recordings · {study.report_count ?? 0} reports</div>
						<button class="btn btn-sm btn-primary mt-1" onclick={() => { error = ''; recordingsForStudy = study; }}>Recordings & reports</button>
					</td>
					<td>{study.resident_checked_count ?? 0} / {study.attending_checked_count ?? 0}</td>
					<td><div class="flex gap-2">
						<button class="btn btn-outline btn-xs" onclick={() => (showEditModal = study)}>Edit study</button>
						<button class="btn btn-outline btn-xs btn-error" disabled={deleting !== null || !canDelete(study)} onclick={() => deleteStudy(study)}>{deleting === study.id ? 'Deleting…' : 'Delete'}</button>
					</div></td>
				</tr>
			{:else}<tr><td colspan="11">No studies found.</td></tr>{/each}
		</tbody>
	</table>
</div>
