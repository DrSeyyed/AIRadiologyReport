<script>
	import { toJalaali } from 'jalaali-js';
	import { date, time, year, datetime } from '$lib/time.client';

	let { data, saveEdit, onClose, setSuccessMsg, successMsg, study } = $props();

	console.log(study)
	const form = $state({
		exam_date_jalali: study?.exam_date_jalali ?? $date,
		exam_time: study?.exam_time ?? $time,
		modality_id: study?.modality_id ?? '',
		patient_id: study?.patient_id ?? '',
		patient_code: study?.patient_code ?? '',
		patient_name: study?.patient_firstname ?? '',
		patient_family: study?.patient_lastname ?? '',
		patient_gender: study?.patient_gender ?? 'male',
		patient_age: study?.patient_age ?? '',
		corresponding_resident_id: study?.corresponding_resident_id ?? '',
		corresponding_attending_id: study?.corresponding_attending_id ?? '',
		exam_type_id: study?.exam_type_id ?? '',
		exam_details: study?.exam_details ?? '',
		dicom_url: study?.dicom_url ?? '',
		description: study?.description ?? ''
	});

	let busy = $state(false);
	let patient_code_reserved = $state(study?.patient_code ?? '');

	function resetPatientFields() {
		form.patient_id = '';
		((form.patient_name = ''),
			(form.patient_family = ''),
			(form.patient_gender = 'male'),
			(form.patient_age = ''),
			(form.exam_type_id = ''),
			(form.exam_details = ''),
			(form.dicom_url = ''),
			(form.description = ''));
		patient_code_reserved = '';
	}

	async function onPatientCodeBlurOrEnter(e) {
		const code = (e?.target?.value ?? '').trim();
		form.patient_code = code;
		if (!code) return resetPatientFields();

		busy = true;
		try {
			const res = await fetch(`/api/patients/code/${code}`);
			if (!res.ok) throw new Error('Lookup failed');
			const p = await res.json();
			if (p?.id) {
				form.patient_id = String(p.id);
				form.patient_name = p.firstname;
				form.patient_family = p.lastname;
				form.patient_gender = p.gender;
				form.patient_age = $year - p.birth_year;
				patient_code_reserved = code;
			} else {
				resetPatientFields();
			}
		} catch {
			resetPatientFields();
		} finally {
			busy = false;
		}
	}

	function onPatientCodeChange(e) {
		patient_code_reserved = '';
		setSuccessMsg('');
	}

	async function afterSave(){
		let code = form.patient_code;
		if (!code) return;
		busy = true;
		try {
			const res = await fetch(`/api/patients/code/${code}`);
			if (!res.ok) throw new Error('Lookup failed');
			const p = await res.json();
			if (p?.id) {
				form.patient_id = String(p.id);
				form.patient_name = p.firstname;
				form.patient_family = p.lastname;
				form.patient_gender = p.gender;
				form.patient_age = $year - p.birth_year;
				patient_code_reserved = code;
			}
		} catch {
		} finally {
			busy = false;
		}
	}

	setSuccessMsg('');

	const must = [
		'modality_id',
		'exam_type_id',
		'exam_date_jalali',
		'patient_code',
		'patient_family',
		'patient_name',
		'patient_age',
		'patient_gender',
		'patient_age',
		'corresponding_resident_id',
		'corresponding_attending_id'
	];
	function checkRequiered() {
		for (const k of must) {
			if (!form[k] || String(form[k]).trim() === '') {
				alert(`Missing ${k.replace(/_/g, ' ')}`);
				return false;
			}
		}
		return true;
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

		<div class="divider my-3"></div>

		<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
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

			<!-- Patient (code → autofill existing) -->
			<label class="form-control md:col-span-2">
				<div class="label"><span class="label-text">Patient Code</span></div>
				<input
					class="input-bordered input w-full"
					placeholder="e.g., 156727"
					bind:value={form.patient_code}
					oninput={onPatientCodeChange}
					onblur={onPatientCodeBlurOrEnter}
					onkeydown={(e) => e.key === 'Enter' && onPatientCodeBlurOrEnter(e)}
				/>
				{#if busy}<span class="text-xs opacity-70">checking…</span>{/if}
			</label>

			<label class="form-control">
				<div class="label"><span class="label-text">First Name</span></div>
				<input
					class="input-bordered input w-full"
					bind:value={form.patient_name}
					disabled={patient_code_reserved}
					placeholder="e.g., Ali"
				/>
			</label>

			<label class="form-control">
				<div class="label"><span class="label-text">Family Name</span></div>
				<input
					class="input-bordered input w-full"
					bind:value={form.patient_family}
					disabled={patient_code_reserved}
					placeholder="e.g., Ahmadi"
				/>
			</label>

			<label class="form-control">
				<div class="label"><span class="label-text">Gender</span></div>
				<select
					class="select-bordered select w-full"
					bind:value={form.patient_gender}
					disabled={patient_code_reserved}
				>
					<option value="male">Male</option>
					<option value="female">Female</option>
				</select>
			</label>

			<label class="form-control">
				<div class="label"><span class="label-text">Age (years)</span></div>
				<input
					class="input-bordered input w-full"
					type="number"
					min="0"
					bind:value={form.patient_age}
					disabled={patient_code_reserved}
					placeholder="e.g., 42"
				/>
			</label>

			<!-- Modality -->
			<label class="form-control">
				<div class="label"><span class="label-text">Modality</span></div>
				<select class="select-bordered select w-full" bind:value={form.modality_id} required>
					<option value="" disabled>Select modality</option>
					{#each data.modalities as m}
						<option value={m.id}>{m.code}</option>
					{/each}
				</select>
			</label>

			<!-- Exam Types -->
			<label class="form-control">
				<div class="label"><span class="label-text">Exam Type</span></div>
				<select class="select-bordered select w-full" bind:value={form.exam_type_id} required>
					<option value="" disabled>Select exam type</option>
					{#each data.exam_types as e}
						<option value={e.id}>{e.code}</option>
					{/each}
				</select>
			</label>

			<!-- Staff (numeric coercion) -->
			<label class="form-control">
				<div class="label"><span class="label-text">Resident</span></div>
				<select class="select-bordered select w-full" bind:value={form.corresponding_resident_id}>
					<option value="">(none)</option>
					{#each data.users.filter((u) => u.role === 'resident') as u}
						<option value={u.id}>{u.full_name}</option>
					{/each}
				</select>
			</label>

			<label class="form-control">
				<div class="label"><span class="label-text">Attending</span></div>
				<select class="select-bordered select w-full" bind:value={form.corresponding_attending_id}>
					<option value="">(none)</option>
					{#each data.users.filter((u) => u.role === 'attending') as u}
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
		</div>

		<div class="modal-action">
			<button class="btn btn-ghost" onclick={onClose}>Cancel</button>
			<button
				class="btn btn-primary"
				onclick={() => {
					if (checkRequiered()) {
						saveEdit(form);
						afterSave();
					} else return;
				}}>Save</button
			>
		</div>
	</div>
</div>
