<script>
	import { toJalaali } from 'jalaali-js';
	import Filters from './Filters.svelte';
	import { invalidate, invalidateAll } from '$app/navigation';

	let {
		data,
		showNewModal = $bindable(),
		showEditModal = $bindable(),
		reportForStudy = $bindable()
	} = $props();

	let uploadingFor = $state(null);
	let uploadBusy = $state(false);
	let transcribingFor = $state(null);

	const user = data?.user;
	const isAdmin = user?.role === 'admin';

	data.filters.orderedby = 'exam_date_jalali';

	const columns = [
		{ key: 'patient_code', label: 'Code' },
		{ key: 'patient_firstname', label: 'Firstname' },
		{ key: 'patient_lastname', label: 'Lastname' },
		{ key: 'patient_age', label: 'Age' },
		{ key: 'modality_id', label: 'Modality' },
		{ key: 'exam_type_id', label: 'Types' },
		{ key: 'exam_date_jalali', label: 'Date' },
		{ key: 'exam_time', label: 'Time' },
		{ key: 'corresponding_resident_id', label: 'Resident' },
		{ key: 'corresponding_attending_id', label: 'Attending' },
		{ key: 'report', label: 'Report' },
		{ key: 'checked', label: 'Checked (R/A)' },
		{ key: 'actions', label: 'Actions' }
	];

	function canToggleResidentFor(study) {
		if (isAdmin) return true;
		return user?.role === 'resident' && user?.id === study.corresponding_resident_id;
	}

	function canToggleAttendingFor(study) {
		if (isAdmin) return true;
		return (
			user?.role === 'attending' &&
			user?.id === study.corresponding_attending_id &&
			study.resident_checked === 1
		);
	}

	function canDelete(study) {
		if (isAdmin) return true;
		if (study.attending_checked === 1)
			return user?.role === 'attending' && user?.id === study.corresponding_attending_id;
		return true;
	}

	async function uploadAudio(studyId, file) {
		if (!file) return;
		uploadingFor = studyId; // fix: remember which row is uploading
		uploadBusy = true;
		const fd = new FormData();
		fd.append('file', file);
		const res = await fetch(`/api/studies/${studyId}/audio`, { method: 'POST', body: fd });
		uploadBusy = false;
		if (!res.ok) {
			const e = await res.json().catch(() => ({}));
			alert(e?.error || 'Upload failed');
			uploadingFor = null;
			return;
		}
		await invalidateAll();
		uploadingFor = null;
	}

	async function transcribeStudy(study) {
		if (!study.audio_report_path) {
			alert('No audio uploaded for this study.');
			return;
		}
		transcribingFor = study.id;
		try {
			const res = await fetch(`/api/studies/${study.id}/transcribe`, { method: 'POST' });
			if (!res.ok) {
				const e = await res.json().catch(() => ({}));
				throw new Error(e?.error || 'Transcription failed');
			}
			const d = await res.json();
			reportForStudy = { ...study, __initialText: d.text };
			await invalidateAll();
		} catch (err) {
			alert(err.message);
		} finally {
			transcribingFor = null;
		}
	}

	async function signStudy(study, roleToSign, nextChecked, inputEl) {
		if (roleToSign === 'resident') {
			if (!canToggleResidentFor(study)) {
				if (inputEl) inputEl.checked = !nextChecked;
				return;
			}
			if (!nextChecked && study.attending_checked === 1 && !isAdmin) {
				if (inputEl) inputEl.checked = true;
				alert('Attending has already signed. Resident cannot uncheck.');
				return;
			}
		} else if (roleToSign === 'attending') {
			if (!canToggleAttendingFor(study)) {
				if (inputEl) inputEl.checked = !nextChecked;
				if (study.resident_checked !== 1) alert('Resident must sign first.');
				return;
			}
		}

		const res = await fetch(`/api/studies/${study.id}/sign`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ role: roleToSign, checked: nextChecked })
		});
		if (!res.ok) {
			const e = await res.json().catch(() => ({}));
			if (inputEl) inputEl.checked = !nextChecked;
			alert(e?.error || 'Sign failed');
			return;
		}
		const updated = await res.json();
		study.resident_checked = updated.resident_checked ?? study.resident_checked;
		study.attending_checked = updated.attending_checked ?? study.attending_checked;
	}

	async function delStudy(id) {
		if (!confirm(`Delete study #${id}? This cannot be undone.`)) return;
		const res = await fetch(`/api/studies/${id}`, { method: 'DELETE' });
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			alert(err?.error || 'Delete failed');
			return;
		}
		await invalidateAll();
	}
</script>

<!-- Toolbar -->
<div class="flex flex-wrap items-end gap-3">
	<Filters {data} />

	<div class="flex-1"></div>

	<button class="btn-xm btn btn-secondary" onclick={() => (showNewModal = true)}>
		+ New Study
	</button>
