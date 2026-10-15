<script>
	import { onMount, onDestroy } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import RecordingCard from './RecordingCard.svelte';
	import ReportModal from './ReportModal.svelte';
	import TemplateModal from '$lib/components/TemplateModal.svelte';
	import { studyLabel } from '$lib/study-label.js';

	let { study, data, onClose, onEditStudy } = $props();
	let detail = $state(null);
	let loading = $state(true);
	let busy = $state(false);
	let error = $state('');
	let report = $state(null);
	let template = $state(null);
	let recordingAudio = $state(false);
	let recorder;
	let stream;
	let disposed = false;
	let cancelCapture = false;
	let fileInput;
	const readOnly = $derived(data.user?.role === 'typist');

	async function refresh() {
		const response = await fetch(`/api/studies/${study.id}`);
		const result = await response.json();
		if (!response.ok) throw new Error(result.error || 'Unable to load recordings');
		if (!disposed) detail = result;
	}

	async function changed() {
		await Promise.all([refresh(), invalidateAll()]);
	}

	onMount(() => {
		refresh().catch((caught) => (error = caught.message)).finally(() => (loading = false));
		const timer = setInterval(() => {
			if (detail?.recordings?.some((item) => item.processing === 1)) {
				changed().catch((caught) => (error = caught.message));
			}
		}, 5000);
		return () => clearInterval(timer);
	});

	function stopStream() {
		stream?.getTracks().forEach((track) => track.stop());
		stream = undefined;
	}

	onDestroy(() => {
		disposed = true;
		cancelCapture = true;
		if (recorder?.state === 'recording') recorder.stop();
		stopStream();
	});

	async function upload(file) {
		if (readOnly || !file || busy || disposed) return;
		error = '';
		busy = true;
		try {
			const form = new FormData();
			form.append('file', file);
			const response = await fetch(`/api/studies/${study.id}/recordings`, { method: 'POST', body: form });
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Audio upload failed');
			await changed();
		} catch (caught) {
			error = caught.message || 'Audio upload failed';
		} finally {
			busy = false;
			if (fileInput) fileInput.value = '';
		}
	}

	async function startRecording() {
		if (readOnly || busy || recordingAudio) return;
		error = '';
		busy = true;
		try {
			if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
				throw new Error('Microphone recording is unavailable. Use HTTPS or localhost, or upload an audio file.');
			}
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (disposed) { stopStream(); return; }
			cancelCapture = false;
			const chunks = [];
			const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg'].find((type) => MediaRecorder.isTypeSupported(type));
			if (!mimeType) throw new Error('No supported microphone audio format. Upload an audio file instead.');
			recorder = new MediaRecorder(stream, { mimeType });
			recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
			recorder.onstop = () => {
				stopStream();
				recordingAudio = false;
				if (disposed || cancelCapture) return;
				const type = recorder.mimeType || chunks[0]?.type || mimeType;
				const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
				const blob = new Blob(chunks, { type });
				if (!blob.size) { error = 'No audio captured. Try recording again.'; return; }
				upload(new File([blob], `recording-${Date.now()}.${extension}`, { type }));
			};
			recorder.onerror = () => {
				cancelCapture = true;
				error = 'Microphone recording failed. Try again or upload an audio file.';
				recordingAudio = false;
				if (recorder.state === 'recording') recorder.stop();
				stopStream();
			};
			recorder.start();
			recordingAudio = true;
		} catch (caught) {
			stopStream();
			error = caught.message || 'Unable to access microphone';
		} finally {
			busy = false;
		}
	}

	function stopRecording(cancel = false) {
		cancelCapture = cancel;
		if (recorder?.state === 'recording') recorder.stop();
	}
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape' && !report && !template && !busy && !recordingAudio) onClose(); }} />

<div class="modal modal-open">
	<div role="dialog" aria-modal="true" aria-labelledby="recordings-title" class="modal-box max-w-6xl space-y-4">
		<h3 id="recordings-title" class="text-lg font-bold">Recordings & reports — {studyLabel(study)}</h3>
		<p>{study.patient_code} — {study.patient_firstname} {study.patient_lastname}</p>
		<p class="text-sm">Source modality: {detail?.source_modality || detail?.modality_code || study.modality_code || 'Not specified'}<br />Source description (reference only): {detail?.source_description || detail?.description || study.source_description || study.description || 'Not specified'}</p>
		<p class="text-sm">Study attending: {detail?.attending_fullname || study.attending_fullname || 'Not assigned'}</p>
		<div class="flex flex-wrap items-center gap-3">
			{#if !readOnly}
			<label class="form-control min-w-0 max-w-full">
				<span class="label-text">Append audio recording</span>
				<input bind:this={fileInput} type="file" accept="audio/*" class="file-input file-input-bordered w-full max-w-full" disabled={busy || recordingAudio || loading} onchange={(event) => upload(event.currentTarget.files?.[0])} />
			</label>
			{#if recordingAudio}
				<span role="status">Recording microphone…</span>
				<button class="btn btn-primary" onclick={() => stopRecording()}>Stop & append recording</button>
				<button class="btn btn-ghost" onclick={() => stopRecording(true)}>Cancel recording</button>
			{:else}
				<button class="btn btn-outline" disabled={busy || loading} onclick={startRecording}>Record microphone</button>
			{/if}
			{/if}
			<button class="btn btn-ghost" disabled={busy || loading} onclick={() => { error = ''; changed().catch((caught) => (error = caught.message)); }}>Refresh recordings</button>
		</div>
		{#if busy}<p role="status">Working…</p>{/if}
		{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
		{#if loading}<p>Loading recordings…</p>
		{:else if detail}
			{#each detail.recordings ?? [] as item (item.id)}
				<RecordingCard study={detail} recording={item} modalities={data.modalities} examTypes={data.exam_types} residents={data.residents} user={data.user} onChanged={changed} onReport={(item) => (report = item)} onTemplate={(context) => { if (!template && !report) template = context; }} onEditStudy={readOnly || busy || recordingAudio ? undefined : () => onEditStudy(detail)} />
			{:else}<p>No recordings yet.</p>{/each}
		{/if}
		<div class="modal-action"><button class="btn" disabled={busy || recordingAudio} onclick={onClose}>Close</button></div>
	</div>
</div>
{#if template}
	<TemplateModal modalities={data.modalities} examTypes={data.exam_types} modalityId={template.modalityId} examTypeId={template.examTypeId} onSaved={(saved) => { template.onSaved(saved); template = null; }} onClose={() => (template = null)} />
{/if}
{#if report}
	<ReportModal user={data.user} study={detail ?? study} recording={detail?.recordings?.find((item) => item.id === report.id) ?? report} initialText={report.__initialText ?? ''} onSaved={changed} onClose={() => (report = null)} />
{/if}
