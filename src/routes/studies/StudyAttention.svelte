<script>
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { canUpdateStudyAttention } from '$lib/study-permissions.js';

	let { study, user } = $props();
	let checked = $state(untrack(() => Boolean(study.needs_attention)));
	let note = $state(untrack(() => study.attention_note || ''));
	let saving = $state(false);
	let error = $state('');
	let warning = $state('');
	let saved = $state(false);
	const editable = $derived(!study.disabled && canUpdateStudyAttention(user));
	const changed = $derived(checked !== Boolean(study.needs_attention) || note !== (study.attention_note || ''));

	$effect(() => {
		checked = Boolean(study.needs_attention);
		note = study.attention_note || '';
	});

	async function save(event) {
		event.preventDefault();
		if (!editable || saving) return;
		saving = true;
		error = '';
		warning = '';
		saved = false;
		try {
			const response = await fetch(`/api/studies/${study.id}/attention`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ needs_attention: checked, attention_note: note })
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Unable to save attention note.');
			warning = result.notification_warning || '';
			await invalidateAll();
			saved = true;
		} catch (caught) {
			error = caught.message || 'Unable to save attention note.';
		} finally {
			saving = false;
		}
	}
</script>

<div class="min-w-[13rem] max-w-xs whitespace-normal">
	{#if editable}
		<form onsubmit={save} class="space-y-2">
			<label class="flex items-center gap-2">
				<input type="checkbox" class="checkbox checkbox-warning checkbox-sm" bind:checked disabled={saving} onchange={() => (saved = false)} />
				<span>Needs attention</span>
			</label>
			<label class="block">
				<span class="text-xs">Short description (optional)</span>
				<textarea class="textarea textarea-bordered textarea-xs w-full" aria-label="Attention description" rows="2" maxlength="300" placeholder="Repeat imaging, more history needed…" bind:value={note} disabled={saving} oninput={() => (saved = false)}></textarea>
			</label>
			<div class="flex items-center gap-2">
				<button type="submit" class="btn btn-outline btn-xs" aria-label="Save attention note" disabled={saving || !changed}>{saving ? 'Saving…' : 'Save'}</button>
				{#if saved}<span role="status" class="text-xs">Saved</span>{/if}
			</div>
			{#if warning}<p role="status" class="text-warning text-xs">{warning}</p>{/if}
			{#if error}<p role="alert" class="text-error text-xs">{error}</p>{/if}
		</form>
	{:else}
		<label class="flex items-center gap-2">
			<input type="checkbox" class="checkbox checkbox-warning checkbox-sm" checked={Boolean(study.needs_attention)} disabled />
			<span>Needs attention</span>
		</label>
		{#if study.attention_note}<p class="mt-1 whitespace-pre-wrap break-words text-xs">{study.attention_note}</p>{/if}
	{/if}
	{#if !study.needs_attention && study.attention_note}<p class="mt-1 text-xs opacity-70">Note retained for reference.</p>{/if}
</div>
