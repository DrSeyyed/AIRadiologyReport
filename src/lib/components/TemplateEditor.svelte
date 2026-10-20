<script>
	import { onDestroy, untrack } from 'svelte';
	import SearchableSelect from './SearchableSelect.svelte';
	let { modalities, examTypes, initialModalityId = '', initialExamTypeId = '', onSaved, onCancel, onBusyChange } = $props();
	const initial = untrack(() => ({ modality: String(initialModalityId), examination: String(initialExamTypeId) }));
	let modality = $state(initial.modality);
	let examination = $state(initial.examination);
	let id = $state(null);
	let text = $state('');
	let original = $state('');
	let loadedPair = $state('');
	let loading = $state(false);
	let generating = $state(false);
	let saving = $state(false);
	let error = $state('');
	let message = $state('');
	let retry = $state(0);
	let disposed = false;
	let actionController;
	const pair = $derived(modality && examination ? `${modality}:${examination}` : '');
	const ready = $derived(Boolean(pair && loadedPair === pair));
	const busy = $derived(generating || saving);

	$effect(() => { onBusyChange?.(busy); });
	$effect(() => {
		const currentPair = pair;
		retry;
		loadedPair = '';
		error = '';
		message = '';
		if (!currentPair) { loading = false; return; }
		const controller = new AbortController();
		loading = true;
		fetch(`/api/report-templates?modality_id=${encodeURIComponent(modality)}&exam_type_id=${encodeURIComponent(examination)}`, { signal: controller.signal })
			.then(async (response) => {
				const result = await response.json();
				if (!response.ok) throw new Error(result.error || 'Unable to load template.');
				if (controller.signal.aborted) return;
				id = result[0]?.id ?? null;
				text = result[0]?.text ?? '';
				original = text;
				loadedPair = currentPair;
			})
			.catch((caught) => { if (!controller.signal.aborted) error = caught.message; })
			.finally(() => { if (!controller.signal.aborted) loading = false; });
		return () => controller.abort();
	});
	onDestroy(() => { disposed = true; actionController?.abort(); });

	function choose(field, value) {
		const previous = field === 'modality' ? modality : examination;
		if (value === previous) return true;
		if (text !== original && !confirm('Discard the unsaved template draft?')) return false;
		if (field === 'modality') modality = value;
		else examination = value;
		id = null;
		text = '';
		original = '';
		return true;
	}

	async function submit(generate) {
		if (busy || !ready || (!generate && !text.trim())) return;
		if (generate && text.trim() && !confirm('Replace the current draft with an AI-generated template?')) return;
		error = '';
		message = '';
		if (generate) generating = true; else saving = true;
		actionController = new AbortController();
		try {
			const response = await fetch(`/api/report-templates${generate ? '/generate' : ''}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				signal: actionController.signal,
				body: JSON.stringify({ modality_id: Number(modality), exam_type_id: Number(examination), ...(generate ? {} : { id, text, create_only: id === null }) })
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Template action failed.');
			if (disposed) return;
			if (generate) {
				text = result.text;
				message = 'Draft generated. Review and save.';
			} else {
				id = result.id;
				text = result.text;
				original = text;
				message = 'Saved ✓';
				await onSaved?.(result);
			}
		} catch (caught) {
			if (!disposed) error = caught.message || 'Template action failed.';
		} finally {
			if (!disposed) { generating = false; saving = false; }
		}
	}
</script>

<div class="space-y-3">
	<fieldset disabled={busy} class="grid gap-3 md:grid-cols-2">
		<label class="form-control min-w-0">
			<span class="label-text">Modality</span>
			<select class="select select-bordered w-full" value={modality} onchange={(event) => { if (!choose('modality', event.currentTarget.value)) event.currentTarget.value = modality; }}>
				<option value="">Select modality</option>
				{#each modalities as option (option.id)}<option value={String(option.id)}>{option.code} — {option.name}</option>{/each}
			</select>
		</label>
		<SearchableSelect label="Examination / body part" options={examTypes} emptyLabel="Select examination"
			bind:value={() => examination, (value) => choose('examination', value)} />
	</fieldset>
	{#if loading}<p role="status">Loading template…</p>{/if}
	<div class="flex flex-wrap gap-2">
		<button type="button" class="btn btn-outline" disabled={!ready || busy} onclick={() => submit(true)}>{generating ? 'Generating…' : 'Generate with AI'}</button>
		<button type="button" class="btn btn-primary" disabled={!ready || busy || !text.trim()} onclick={() => submit(false)}>{saving ? 'Saving…' : 'Save template'}</button>
		{#if onCancel}<button type="button" class="btn btn-ghost" disabled={busy} onclick={onCancel}>Cancel</button>{/if}
	</div>
	<p class="text-xs opacity-70">AI drafts normal findings, one structure per line. Review before saving; this does not create a patient report.</p>
	<label class="form-control">
		<span class="label-text">Template text</span>
		<textarea class="textarea textarea-bordered min-h-[280px] w-full" bind:value={text} maxlength="50000" disabled={!ready || busy} placeholder="Write a template or generate an AI draft."></textarea>
	</label>
	{#if message}<p role="status" class="text-success">{message}</p>{/if}
	{#if error}
		<div class="alert alert-error" role="alert">{error}</div>
		{#if !ready && pair}<button type="button" class="btn btn-sm btn-outline" onclick={() => retry++}>Retry loading</button>{/if}
	{/if}
</div>
