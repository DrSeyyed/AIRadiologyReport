<script>
	import { invalidateAll } from '$app/navigation';
	import StudyForm from './StudyForm.svelte';

	let { data = $bindable(), onClose, onCreated } = $props();
	let successMsg = $state('');

	function setSuccessMsg(msg) {
		successMsg = msg;
	}

	async function saveEdit(form) {
		const res = await fetch('/api/studies', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(form)
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			throw new Error(err?.error || 'Failed to create study');
		}

		successMsg = 'Study created successfully.';
		if (typeof onCreated === 'function') await onCreated();
		else await invalidateAll();
	}
</script>

<StudyForm {data} {saveEdit} {onClose} {setSuccessMsg} {successMsg} />
