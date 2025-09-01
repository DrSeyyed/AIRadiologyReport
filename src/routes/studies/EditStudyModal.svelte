<script>
	import { invalidateAll } from '$app/navigation';
	import { toJalaali } from 'jalaali-js';
	import StudyForm from './StudyForm.svelte';

	let { data, study, onClose } = $props();
  let successMsg = $state('');
  function setSuccessMsg(msg) {
      successMsg = msg
  }

	async function saveEdit(form) {
		// If code matches an existing patient, ensure link
		let patientId = form.patient_id;

		if (!patientId) {
			let birth_year = currentJalaliYear - Number(form.patient_age);

			const pr = await fetch('/api/patients', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					patient_code: form.patient_code,
					firstname: form.patient_name,
					lastname: form.patient_family,
					gender: form.patient_gender,
					birth_year
				})
			});
			if (!pr.ok) {
				const err = await pr.json().catch(() => ({}));
				alert(err?.error || 'Failed to create patient');
				return;
			}
			const newPatient = await pr.json();
			patientId = newPatient.id;
		}


		const payload = {
			patient_id: Number(patientId),
			modality_id: Number(form.modality_id),
			exam_type_id: Number(form.exam_type_id),
			exam_details: form.exam_details || null,
			exam_date_jalali: form.exam_date_jalali,
			exam_time: form.exam_time || getNowTime(),
			corresponding_resident_id: Number(form.corresponding_resident_id),
			corresponding_attending_id: Number(form.corresponding_attending_id),
			audio_report_path: null,
			text_report_path: null,
			resident_checked: 0,
			attending_checked: 0,
			dicom_url: form.dicom_url || null,
			description: form.description || null
		};

		const res = await fetch(`/api/studies/${study.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});

		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			alert(err?.error || 'Update failed');
			return;
		}

		successMsg = 'Study updated successfully.';
		if (typeof onSaved === 'function') await onSaved();
		else await invalidateAll();
	}
</script>

<StudyForm {data} {saveEdit} {onClose} {setSuccessMsg} {successMsg} {study} />
