<script>
	import TypistSignature from './TypistSignature.svelte';
	import { canManageTemplates } from '$lib/template-permissions.js';
	import { isResidentAttendingDelegate } from '$lib/signature-permissions.js';
	import { recordingExaminations } from '$lib/recording-examinations.js';
	let { study, recording, modalities, examTypes, residents, user, onChanged, onReport, onEditStudy, onTemplate } = $props();
	let modality = $state('');
	let examinations = $state([]);
	let nextExaminationKey = 0;
	let resident = $state('');
	let busy = $state(false);
	let generating = $state(false);
	let error = $state('');

	function savedExaminations(value) {
		return recordingExaminations(value).map((exam) => ({ id: String(exam.id), details: exam.exam_details }));
	}
	const savedConfiguration = $derived(JSON.stringify([recording.id, recording.modality_id, savedExaminations(recording), recording.corresponding_resident_id]));
	$effect(() => {
		const [, savedModality, savedExamination, savedResident] = JSON.parse(savedConfiguration);
		modality = String(savedModality ?? '');
		examinations = savedExamination.map((exam) => ({ ...exam, key: nextExaminationKey++ }));
		resident = String(savedResident ?? '');
	});
	const dirty = $derived(modality !== String(recording.modality_id ?? '') || JSON.stringify(examinations.map(({ id, details }) => ({ id, details }))) !== JSON.stringify(savedExaminations(recording)) || resident !== String(recording.corresponding_resident_id ?? ''));
	const configured = $derived(Boolean(recording.modality_id && recording.exam_type_id));
	const assigned = $derived(Boolean(recording.corresponding_resident_id));
	const hasAttending = $derived(Boolean(study.corresponding_attending_id));
	const ready = $derived(configured && assigned && hasAttending);
	const residentSigned = $derived(Boolean(recording.resident_checked));
	const attendingSigned = $derived(Boolean(recording.attending_checked));
	const signed = $derived(residentSigned || attendingSigned || Boolean(recording.typist_checked));
	const readOnly = $derived(user?.role === 'typist' || Boolean(study.disabled));
	const assignmentLocked = $derived(Boolean(recording.resident_assignment_locked));
	const working = $derived(busy || Boolean(recording.processing));
	const admin = $derived(user?.role === 'admin');
	const matchingAttending = $derived(user?.role === 'attending' && hasAttending && Number(user.id) === Number(study.corresponding_attending_id));
	const assignedResident = $derived(user?.role === 'resident' && assigned && Number(user.id) === Number(recording.corresponding_resident_id));
	const canResident = $derived(!study.disabled && (admin || matchingAttending || assignedResident) && (admin || !attendingSigned));
	const canAttending = $derived(!study.disabled && (admin || matchingAttending || isResidentAttendingDelegate(user, recording)) && (attendingSigned || residentSigned));
	const residentOverride = $derived(recording.resident_signed_by_user_id != null && Number(recording.resident_signed_by_user_id) !== Number(recording.corresponding_resident_id));
	const endpoint = $derived(`/api/studies/${study.id}/recordings/${recording.id}`);
	let templateStatus = $state('');
	let templateChecks = $state({});
	let templateError = $state('');
	let templateRetry = $state(0);
	let lastPromptedPair = '';
	const selectedExamIds = $derived([...new Set(examinations.map((exam) => exam.id))]);
	const selectedPair = $derived(!study.disabled && modality && selectedExamIds.length && canManageTemplates(user) && !signed && !working ? `${modality}:${selectedExamIds.join(',')}` : '');

	function examinationName(id) {
		const exam = examTypes.find((option) => String(option.id) === id);
		return exam?.name || exam?.code || id;
	}

	function moveExamination(index, offset) {
		const next = [...examinations];
		[next[index], next[index + offset]] = [next[index + offset], next[index]];
		examinations = next;
	}

	function openTemplate(examId) {
		const key = selectedPair;
		if (!key || !onTemplate || !selectedExamIds.includes(examId)) return;
		onTemplate({ modalityId: modality, examTypeId: examId, onSaved: () => {
			if (selectedPair === key) templateRetry++;
		} });
	}

	$effect(() => {
		const key = selectedPair;
		const attempt = templateRetry;
		templateStatus = '';
		templateChecks = {};
		templateError = '';
		if (!key) return;
		const controller = new AbortController();
		const m = modality, ids = [...selectedExamIds];
		const timer = setTimeout(async () => {
			templateStatus = 'loading';
			try {
				const checks = await Promise.all(ids.map(async (id) => {
					const response = await fetch(`/api/report-templates?modality_id=${encodeURIComponent(m)}&exam_type_id=${encodeURIComponent(id)}&retry=${attempt}`, { signal: controller.signal });
					const rows = await response.json();
					if (!response.ok) throw new Error(rows.error || 'Unable to check template.');
					return [id, rows[0]?.text?.trim() ? 'ready' : 'missing'];
				}));
				if (controller.signal.aborted) return;
				templateChecks = Object.fromEntries(checks);
				const missing = checks.find(([, status]) => status === 'missing')?.[0];
				templateStatus = missing ? 'missing' : 'ready';
				const pair = `${m}:${missing}`;
				if (missing && lastPromptedPair !== pair) {
					lastPromptedPair = pair;
					openTemplate(missing);
				}
			} catch (caught) {
				if (!controller.signal.aborted) { templateStatus = 'error'; templateError = caught.message; }
			}
		}, 300);
		return () => { clearTimeout(timer); controller.abort(); };
	});

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
		if (readOnly || signed) return;
		return act(async () => {
			const result = await request('', 'PATCH', {
				modality_id: modality ? Number(modality) : null,
				examinations: examinations.map((exam) => ({ exam_type_id: Number(exam.id), exam_details: exam.details })),
				corresponding_resident_id: resident ? Number(resident) : null
			});
			modality = String(result.recording.modality_id ?? '');
			examinations = savedExaminations(result.recording).map((exam) => ({ ...exam, key: nextExaminationKey++ }));
			resident = String(result.recording.corresponding_resident_id ?? '');
		});
	}

	async function generate() {
		if (readOnly || dirty || !ready || !recording.audio_report_path || signed || working) return;
		generating = true;
		await act(async () => {
			const result = await request('/transcribe', 'POST');
			onReport({ ...recording, __initialText: result.text });
		});
		generating = false;
	}

	function remove() {
		if (readOnly || signed || working) return;
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
		{#if !readOnly}<button class="btn btn-xs btn-error btn-outline ml-auto" disabled={working || signed} onclick={remove}>Delete recording</button>{/if}
	</div>
	<p class="text-sm">Source: {recording.source || 'legacy'} · Sender: {recording.sender_fullname || 'Unknown'}{#if recording.sender_role} ({recording.sender_role}){/if}<br />Study attending: {study.attending_fullname || 'Not assigned'}</p>
	{#if recording.audio_report_path}
		{#each recording.audio_parts || [{ id: 0 }] as part, index (part.id)}
			{#if recording.audio_parts?.length > 1}<p class="text-sm">Voice part {index + 1}{#if part.sender_fullname} · {part.sender_fullname}{/if}</p>{/if}
			<audio controls preload="none" aria-label={`Voice part ${index + 1}`} src={`${endpoint}/audio?part=${part.id}`} class="w-full"><track kind="captions" /></audio>
		{/each}
		{#if recording.audio_parts?.length > 1}<p class="text-sm">All voice parts are included when you click Transcribe &amp; Generate. Attaching audio does not change the saved report.</p>{/if}
	{:else}<p>No audio available.</p>{/if}
	<fieldset disabled={readOnly || working || signed} class="configuration-fields grid min-w-0 gap-3 md:grid-cols-3" oninput={() => (error = '')} onchange={() => (error = '')}>
		<label class="form-control min-w-0">
			<span class="label-text">Recording resident (required for reports)</span>
			<select class="select select-bordered" bind:value={resident} disabled={assignmentLocked}>
				<option value="">Unassigned / reset</option>
				{#if assigned && !residents.some((option) => Number(option.id) === Number(recording.corresponding_resident_id))}
					<option value={String(recording.corresponding_resident_id)}>{recording.resident_fullname || 'Assigned resident'}</option>
				{/if}
				{#each residents as option (option.id)}<option value={String(option.id)}>{option.full_name}</option>{/each}
			</select>
		</label>
		<label class="form-control min-w-0">
			<span class="label-text">Modality (required)</span>
			<select class="select select-bordered" bind:value={modality}>
				<option value="">Select modality</option>
				{#each modalities as option (option.id)}<option value={String(option.id)}>{option.code} — {option.name}</option>{/each}
			</select>
		</label>
		<label class="form-control min-w-0">
			<span class="label-text">Add examination / body part</span>
			<select class="select select-bordered" value="" onchange={(event) => {
				const id = event.currentTarget.value;
				if (id) examinations = [...examinations, { id, details: '', key: nextExaminationKey++ }];
				event.currentTarget.value = '';
			}}>
				<option value="">Select examination including contrast</option>
				{#each examTypes as option (option.id)}<option value={String(option.id)}>{option.code} — {option.name}</option>{/each}
			</select>
		</label>
		<div class="md:col-span-3 space-y-2">
			<ol class="space-y-2" aria-label="Selected examinations in report order">
				{#each examinations as exam, index (exam.key)}
					<li class="min-w-0 rounded-box border p-3 space-y-2">
						<div class="flex flex-wrap items-center gap-2">
							<span>{index + 1}. {examinationName(exam.id)}</span>
							<button class="btn btn-xs btn-outline" aria-label={`Move examination ${index + 1} up`} disabled={index === 0} onclick={() => moveExamination(index, -1)}>↑</button>
							<button class="btn btn-xs btn-outline" aria-label={`Move examination ${index + 1} down`} disabled={index === examinations.length - 1} onclick={() => moveExamination(index, 1)}>↓</button>
							<button class="btn btn-xs btn-outline" aria-label={`Remove examination ${index + 1}`} onclick={() => examinations = examinations.filter((selected) => selected.key !== exam.key)}>Remove</button>
						</div>
						<label class="form-control min-w-0">
							<span class="label-text">Details / side (optional)</span>
							<input class="input input-bordered" aria-label={`Details / side for examination ${index + 1}`} bind:value={exam.details} maxlength="200" placeholder="e.g. left, right, additional details" />
						</label>
					</li>
				{/each}
			</ol>
			<p class="text-sm opacity-70">Select at least one examination, including its contrast type. One modality applies to all entries. Each entry has its own optional details / side; add the same body part again for different details. Templates merge in this order with separate headings and one shared Conclusion.</p>
		</div>
	</fieldset>
	{#if selectedPair}
		<div class="flex flex-wrap items-center gap-2 text-sm">
			{#if templateStatus === 'loading'}<span role="status">Checking templates…</span>
			{:else if templateStatus === 'error'}<span role="alert">{templateError}</span><button class="btn btn-xs btn-outline" onclick={() => templateRetry++}>Retry template check</button>
			{:else if templateStatus === 'missing' || templateStatus === 'ready'}
				{#if templateStatus === 'missing'}<span class="text-warning">Every selected examination needs a template.</span>{/if}
				{#each selectedExamIds as id (id)}
					<button class="btn btn-xs btn-outline" onclick={() => openTemplate(id)}>{templateChecks[id] === 'missing' ? 'Create' : 'Edit'} template — {examinationName(id)}</button>
				{/each}
			{/if}
		</div>
	{/if}
	<p class="text-sm opacity-70">Configuration changes clear this recording's report and signatures.</p>
	{#if assignmentLocked}<p class="text-sm">Resident locked to Telegram sender: {recording.sender_fullname || recording.resident_fullname || 'assigned resident'}.</p>{/if}
	{#if !assigned}<p class="text-sm">Select and save a resident before creating a report.</p>{/if}
	{#if !hasAttending}<p class="text-sm text-warning">A study attending is required. {#if !readOnly}<button class="btn btn-xs btn-outline" disabled={working || !onEditStudy} onclick={onEditStudy}>Edit study to assign attending</button>{/if}</p>{/if}
	{#if study.disabled}<p class="text-sm text-error">Disabled study: read-only. Telegram voice replies are not processed.</p>
	{:else if readOnly}<p class="text-sm">Typist access: read-only except for printing confirmation.</p>{/if}
	{#if !configured}<p class="text-sm">Select and save modality and examination before creating a report.</p>{/if}
	{#if signed}<p class="text-sm">Signed report: withdraw printing confirmation, then attending and resident signatures before making changes.</p>{/if}
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<div class="flex flex-wrap items-center gap-3">
		{#if !readOnly}
			<button class="btn btn-sm btn-outline" disabled={working || signed || !dirty} onclick={saveConfiguration}>Save configuration</button>
			<button class="btn btn-sm btn-primary" disabled={working || signed || dirty || !ready || !recording.audio_report_path} onclick={generate}>Transcribe & Generate</button>
		{/if}
		{#if dirty}<span class="text-sm">Unsaved configuration</span>{/if}
		<button class="btn btn-sm btn-outline" disabled={(readOnly && !recording.text_report_path) || (!signed && !working && dirty) || (!recording.text_report_path && (working || signed || !ready || dirty))} onclick={() => { error = ''; onReport(recording); }}>{recording.text_report_path ? readOnly || signed || working || !ready ? 'View / print report' : 'Edit / preview / print report' : 'New report'}</button>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" class="checkbox checkbox-sm" checked={residentSigned} disabled={working || (!residentSigned && (dirty || !ready || !recording.text_report_path)) || !canResident} onchange={(event) => sign('resident', event.currentTarget.checked, event.currentTarget)} />Resident signed — {recording.resident_fullname || 'Unassigned'}
		</label>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" class="checkbox checkbox-sm" checked={attendingSigned} disabled={working || (!attendingSigned && (dirty || !ready || !recording.text_report_path || !residentSigned)) || !canAttending} onchange={(event) => sign('attending', event.currentTarget.checked, event.currentTarget)} />Attending signed
		</label>
	</div>
	<TypistSignature {study} {recording} {user} {onChanged} disabled={working} />
	{#if residentSigned}<p class="text-sm">Resident signature by {recording.resident_signer_fullname || 'Unknown signer'}{#if residentOverride} (on behalf of {recording.resident_fullname || 'assigned resident'}){/if}{#if recording.resident_signed_at} · {recording.resident_signed_at}{/if}</p>{/if}
	{#if attendingSigned}<p class="text-sm">Attending signature by {recording.attending_signer_fullname || 'Unknown signer'}{#if recording.attending_signed_at} · {recording.attending_signed_at}{/if}</p>{/if}
	{#if !residentSigned}<p class="text-xs opacity-70">Resident signing: assigned resident, study attending or administrator. Attending approval requires the resident signature.</p>{/if}
</div>

<style>
	.configuration-fields {
		align-items: end;
	}

	.configuration-fields select,
	.configuration-fields input {
		width: 100%;
		min-width: 0;
		max-width: 100%;
	}
</style>
