<script>
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';

	let { data } = $props();
	let editingId = $state(null);
	let modalityId = $state('');
	let sourceDescription = $state('');
	let components = $state([{ exam_type_id: '', exam_details: '' }]);
	let busy = $state(false);
	let message = $state('');
	let failure = $state('');

	function resetForm() {
		editingId = null;
		modalityId = '';
		sourceDescription = '';
		components = [{ exam_type_id: '', exam_details: '' }];
		message = '';
		failure = '';
	}

	function editMapping(mapping) {
		editingId = mapping.id;
		modalityId = mapping.modality_id;
		sourceDescription = mapping.source_description;
		components = mapping.components.length
			? mapping.components.map(({ exam_type_id, exam_details }) => ({ exam_type_id, exam_details }))
			: [{ exam_type_id: '', exam_details: '' }];
		message = '';
		failure = '';
	}

	async function mutate(method, body) {
		const response = await fetch('/api/import-mappings', {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		const result = await response.json();
		if (!response.ok) throw new Error(result.error || 'Request failed.');
		await invalidateAll();
		return result;
	}

	async function saveMapping(event) {
		event.preventDefault();
		busy = true;
		message = '';
		failure = '';
		try {
			const saved = await mutate('PUT', {
				modality_id: Number(modalityId),
				source_description: sourceDescription,
				components: components.map((component) => ({
					exam_type_id: Number(component.exam_type_id),
					exam_details: component.exam_details
				}))
			});
			editMapping(saved);
			message = 'Mapping saved. Existing studies were not changed.';
		} catch (error) {
			failure = error instanceof Error ? error.message : 'Unable to save mapping.';
		} finally {
			busy = false;
		}
	}

	async function deleteMapping(mapping) {
		if (!confirm('Delete this import mapping? Existing studies will not change.')) return;
		busy = true;
		message = '';
		failure = '';
		try {
			await mutate('DELETE', { id: mapping.id });
			if (editingId === mapping.id) resetForm();
			message = 'Mapping deleted. Existing studies were not changed.';
		} catch (error) {
			failure = error instanceof Error ? error.message : 'Unable to delete mapping.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>PACS import mappings</title></svelte:head>

<div class="mx-auto max-w-6xl space-y-6 p-4">
	<div class="flex items-center justify-between gap-4">
		<h1 class="text-2xl font-semibold">PACS import mappings</h1>
		<a class="link" href={resolve('/studies')}>Back to studies</a>
	</div>
	<div class="rounded border p-4 text-sm space-y-2">
		<p>
			Match a modality and exact PACS DESCRIPTION, ignoring case and extra whitespace. Punctuation
			such as +, / and _ is preserved.
		</p>
		<p>
			One source row can map to chest, abdomen and separate right/left limbs. Select every exam type
			explicitly, including contrast (WO/WC/WWC) in its code. Use body part / side details such as
			Right or Left where needed.
		</p>
		<p>
			No description splitting or abbreviation guessing is performed. These mappings apply to future
			imports only; existing studies are not changed.
		</p>
	</div>

	{#if failure}<p class="text-error" role="alert">{failure}</p>{/if}
	{#if message}<p class="text-success" role="status">{message}</p>{/if}

	<form class="rounded border p-4 space-y-4" onsubmit={saveMapping}>
		<h2 class="text-lg font-semibold">{editingId === null ? 'New mapping' : 'Edit mapping'}</h2>
		<fieldset disabled={busy} class="space-y-4">
			<div class="grid gap-4 md:grid-cols-2">
				<label class="block space-y-1">
					<span>Source modality</span>
					<select
						class="select select-bordered w-full"
						bind:value={modalityId}
						required
						disabled={editingId !== null}
					>
						<option value="" disabled>Select modality</option>
						{#each data.modalities as modality (modality.id)}
							<option value={modality.id}>{modality.code} — {modality.name}</option>
						{/each}
					</select>
				</label>
				<label class="block space-y-1">
					<span>Exact source DESCRIPTION</span>
					<input
						class="input input-bordered w-full"
						bind:value={sourceDescription}
						maxlength="500"
						required
						readonly={editingId !== null}
					/>
				</label>
			</div>
			{#if editingId !== null}
				<p class="text-sm opacity-70">
					Source identity is fixed while editing. Use New mapping to configure a different source.
				</p>
			{/if}
			<h3 class="font-medium">Study components ({components.length}/30)</h3>
			{#each components as component, index (component)}
				<div class="grid items-end gap-3 md:grid-cols-[1fr_1fr_auto]">
					<label class="block space-y-1">
						<span>Exam type / contrast — component {index + 1}</span>
						<select
							class="select select-bordered w-full"
							bind:value={component.exam_type_id}
							required
						>
							<option value="" disabled>Select exam type explicitly</option>
							{#each data.exam_types as examType (examType.id)}
								<option value={examType.id}>{examType.code} — {examType.name}</option>
							{/each}
						</select>
					</label>
					<label class="block space-y-1">
						<span>Body part / side detail — component {index + 1}</span>
						<input
							class="input input-bordered w-full"
							bind:value={component.exam_details}
							maxlength="200"
							placeholder="e.g. Right or Left"
						/>
					</label>
					<button
						class="btn btn-outline"
						type="button"
						aria-label={`Remove component ${index + 1}`}
						onclick={() => (components = components.filter((_, i) => i !== index))}>Remove</button
					>
				</div>
			{/each}
			{#if components.length === 0}<p class="text-warning">
					Unmapped — add at least one explicitly selected component to save.
				</p>{/if}
			<div class="flex flex-wrap gap-2">
				<button
					class="btn btn-outline"
					type="button"
					disabled={components.length >= 30}
					onclick={() => (components = [...components, { exam_type_id: '', exam_details: '' }])}
					>Add component</button
				>
				<button class="btn btn-primary" type="submit" disabled={components.length === 0}
					>{busy ? 'Saving…' : 'Save mapping'}</button
				>
				<button class="btn btn-outline" type="button" onclick={resetForm}>New mapping</button>
			</div>
		</fieldset>
	</form>

	<section class="rounded border p-4 space-y-3" aria-labelledby="mapping-list-heading">
		<h2 id="mapping-list-heading" class="text-lg font-semibold">Configured sources</h2>
		{#if data.mappings.length === 0}
			<p>No import mappings yet.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="table w-full">
					<thead
						><tr
							><th>Source modality</th><th>Exact DESCRIPTION</th><th>Study components</th><th
								>Actions</th
							></tr
						></thead
					>
					<tbody>
						{#each data.mappings as mapping (mapping.id)}
							<tr>
								<td>{mapping.modality_code} — {mapping.modality_name}</td>
								<td class="whitespace-pre-wrap break-words">{mapping.source_description}</td>
								<td>
									{#if mapping.components.length === 0}
										<span class="badge badge-warning">Unmapped</span>
										<p class="text-sm">No components configured. Edit to select them explicitly.</p>
									{:else}
										<ul class="space-y-2">
											{#each mapping.components as component (component)}
												<li>
													<div>{component.exam_type_code} — {component.exam_type_name}</div>
													<div class="text-sm opacity-70">
														Body part / side: {component.exam_details || 'Not specified'}
													</div>
												</li>
											{/each}
										</ul>
									{/if}
								</td>
								<td>
									<div class="flex gap-2">
										<button
											class="btn btn-sm btn-outline"
											type="button"
											disabled={busy}
											onclick={() => editMapping(mapping)}>Edit</button
										>
										<button
											class="btn btn-sm btn-outline btn-error"
											type="button"
											disabled={busy}
											onclick={() => deleteMapping(mapping)}>Delete</button
										>
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>
