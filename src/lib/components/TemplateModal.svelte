<script>
	import TemplateEditor from './TemplateEditor.svelte';
	let { modalities, examTypes, modalityId, examTypeId, onSaved, onClose } = $props();
	let busy = $state(false);
</script>

<svelte:window onkeydown={(event) => {
	if (event.key === 'Escape') {
		event.stopImmediatePropagation();
		if (!busy) onClose();
	}
}} />
<div class="modal modal-open z-[1100]">
	<div role="dialog" aria-modal="true" aria-labelledby="template-editor-title" class="modal-box max-w-4xl space-y-4">
		<h3 id="template-editor-title" class="text-lg font-bold">Report template</h3>
		<TemplateEditor {modalities} {examTypes} initialModalityId={modalityId} initialExamTypeId={examTypeId} {onSaved} onCancel={onClose} onBusyChange={(value) => (busy = value)} />
	</div>
</div>
