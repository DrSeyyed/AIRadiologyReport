<script>
	import { invalidateAll } from '$app/navigation';
	import StudyForm from './StudyForm.svelte';

	let { data = $bindable(), study, onClose, onSaved } = $props();
  let successMsg = $state('');
  function setSuccessMsg(msg) {
      successMsg = msg
  }

	async function saveEdit(form) {
		const res = await fetch(`/api/studies/${study.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(form)
		});

		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			throw new Error(err?.error || 'Update failed');
		}

		successMsg = 'Study updated successfully.';
		if (typeof onSaved === 'function') await onSaved();
		else await invalidateAll();
	}
</script>

<StudyForm {data} {saveEdit} {onClose} {setSuccessMsg} {successMsg} {study} />
