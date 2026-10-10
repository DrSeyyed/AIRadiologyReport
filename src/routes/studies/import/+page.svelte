<script>
	import { resolve } from '$app/paths';
	import { SvelteSet } from 'svelte/reactivity';
	let { data } = $props();
	let file = $state(null);
	let preview = $state(null);
	const selected = new SvelteSet();
	let busy = $state(false);
	let error = $state('');
	let success = $state('');
	let resident = $state('');
	let attending = $state('');
	let notifyTelegram = $state(true);
	let visible = $state(200);
	const ready = $derived(preview?.rows.filter((row) => row.status === 'ready') ?? []);
	const unresolved = $derived(
		preview?.rows.filter((row) => ['invalid', 'conflict'].includes(row.status))
			.length ?? 0
	);

	function resetPreview() {
		preview = null;
		selected.clear();
		error = '';
		success = '';
		visible = 200;
	}

	function toggle(row, checked) {
		if (checked) selected.add(row);
		else selected.delete(row);
	}

	function selectRows(rows) {
		selected.clear();
		for (const row of rows) selected.add(row.row);
	}

	async function submit(action) {
		if (!file || busy) return;
		busy = true;
		error = '';
		success = '';
		try {
			const form = new FormData();
			form.append('file', file);
			form.append('action', action);
			form.append('corresponding_resident_id', resident);
			form.append('corresponding_attending_id', attending);
			if (action === 'import') {
				form.append('token', preview.token);
				form.append('selected_rows', JSON.stringify([...selected]));
				form.append('notify_telegram', String(notifyTelegram));
			}
			const response = await fetch('/api/studies/import', { method: 'POST', body: form });
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Import failed');
			if (action === 'preview') {
				preview = result;
				selectRows(result.rows.filter((row) => row.status === 'ready'));
				visible = 200;
			} else {
				success = `${result.inserted} studies imported; ${result.skipped} duplicate rows skipped.`;
				preview = null;
				selected.clear();
			}
		} catch (caught) {
			error = caught.message || 'Import failed';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Import studies from Excel</title></svelte:head>

<div class="space-y-4 p-4">
	<div class="flex flex-wrap items-center gap-4">
		<h1 class="text-2xl font-bold">Import studies from Excel</h1>
		<a class="btn btn-ghost" href={resolve('/studies')}>Back to studies</a>
	</div>
	<p>
		Patient ID and demographics are saved on each study, without linking patients. Age is taken
		directly from the export; birth date is not used.
	</p>
	<p>
		Each Excel row creates one study. Original modality and description are saved as reference only;
		no examination selection or description mapping is required. Add audio recordings later and
		select modality, examination/body part including contrast, and optional details/side for each
		recording before Transcribe &amp; Generate. Telegram audio replies append recordings; configure
		and generate reports on this site.
	</p>
	<form
		class="flex flex-wrap items-end gap-4"
		onsubmit={(event) => {
			event.preventDefault();
			submit('preview');
		}}
	>
		<label class="form-control">
			<span class="label-text">Excel file (XLS/XLSX, up to 10 MB and 5,000 rows)</span>
			<input
				class="file-input file-input-bordered"
				type="file"
				accept=".xls,.xlsx"
				disabled={busy}
				onchange={(event) => {
					file = event.currentTarget.files?.[0] ?? null;
					resetPreview();
				}}
				required
			/>
		</label>
		<label class="form-control">
			<span class="label-text">Resident (optional)</span>
			<select class="select select-bordered" bind:value={resident} disabled={busy}>
				<option value="">Unassigned</option>
				{#each data.users.filter((user) => user.role === 'resident') as user (user.id)}<option
						value={String(user.id)}>{user.full_name}</option
					>{/each}
			</select>
		</label>
		<label class="form-control">
			<span class="label-text">Attending (optional)</span>
			<select class="select select-bordered" bind:value={attending} disabled={busy}>
				<option value="">Unassigned</option>
				{#each data.users.filter((user) => user.role === 'attending') as user (user.id)}<option
						value={String(user.id)}>{user.full_name}</option
					>{/each}
			</select>
		</label>
		<button class="btn btn-primary" disabled={!file || busy}
			>{busy ? 'Working…' : 'Preview / refresh preview'}</button
		>
	</form>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	{#if success}<div class="alert alert-success" role="status">
			{success} <a class="link" href={resolve('/studies')}>View studies</a>
		</div>{/if}
	{#if preview}
		<div class="flex flex-wrap items-center gap-4">
			<p>
				{preview.rows.length} source rows; {ready.length} ready; {unresolved} unresolved.
				Duplicate rows will be skipped. Each selected ready row imports one study.
			</p>
			<button class="btn btn-sm" disabled={busy} onclick={() => selectRows(ready)}
				>Select all ready</button
			>
			<button class="btn btn-sm" disabled={busy} onclick={() => selected.clear()}
				>Clear selection</button
			>
		</div>
		<div class="overflow-x-auto">
			<table class="table table-zebra">
				<thead
					><tr
						><th>Select</th><th>Row / UID</th><th>Patient ID / name</th><th>Gender / age</th><th
							>Modality / description</th
						><th>Date / time</th><th>Status / errors</th></tr
					></thead
				>
				<tbody>
					{#each preview.rows.slice(0, visible) as row (row.row)}
						<tr>
							<td
								><input
									class="checkbox"
									type="checkbox"
									aria-label={`Import row ${row.row}`}
									checked={selected.has(row.row)}
									disabled={busy || row.status !== 'ready'}
									onchange={(event) => toggle(row.row, event.currentTarget.checked)}
								/></td
							>
							<td
								>{row.row}
								<div class="max-w-40 break-all text-xs">{row.source_study_uid}</div></td
							>
							<td
								>{row.patient_code}
								<div>{row.patient_firstname} {row.patient_lastname}</div></td
							>
							<td
								>{row.patient_gender}
								<div>
									{row.patient_age == null
										? 'Unknown age'
										: `${row.patient_age} ${{ Y: 'years', M: 'months', W: 'weeks', D: 'days' }[row.patient_age_unit]}`}
								</div></td
							>
							<td
								>{row.source_modality ?? row.modality_code ?? 'Not specified'}
								<div>{row.source_description}</div></td
							>
							<td
								>{row.exam_date_jalali}
								<div>{row.exam_time}</div></td
							>
							<td
								><span class:font-bold={row.status === 'ready'}>{row.status}</span
								>{#each row.errors ?? [] as message, index (index)}<div class="text-error">
										{message}
									</div>{/each}</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if preview.rows.length > visible}<button class="btn btn-sm" onclick={() => (visible += 200)}
				>Show 200 more rows</button
			>{/if}
		{#if preview.telegramConfigured}
			<label class="flex items-center gap-2"
				><input
					class="checkbox"
					type="checkbox"
					bind:checked={notifyTelegram}
					disabled={busy}
				/>Queue Telegram study messages (sent gradually; import does not wait for Telegram)</label
			>
		{/if}
		<button
			class="btn btn-success"
			disabled={busy || !selected.size}
			onclick={() => submit('import')}>Confirm import of {selected.size} selected rows</button
		>
	{/if}
</div>
