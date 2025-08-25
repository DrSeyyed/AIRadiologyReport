<script>
	import { invalidateAll } from '$app/navigation';
	import NewStudyModal from './NewStudyModal.svelte';
	import EditStudyModal from './EditStudyModal.svelte';
	import ReportModal from './ReportModal.svelte';
	import Filters from './Filters.svelte';
	import StudyForm from './StudyForm.svelte';
	import StudyTable from './StudyTable.svelte';

	let { data } = $props();
	let showNewModal = $state(false);
	let showEditModal = $state(false);
	let reportForStudy = $state(null); // study to edit text


	





	function onEdited() {
		ShowEdit = false;
		return invalidateAll();
	}

	function onCreated() {
		showNew = false;
		return invalidateAll();
	}

</script>

<section class="space-y-4">
	<StudyTable {data} bind:showNewModal={showNewModal} bind:showEditModal={showEditModal} bind:reportForStudy={reportForStudy}/>

	<!-- Modals -->
	{#if showNewModal}
		<NewStudyModal bind:data = {data} onClose={() => (invalidateAll(), (showNewModal = false))} {onCreated} />
	{/if}

	{#if showEditModal}
		<EditStudyModal bind:data = {data} study={showEditModal} onClose={() => (showEditModal = null)} onSaved={onEdited} />
	{/if}

	{#if reportForStudy}
		<ReportModal
			study={reportForStudy}
			initialText={reportForStudy.__initialText ?? ''}
			onClose={() => (reportForStudy = null)}
		/>
	{/if}
</section>
