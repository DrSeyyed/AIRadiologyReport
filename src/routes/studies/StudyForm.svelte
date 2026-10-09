<script>
	import { date, time } from '$lib/time.client';

	let { data, saveEdit, onClose, setSuccessMsg, successMsg, study } = $props();

	const form = $state({
		exam_date_jalali: study?.exam_date_jalali ?? $date,
		exam_time: study?.exam_time ?? $time,
		modality_id: study?.modality_id ?? '',
		patient_code: study?.patient_code ?? '',
		patient_firstname: study?.patient_firstname ?? '',
		patient_lastname: study?.patient_lastname ?? '',
		patient_gender: study?.patient_gender ?? 'unknown',
		patient_age: study?.patient_age ?? '',
		patient_age_unit: study?.patient_age_unit ?? 'Y',
		corresponding_resident_id: study?.corresponding_resident_id ?? '',
		corresponding_attending_id: study?.corresponding_attending_id ?? '',
		exam_type_id: study?.exam_type_id ?? '',
		exam_details: study?.exam_details ?? '',
		dicom_url: study?.dicom_url ?? '',
		description: study?.description ?? ''
	});

	let busy = $state(false);
	let errorMsg = $state('');

	function clearMessages() {
		setSuccessMsg('');
		errorMsg = '';
	}

	function optionalNumber(value) {
		return value == null || String(value).trim() === '' ? null : Number(value);
	}

	async function submit() {
		if (busy) return;
		clearMessages();
		for (const key of ['modality_id', 'exam_type_id', 'exam_date_jalali', 'patient_code']) {
			if (form[key] == null || String(form[key]).trim() === '') {
				errorMsg = `Missing ${key.replace(/_/g, ' ')}`;
				return;
			}
		}
		if (!form.patient_firstname.trim() && !form.patient_lastname.trim()) {
			errorMsg = 'At least one patient name is required.';
			return;
		}
		const age = optionalNumber(form.patient_age);
		if (age !== null && (!Number.isSafeInteger(age) || age < 0)) {
			errorMsg = 'Age must be a whole number greater than or equal to 0.';
			return;
		}
		busy = true;
		try {
			await saveEdit({
				...form,
				patient_code: form.patient_code.trim(),
				patient_firstname: form.patient_firstname.trim(),
				patient_lastname: form.patient_lastname.trim(),
				patient_age: age,
				modality_id: Number(form.modality_id),
				exam_type_id: Number(form.exam_type_id),
				exam_time: form.exam_time || $time,
				corresponding_resident_id: optionalNumber(form.corresponding_resident_id),
				corresponding_attending_id: optionalNumber(form.corresponding_attending_id),
				exam_details: form.exam_details || null,
				dicom_url: form.dicom_url || null,
				description: form.description || null
			});
		} catch (error) {
			errorMsg = error instanceof Error ? error.message : 'Failed to save study.';
		} finally {
			busy = false;
		}
	}
</script>

