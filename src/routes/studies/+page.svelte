<script>
	import { invalidateAll } from '$app/navigation';
	import NewStudyModal from './NewStudyModal.svelte';
	import EditStudyModal from './EditStudyModal.svelte';
	import RecordingsModal from './RecordingsModal.svelte';
	import StudyTable from './StudyTable.svelte';

	let { data } = $props();
	let showNewModal = $state(false);
	let showEditModal = $state(null);
	let recordingsForStudy = $state(null);
</script>

<section class="space-y-4">
	<StudyTable {data} bind:showNewModal bind:showEditModal bind:recordingsForStudy />
	{#if showNewModal}
		<NewStudyModal bind:data onClose={() => (showNewModal = false)} onCreated={invalidateAll} />
	{/if}
	{#if showEditModal}
		{#key showEditModal.id}
			<EditStudyModal bind:data study={showEditModal} onClose={() => (showEditModal = null)} onSaved={invalidateAll} />
		{/key}
	{/if}
	{#if recordingsForStudy}
		{#key recordingsForStudy.id}
			<RecordingsModal study={recordingsForStudy} {data} onClose={() => (recordingsForStudy = null)} onEditStudy={(study) => { recordingsForStudy = null; showEditModal = study; }} />
		{/key}
	{/if}
</section>