</div>

<!-- Table -->
<div class="overflow-x-auto rounded-box border">
	<table class="table-xm table bg-blue-100">
		<thead class="bg-base-200">
			<tr>
				{#each columns as col}
					<th
						>{col.label}
						{#if data.paging?.orderedby === col.key}
							<span class="ml-1">{data.paging?.orderdir === 'ASC' ? '▲' : '▼'}</span>
						{/if}</th
					>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each data.studies as s}
				<tr>
					<td>{s.patient_code}</td>
					<td>{s.patient_firstname}</td>
					<td>{s.patient_lastname}</td>
					<td>{s.patient_age}</td>
					<td>{s.modality_code}</td>
					<td>{s.exam_type_code}</td>
					<td>{s.exam_date_jalali}</td>
					<td>{s.exam_time}</td>
					<td>{s.resident_fullname ?? '-'}</td>
					<td>{s.attending_fullname ?? '-'}</td>
					<td>
						<div class="flex flex-wrap items-center gap-2">
							<span
								class="badge w-20 justify-center whitespace-nowrap
    							{s.audio_report_path ? 'badge-outline badge-success' : 'badge-ghost'}"
							>
								{s.audio_report_path ? 'Audio ✓' : 'No audio'}
							</span>

							<span
								class="badge w-20 justify-center whitespace-nowrap
    							{s.text_report_path ? 'badge-outline badge-success' : 'badge-ghost'}"
							>
								{s.text_report_path ? 'Text ✓' : 'No text'}
							</span>

							<!-- Upload audio -->
							<div class="inline-flex items-center gap-2">
								<input
									id={'aud' + s.id}
									type="file"
									accept="audio/*"
									class="hidden"
									onchange={(e) => uploadAudio(s.id, e.currentTarget.files?.[0])}
								/>
								<label class="bordered btn bg-pink-100 btn-ghost btn-sm" for={'aud' + s.id}>
									{uploadBusy && uploadingFor === s.id ? 'Uploading…' : 'Upload audio'}
								</label>
							</div>

							<!-- Edit / New text -->
							<button
								class="bordered w-20 btn bg-pink-100 btn-ghost btn-sm"
								onclick={() => (reportForStudy = s)}
							>
								{s.text_report_path ? 'Edit text' : 'New text'}
							</button>

							<!-- AI Transcribe -->
							<button
								class={`bordered btn bg-pink-100 btn-outline btn-sm ${transcribingFor === s.id ? 'loading' : ''}`}
								disabled={!s.audio_report_path || transcribingFor === s.id}
								onclick={() => transcribeStudy(s)}
							>
								{#if transcribingFor === s.id}Transcribing…{:else}AI Transcribe{/if}
							</button>
						</div>
					</td>

					<td>
						<div class="flex items-center gap-4">
							<div
								class="tooltip"
								data-tip={!canToggleResidentFor(s)
									? 'Only the corresponding resident (or admin) can sign'
									: !isAdmin && s.attending_checked === 1 && s.resident_checked === 1
										? 'Attending has signed — resident cannot uncheck'
										: 'Toggle resident sign-off'}
							>
								<label class="flex items-center gap-2 text-xs">
									<input
										type="checkbox"
										class="checkbox-xm checkbox"
										checked={s.resident_checked === 1}
										disabled={!canToggleResidentFor(s) ||
											(!isAdmin && s.attending_checked === 1 && s.resident_checked === 1)}
										onchange={(e) =>
											signStudy(s, 'resident', e.currentTarget.checked, e.currentTarget)}
									/>
									Resident
								</label>
							</div>

							<div
								class="tooltip"
								data-tip={!isAdmin && s.resident_checked !== 1
									? 'Resident must sign first'
									: !canToggleAttendingFor(s)
										? 'Only the corresponding attending (or admin) can sign'
										: 'Toggle attending sign-off'}
							>
								<label class="flex items-center gap-2 text-xs">
									<input
										type="checkbox"
										class="checkbox-xm checkbox"
										checked={s.attending_checked === 1}
										disabled={!canToggleAttendingFor(s)}
										onchange={(e) =>
											signStudy(s, 'attending', e.currentTarget.checked, e.currentTarget)}
									/>
									Attending
								</label>
							</div>
						</div>
					</td>

					<td>
						<div class="flex gap-2">
							<button class="btn btn-outline btn-xs" onclick={() => (showEditModal = s)}>
								Edit
							</button>
							<button
								class="btn btn-outline btn-xs btn-error"
								disabled={!canDelete(s)}
								onclick={() => delStudy(s.id)}
							>
								Delete
							</button>
						</div>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
