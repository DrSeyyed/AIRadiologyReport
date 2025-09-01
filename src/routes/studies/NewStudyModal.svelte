<script>
	import { invalidateAll } from '$app/navigation';
	import { toJalaali } from 'jalaali-js';
  import StudyForm from './StudyForm.svelte';

	const now = new Date();
	const { jy: currentJalaliYear } = toJalaali(now.getFullYear(), now.getMonth() + 1, now.getDate());
	const { jy, jm, jd } = toJalaali(now.getFullYear(), now.getMonth() + 1, now.getDate());
	const jalaliToday = `${jy}-${String(jm).padStart(2, '0')}-${String(jd).padStart(2, '0')}`;
	const nowTime = now.toLocaleTimeString('en-GB', { hour12: false });

	function getNowTime() {
		const now = new Date();
		return now.toLocaleTimeString('en-GB', { hour12: false });
	}

	let { data, onClose, onCreated} = $props();
	let successMsg = $state('');

  function setSuccessMsg(msg) {

      successMsg = msg
  }


	async function saveEdit(form) {
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

		// 3) Create the study
		const res = await fetch('/api/studies', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
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
			})
		});
		console.log(res)
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			alert(err?.error || 'Failed to create study');
			return;
		}

		successMsg = 'Study created successfully.';
    if (typeof onCreated === 'function') await onCreated();
		else await invalidateAll();
	}
</script>
<StudyForm {data} {saveEdit} {onClose} {setSuccessMsg} {successMsg}/>