<div class="modal-open modal" role="dialog">
	<div class="modal-box max-w-3xl">
		<h3 class="text-lg font-bold">Create/Edit Study</h3>

		{#if successMsg}
			<div class="mt-3 alert alert-success">
				<span>{successMsg}</span>
			</div>
		{/if}

		{#if errorMsg}
			<div class="mt-3 alert alert-error" role="alert"><span>{errorMsg}</span></div>
		{/if}

		<div class="divider my-3"></div>

		<form onsubmit={(event) => { event.preventDefault(); submit(); }} oninput={clearMessages} onchange={clearMessages}>
		<fieldset disabled={busy} class="grid grid-cols-1 gap-4 md:grid-cols-2">
			<!-- Date & Time -->
			<label class="form-control">
				<div class="label"><span class="label-text">Exam Date (Jalali)</span></div>
				<input
					class="input-bordered input w-full"
					placeholder={$date}
					bind:value={form.exam_date_jalali}
					required
				/>
			</label>

			<label class="form-control">
				<div class="label"><span class="label-text">Exam Time</span></div>
				<input
					class="input-bordered input w-full"
					placeholder={$time}
					bind:value={form.exam_time}
				/>
			</label>

			<label class="form-control md:col-span-2">
				<div class="label"><span class="label-text">Patient Code</span></div>
				<input
					class="input-bordered input w-full"
					placeholder="e.g., 156727"
					bind:value={form.patient_code}
					required
				/>
				<span class="text-xs opacity-70">Demographics apply only to this study; provide at least one name.</span>
			</label>

			<label class="form-control">
				<div class="label"><span class="label-text">First Name</span></div>
				<input
					class="input-bordered input w-full"
					bind:value={form.patient_firstname}
					placeholder="e.g., Ali"
				/>
			</label>

			<label class="form-control">
				<div class="label"><span class="label-text">Family Name</span></div>
				<input
					class="input-bordered input w-full"
					bind:value={form.patient_lastname}
					placeholder="e.g., Ahmadi"
				/>
			</label>

			<label class="form-control">
				<div class="label"><span class="label-text">Gender</span></div>
				<select
					class="select-bordered select w-full"
					bind:value={form.patient_gender}
				>
					<option value="unknown">Unknown</option>
					<option value="male">Male</option>
					<option value="female">Female</option>
				</select>
			</label>

			<label class="form-control">
				<div class="label"><span class="label-text">Age (optional)</span></div>
				<input
					class="input-bordered input w-full"
					type="number"
					min="0"
					step="1"
					bind:value={form.patient_age}
					placeholder="Unknown"
				/>
			</label>

			<label class="form-control">
				<div class="label"><span class="label-text">Age Unit</span></div>
				<select class="select-bordered select w-full" bind:value={form.patient_age_unit}>
					<option value="Y">Years</option>
					<option value="M">Months</option>
					<option value="W">Weeks</option>
					<option value="D">Days</option>
				</select>
			</label>

			<!-- Modality -->
			<label class="form-control">
				<div class="label"><span class="label-text">Modality</span></div>
				<select class="select-bordered select w-full" bind:value={form.modality_id} required>
					<option value="" disabled>Select modality</option>
					{#each data.modalities as m (m.id)}
						<option value={m.id}>{m.code}</option>
					{/each}
				</select>
			</label>

			<!-- Exam Types -->
			<label class="form-control">
				<div class="label"><span class="label-text">Exam Type</span></div>
				<select class="select-bordered select w-full" bind:value={form.exam_type_id} required>
					<option value="" disabled>Select exam type</option>
					{#each data.exam_types as e (e.id)}
						<option value={e.id}>{e.code}</option>
					{/each}
				</select>
			</label>

			<!-- Staff (numeric coercion) -->
			<label class="form-control">
				<div class="label"><span class="label-text">Resident</span></div>
				<select class="select-bordered select w-full" bind:value={form.corresponding_resident_id}>
					<option value="">(none)</option>
					{#each data.users.filter((u) => u.role === 'resident') as u (u.id)}
						<option value={u.id}>{u.full_name}</option>
					{/each}
				</select>
			</label>

			<label class="form-control">
				<div class="label"><span class="label-text">Attending</span></div>
				<select class="select-bordered select w-full" bind:value={form.corresponding_attending_id}>
					<option value="">(none)</option>
					{#each data.users.filter((u) => u.role === 'attending') as u (u.id)}
						<option value={u.id}>{u.full_name}</option>
					{/each}
				</select>
			</label>

			<!-- Optional fields -->
			<label class="form-control md:col-span-2">
				<label class="form-control md:col-span-2">
					<div class="label"><span class="label-text">Exam Details (optional)</span></div>
					<input
						class="input-bordered input w-full"
						bind:value={form.exam_details}
						placeholder="Arm..."
					/>
				</label>

				<div class="label"><span class="label-text">DICOM URL (optional)</span></div>
				<input
					class="input-bordered input w-full"
					bind:value={form.dicom_url}
					placeholder="http(s)://..."
				/>
			</label>

			<label class="form-control md:col-span-2">
				<div class="label"><span class="label-text">Description (optional)</span></div>
				<textarea class="textarea-bordered textarea w-full" rows="3" bind:value={form.description}
				></textarea>
			</label>
		</fieldset>

		<div class="modal-action">
			<button type="button" class="btn btn-ghost" disabled={busy} onclick={onClose}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={busy}>
				{busy ? 'Saving…' : 'Save'}
			</button>
		</div>
		</form>
	</div>
</div>
