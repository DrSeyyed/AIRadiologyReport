<script>
	let { study, recording, modalities, examTypes, residents, user, onChanged, onReport, onEditStudy } = $props();
	let modality = $state('');
	let examination = $state('');
	let details = $state('');
	let resident = $state('');
	let busy = $state(false);
	let generating = $state(false);
	let error = $state('');

	const savedConfiguration = $derived(JSON.stringify([recording.id, recording.modality_id, recording.exam_type_id, recording.exam_details, recording.corresponding_resident_id]));
	$effect(() => {
		const [, savedModality, savedExamination, savedDetails, savedResident] = JSON.parse(savedConfiguration);
		modality = String(savedModality ?? '');
		examination = String(savedExamination ?? '');
		details = savedDetails ?? '';
		resident = String(savedResident ?? '');
	});
	const dirty = $derived(modality !== String(recording.modality_id ?? '') || examination !== String(recording.exam_type_id ?? '') || details !== (recording.exam_details ?? '') || resident !== String(recording.corresponding_resident_id ?? ''));
	const configured = $derived(Boolean(recording.modality_id && recording.exam_type_id));
	const assigned = $derived(Boolean(recording.corresponding_resident_id));
	const hasAttending = $derived(Boolean(study.corresponding_attending_id));
	const ready = $derived(configured && assigned && hasAttending);
	const residentSigned = $derived(Boolean(recording.resident_checked));
	const attendingSigned = $derived(Boolean(recording.attending_checked));
	const signed = $derived(residentSigned || attendingSigned);
	const assignmentLocked = $derived(Boolean(recording.resident_assignment_locked));
	const working = $derived(busy || Boolean(recording.processing));
	const admin = $derived(user?.role === 'admin');
	const matchingAttending = $derived(user?.role === 'attending' && hasAttending && Number(user.id) === Number(study.corresponding_attending_id));
	const assignedResident = $derived(user?.role === 'resident' && assigned && Number(user.id) === Number(recording.corresponding_resident_id));
	const canResident = $derived((admin || matchingAttending || assignedResident) && (admin || !attendingSigned));
	const canAttending = $derived((admin || matchingAttending) && (attendingSigned || residentSigned));
	const residentOverride = $derived(recording.resident_signed_by_user_id != null && Number(recording.resident_signed_by_user_id) !== Number(recording.corresponding_resident_id));
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
				exam_details: details,
				corresponding_resident_id: resident ? Number(resident) : null
			});
			modality = String(result.recording.modality_id ?? '');
			examination = String(result.recording.exam_type_id ?? '');
			details = result.recording.exam_details ?? '';
			resident = String(result.recording.corresponding_resident_id ?? '');
		});
	}

	async function generate() {
		if (dirty || !ready || !recording.audio_report_path || signed || working) return;
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
		if (working || (role === 'resident' ? !canResident : !canAttending) || (checked && (dirty || !ready || !recording.text_report_path || (role === 'attending' && !residentSigned)))) {
			input.checked = !checked;
			return;
		}
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
		<span class="badge">{recording.text_report_path ? 'Report available' : !ready ? 'Awaiting configuration / staff assignment' : 'Ready to generate'}</span>
		{#if working}<span role="status">{generating ? 'Transcribing & generating…' : 'Processing…'}</span>{/if}
		<button class="btn btn-xs btn-error btn-outline ml-auto" disabled={working || signed} onclick={remove}>Delete recording</button>
	</div>
	<p class="text-sm">Source: {recording.source || 'legacy'} · Sender: {recording.sender_fullname || 'Unknown'}{#if recording.sender_role} ({recording.sender_role}){/if}<br />Study attending: {study.attending_fullname || 'Not assigned'}</p>
	{#if recording.audio_report_path}
		<audio controls preload="none" src={`${endpoint}/audio`} class="w-full"><track kind="captions" /></audio>
	{:else}<p>No audio available.</p>{/if}
	<fieldset disabled={working || signed} class="grid gap-3 md:grid-cols-3" oninput={() => (error = '')} onchange={() => (error = '')}>
		<label class="form-control">
			<span class="label-text">Recording resident (required for reports)</span>
			<select class="select select-bordered" bind:value={resident} disabled={assignmentLocked}>
				<option value="">Unassigned / reset</option>
				{#if assigned && !residents.some((option) => Number(option.id) === Number(recording.corresponding_resident_id))}
					<option value={String(recording.corresponding_resident_id)}>{recording.resident_fullname || 'Assigned resident'}</option>
				{/if}
				{#each residents as option (option.id)}<option value={String(option.id)}>{option.full_name}</option>{/each}
			</select>
		</label>
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
	<p class="text-sm opacity-70">Contrast is part of the examination code. Save resident and examination choices before generating or writing a report. Changes clear only this recording's report and signatures.</p>
	{#if assignmentLocked}<p class="text-sm">Resident assignment is locked to the Telegram resident sender ({recording.sender_fullname || recording.resident_fullname || 'assigned resident'}); it cannot be reassigned.</p>{/if}
	{#if !assigned}<p class="text-sm">Select and save a resident for this recording before generating or writing its report. Telegram attending audio retains the study attending and still needs a resident selected here.</p>{/if}
	{#if !hasAttending}<p class="text-sm text-warning">A study attending is required. <button class="btn btn-xs btn-outline" disabled={working || !onEditStudy} onclick={onEditStudy}>Edit study to assign attending</button></p>{/if}
	{#if !configured}<p class="text-sm">Awaiting configuration: select and save modality and examination including contrast before generating or writing a report.</p>{/if}
	{#if signed}<p class="text-sm">Signed report: uncheck attending first, then resident (or ask an administrator), before editing, configuring or deleting.</p>{/if}
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<div class="flex flex-wrap items-center gap-3">
		<button class="btn btn-sm btn-outline" disabled={working || signed || !dirty} onclick={saveConfiguration}>Save configuration</button>
		<button class="btn btn-sm btn-primary" disabled={working || signed || dirty || !ready || !recording.audio_report_path} onclick={generate}>Transcribe & Generate</button>
		{#if dirty}<span class="text-sm">Unsaved configuration</span>{/if}
		<button class="btn btn-sm btn-outline" disabled={(!signed && !working && dirty) || (!recording.text_report_path && (working || signed || !ready || dirty))} onclick={() => { error = ''; onReport(recording); }}>{recording.text_report_path ? signed || working || !ready ? 'View / print report' : 'Edit / preview / print report' : 'New report'}</button>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" class="checkbox checkbox-sm" checked={residentSigned} disabled={working || (!residentSigned && (dirty || !ready || !recording.text_report_path)) || !canResident} onchange={(event) => sign('resident', event.currentTarget.checked, event.currentTarget)} />Resident signed — {recording.resident_fullname || 'Unassigned'}
		</label>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" class="checkbox checkbox-sm" checked={attendingSigned} disabled={working || (!attendingSigned && (dirty || !ready || !recording.text_report_path || !residentSigned)) || !canAttending} onchange={(event) => sign('attending', event.currentTarget.checked, event.currentTarget)} />Attending signed
		</label>
	</div>
	{#if residentSigned}<p class="text-sm">Resident signature by {recording.resident_signer_fullname || 'Unknown signer'}{#if residentOverride} (on behalf of {recording.resident_fullname || 'assigned resident'}){/if}{#if recording.resident_signed_at} · {recording.resident_signed_at}{/if}</p>{/if}
	{#if attendingSigned}<p class="text-sm">Attending signature by {recording.attending_signer_fullname || 'Unknown signer'}{#if recording.attending_signed_at} · {recording.attending_signed_at}{/if}</p>{/if}
	{#if !residentSigned}<p class="text-xs opacity-70">The assigned resident, administrator or study attending may sign for the resident. Attending approval requires the resident signature first, including for administrators.</p>{/if}
</div>
