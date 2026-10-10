<script>
	let { study, recording, modalities, examTypes, user, onChanged, onReport } = $props();
	let modality = $state('');
	let examination = $state('');
	let details = $state('');
	let busy = $state(false);
	let generating = $state(false);
	let error = $state('');

	const savedConfiguration = $derived(JSON.stringify([recording.id, recording.modality_id, recording.exam_type_id, recording.exam_details]));
	$effect(() => {
		const [, savedModality, savedExamination, savedDetails] = JSON.parse(savedConfiguration);
		modality = String(savedModality ?? '');
		examination = String(savedExamination ?? '');
		details = savedDetails ?? '';
	});
	const dirty = $derived(modality !== String(recording.modality_id ?? '') || examination !== String(recording.exam_type_id ?? '') || details !== (recording.exam_details ?? ''));
	const configured = $derived(Boolean(recording.modality_id && recording.exam_type_id));
	const signed = $derived(recording.resident_checked === 1 || recording.attending_checked === 1);
	const working = $derived(busy || recording.processing === 1);
	const admin = $derived(user?.role === 'admin');
	const canResident = $derived(admin || (user?.role === 'resident' && user.id === study.corresponding_resident_id && recording.attending_checked !== 1));
	const canAttending = $derived(admin || (user?.role === 'attending' && user.id === study.corresponding_attending_id && (recording.resident_checked === 1 || recording.attending_checked === 1)));
	const endpoint = $derived(`/api/studies/${study.id}/recordings/${recording.id}`);

	async function request(suffix, method, body) {
		const response = await fetch(`${endpoint}${suffix}`, {
			method,
			...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
		});
		const result = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(result.error || 'Recording action failed');
		return result;
	}

	async function act(action) {
		if (working) return;
		error = '';
		busy = true;
		try {
			await action();
			await onChanged();
		} catch (caught) {
			error = caught.message || 'Recording action failed';
		} finally {
			busy = false;
		}
	}

	function saveConfiguration() {
		if (signed) return;
		return act(async () => {
			const result = await request('', 'PATCH', {
				modality_id: modality ? Number(modality) : null,
				exam_type_id: examination ? Number(examination) : null,
				exam_details: details
			});
			modality = String(result.recording.modality_id ?? '');
			examination = String(result.recording.exam_type_id ?? '');
			details = result.recording.exam_details ?? '';
		});
	}

	async function generate() {
		if (dirty || !configured || !recording.audio_report_path || signed || working) return;
		generating = true;
		await act(async () => {
			const result = await request('/transcribe', 'POST');
			onReport({ ...recording, __initialText: result.text });
		});
		generating = false;
	}

	function remove() {
		if (signed || working) return;
		if (confirm(`Delete recording #${recording.id} and its report? This cannot be undone.`)) {
			return act(() => request('', 'DELETE'));
		}
	}

	function sign(role, checked, input) {
		return act(async () => {
			try {
				await request('/sign', 'POST', { role, checked });
			} catch (caught) {
				input.checked = !checked;
				throw caught;
			}
		});
	}
</script>

<div class="rounded-box border border-base-content/20 p-4 space-y-3">
	<div class="flex flex-wrap items-center gap-3">
		<h4 class="font-semibold">Recording #{recording.id}</h4>
		<span class="badge">{!configured ? 'Awaiting configuration' : recording.text_report_path ? 'Report available' : 'Ready to generate'}</span>
		{#if working}<span role="status">{generating ? 'Transcribing & generating…' : 'Processing…'}</span>{/if}
		<button class="btn btn-xs btn-error btn-outline ml-auto" disabled={working || signed} onclick={remove}>Delete recording</button>
	</div>
	{#if recording.audio_report_path}
		<audio controls preload="none" src={`${endpoint}/audio`} class="w-full"><track kind="captions" /></audio>
	{:else}<p>No audio available.</p>{/if}
	<fieldset disabled={working || signed} class="grid gap-3 md:grid-cols-3" oninput={() => (error = '')} onchange={() => (error = '')}>
		<label class="form-control">
			<span class="label-text">Modality (required)</span>
			<select class="select select-bordered" bind:value={modality}>
				<option value="">Select modality</option>
				{#each modalities as option (option.id)}<option value={String(option.id)}>{option.code} — {option.name}</option>{/each}
			</select>
		</label>
		<label class="form-control">
			<span class="label-text">Examination / body part & contrast (required)</span>
			<select class="select select-bordered" bind:value={examination}>
				<option value="">Select examination including contrast</option>
				{#each examTypes as option (option.id)}<option value={String(option.id)}>{option.code} — {option.name}</option>{/each}
			</select>
		</label>
		<label class="form-control">
			<span class="label-text">Details / side (optional)</span>
			<input class="input input-bordered" bind:value={details} maxlength="200" placeholder="e.g. left, additional details" />
		</label>
	</fieldset>
	<p class="text-sm opacity-70">Contrast is part of the examination code. Save choices before generating. Changing configuration clears only this recording's report and signatures.</p>
	{#if !configured}<p class="text-sm">Awaiting configuration: select and save modality and examination including contrast before generating or writing a report.</p>{/if}
	{#if signed}<p class="text-sm">Signed report: uncheck attending first, then resident (or ask an administrator), before editing, configuring or deleting.</p>{/if}
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<div class="flex flex-wrap items-center gap-3">
		<button class="btn btn-sm btn-outline" disabled={working || signed || !dirty} onclick={saveConfiguration}>Save configuration</button>
		<button class="btn btn-sm btn-primary" disabled={working || signed || dirty || !configured || !recording.audio_report_path} onclick={generate}>Transcribe & Generate</button>
		{#if dirty}<span class="text-sm">Unsaved configuration</span>{/if}
		<button class="btn btn-sm btn-outline" disabled={dirty || (!recording.text_report_path && (working || signed || !configured))} onclick={() => { error = ''; onReport(recording); }}>{recording.text_report_path ? signed || working ? 'View / print report' : 'Edit / preview / print report' : 'New report'}</button>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" class="checkbox checkbox-sm" checked={recording.resident_checked === 1} disabled={working || (!recording.resident_checked && (dirty || !recording.text_report_path)) || !canResident} onchange={(event) => sign('resident', event.currentTarget.checked, event.currentTarget)} />Resident signed
		</label>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" class="checkbox checkbox-sm" checked={recording.attending_checked === 1} disabled={working || (!recording.attending_checked && (dirty || !recording.text_report_path)) || !canAttending} onchange={(event) => sign('attending', event.currentTarget.checked, event.currentTarget)} />Attending signed
		</label>
	</div>
</div>
