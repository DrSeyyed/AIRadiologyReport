<script>
  import { invalidateAll } from '$app/navigation';
  import { onDestroy } from 'svelte';
  import { renderReportMarkdown } from '$lib/report-markdown.js';
  import { reportTitle } from '$lib/report-title.js';
  import DOMPurify from 'dompurify';
  import { studyLabel } from '$lib/study-label.js';
  import TypistSignature from './TypistSignature.svelte';
  import { reportFonts, reportTypography, validReportSize, formattedReport, copyFormattedReport } from '$lib/report-copy.js';

  let { study, recording, user, onClose, onSaved, initialText = '' } = $props();

  const state = $state({
    text: initialText,
    loading: !initialText,
    saving: false,
    savedMsg: '',
    error: '',
    tab: 'write' // 'write' | 'preview'
  });

  const title = $derived(reportTitle(recording));
  const endpoint = $derived(`/api/studies/${study.id}/recordings/${recording.id}/report`);
  const editable = $derived(!study.disabled && user?.role !== 'typist' && !recording.processing && !recording.resident_checked && !recording.attending_checked && !recording.typist_checked && Boolean(recording.modality_id && recording.exam_type_id && recording.corresponding_resident_id && study.corresponding_attending_id));
  const residentSignature = $derived(recording.resident_checked
    ? `Resident signature: ${recording.resident_signer_fullname || 'Unknown signer'}${recording.resident_signed_by_user_id != null && Number(recording.resident_signed_by_user_id) !== Number(recording.corresponding_resident_id) ? ` (on behalf of ${recording.resident_fullname || 'assigned resident'})` : ''}${recording.resident_signed_at ? ` · ${recording.resident_signed_at}` : ''}`
    : 'Resident signature: not signed');
  const attendingSignature = $derived(recording.attending_checked
    ? `Attending signature: ${recording.attending_signer_fullname || 'Unknown signer'}${recording.attending_signed_at ? ` · ${recording.attending_signed_at}` : ''}`
    : 'Attending signature: not signed');
  const typistSignature = $derived(recording.typist_checked
    ? `Typist / printed confirmation: ${recording.typist_signer_fullname || 'Unknown signer'}${recording.typist_signed_at ? ` · ${recording.typist_signed_at}` : ''}`
    : 'Typist / printed confirmation: not signed');
  let font = $state('Arial');
  let fontSize = $state('12.0');
  let copying = $state(false);
  let copyMessage = $state('');
  let copyError = $state('');
  const canExport = $derived(!state.loading && !state.error && Boolean(state.text.trim()) && validReportSize(fontSize));
  let printFrame;
  onDestroy(() => printFrame?.remove());

  function clearCopyStatus() {
    copyMessage = '';
    copyError = '';
  }

  async function copyReport() {
    if (!canExport || copying) return;
    copying = true;
    clearCopyStatus();
    try {
      await copyFormattedReport(formattedReport({ ...reportContent, signatures: [] }));
      copyMessage = 'Copied with formatting. Paste into a rich-text editor to keep the font and size.';
    } catch (caught) {
      copyError = caught.message || 'Unable to copy report.';
    } finally {
      copying = false;
    }
  }

  $effect(() => {
    if (!editable) state.tab = 'preview';
  });

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function printReport() {
    if (!canExport) return;
    printFrame?.remove();
    const frame = document.createElement('iframe');
    frame.title = 'Report print preview';
    frame.style.cssText = 'position:fixed;left:-10000px;width:800px;height:600px;border:0';
    frame.onload = () => {
      frame.contentWindow?.addEventListener('afterprint', () => frame.remove(), { once: true });
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    };
    const content = document.createElement('div');
    content.innerHTML = formatted.html;
    const studyInfo = document.createElement('p');
    studyInfo.textContent = `${studyLabel(study)} — Recording #${recording.id}`;
    Object.assign(studyInfo.style, reportTypography(font, fontSize));
    content.querySelector('h1').after(studyInfo);
    frame.srcdoc = `<!doctype html><html><head><title>${escapeHtml(title)}</title><style>body{line-height:1.5;margin:2cm}@page{margin:1.5cm}</style></head><body>${content.innerHTML}</body></html>`;
    printFrame = frame;
    document.body.appendChild(frame);
  }

  $effect(() => {
    if (!state.loading) return;
    const controller = new AbortController();
    fetch(endpoint, { signal: controller.signal })
      .then(async (res) => {
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Unable to load report');
        state.text = result.text ?? '';
        state.loading = false;
      })
      .catch((caught) => {
        if (caught.name !== 'AbortError') {
          state.error = caught.message || 'Unable to load report';
          state.loading = false;
        }
      });
    return () => controller.abort();
  });

  const previewHtml = $derived(
    DOMPurify.sanitize(renderReportMarkdown(state.text))
  );
  const reportContent = $derived({
    title,
    sanitizedBodyHtml: previewHtml,
    resident: recording.resident_fullname || 'Unassigned',
    attending: study.attending_fullname || 'Not assigned',
    signatures: [residentSignature, attendingSignature, typistSignature],
    font,
    size: fontSize
  });
  const formatted = $derived(!state.loading && typeof document !== 'undefined' ? formattedReport(reportContent) : { html: '', text: '' });

  async function save() {
    if (!editable || state.saving || state.loading || state.error || !state.text.trim()) return;
    state.saving = true;
    state.savedMsg = '';
    try {
      const res = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: state.text })
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || 'Save failed');
      state.savedMsg = 'Saved — signatures cleared for this recording';
      if (onSaved) await onSaved();
      else await invalidateAll();
    } catch (caught) {
      state.savedMsg = caught.message || 'Failed to save';
    } finally {
      state.saving = false;
      setTimeout(() => (state.savedMsg = ''), 1200);
    }
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      if (!state.saving) onClose?.();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="modal modal-open">
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="report-title"
    class="modal-box max-w-3xl"
  >
    <h3 id="report-title" class="font-bold text-lg mb-3">
      Text Report — {studyLabel(study)}, recording #{recording.id}
    </h3>
    <div class="text-sm mb-3">
      <p>{residentSignature}</p>
      <p>{attendingSignature}</p>
      <TypistSignature {study} {recording} {user} onChanged={onSaved ?? invalidateAll} disabled={state.loading || state.saving || !!state.error} />
    </div>
    <div class="flex flex-wrap items-end gap-3 mb-3">
      <label class="form-control w-56 max-w-full">
        <span class="label-text mb-1">Report font</span>
        <select class="select select-bordered select-sm leading-normal py-0" bind:value={font} onchange={clearCopyStatus}>
          {#each reportFonts as option (option.name)}<option value={option.name}>{option.name}</option>{/each}
        </select>
      </label>
      <label class="form-control w-28">
        <span class="label-text mb-1">Font size (pt)</span>
        <input class="input input-bordered input-sm w-full" type="number" min="6" max="72" step="0.1" value={fontSize}
          oninput={(event) => { fontSize = event.currentTarget.value; clearCopyStatus(); }} />
      </label>
    </div>
    {#if !validReportSize(fontSize)}<p class="text-error text-sm mb-3" role="alert">Choose a font size between 6 and 72 pt.</p>{/if}
    {#if copyMessage}<p class="text-sm mb-3" role="status">{copyMessage}</p>{/if}
    {#if copyError}<p class="text-error text-sm mb-3" role="alert">{copyError}</p>{/if}
    {#if state.error}<div class="alert alert-error" role="alert">{state.error}</div>{/if}
    {#if !editable}<p class="text-sm mb-3">{user?.role === 'typist' ? 'Typist access: read-only.' : 'Read-only: editing requires an unsigned report, completed processing, saved resident and examination configuration, and a study attending.'}</p>{/if}

    {#if state.loading}
      <div class="space-y-2 mb-3">
        <div class="skeleton h-5 w-1/3"></div>
        <div class="skeleton h-40 w-full"></div>
      </div>
    {:else}
      <div role="tablist" class="tabs tabs-boxed mb-3">
        <button
          role="tab"
          class="tab {state.tab === 'write' ? 'tab-active' : ''}"
          aria-selected={state.tab === 'write'}
          disabled={!editable || state.saving}
          onclick={() => (state.tab = 'write')}
          type="button"
        >
          Write
        </button>
        <button
          role="tab"
          class="tab {state.tab === 'preview' ? 'tab-active' : ''}"
          aria-selected={state.tab === 'preview'}
          onclick={() => (state.tab = 'preview')}
          type="button"
        >
          Preview
        </button>

        {#if state.savedMsg}
          <span class="ml-auto badge badge-ghost">{state.savedMsg}</span>
        {/if}
      </div>

      {#if state.tab === 'write'}
        <textarea
          class="textarea textarea-bordered w-full h-[40vh] font-mono"
          bind:value={state.text}
          oninput={clearCopyStatus}
          disabled={!editable || state.saving}
          placeholder="Enter report in Markdown…"
          spellcheck="false"
        ></textarea>
      {:else}
        <div class="rounded-box border border-base-content/10 p-3 h-[40vh] overflow-y-auto">
          {#if state.text?.trim()}
            <div aria-label="Formatted report preview">
              <!-- eslint-disable-next-line svelte/no-at-html-tags -- Report Markdown is sanitized and metadata uses text nodes. -->
              {@html formatted.html}
            </div>
          {:else}
            <div class="opacity-60 italic">Nothing to preview.</div>
          {/if}
        </div>
      {/if}
    {/if}

    <div class="modal-action flex-wrap gap-y-2">
      <button class="btn btn-outline" type="button" disabled={!canExport || copying} onclick={copyReport}>{copying ? 'Copying…' : 'Copy report'}</button>
      <button class="btn btn-outline" type="button" disabled={!canExport} onclick={printReport}>Print / Save PDF</button>
      <button class="btn btn-ghost" type="button" disabled={state.saving} onclick={() => onClose?.()}>
        Close (Esc)
      </button>
      <button
        class="btn btn-outline disabled:opacity-50"
        type="button"
        disabled={!editable || state.saving || state.loading || !!state.error || !state.text.trim()}
        onclick={save}
      >
        {#if state.saving}Saving…{:else}Save (Ctrl/⌘+S){/if}
      </button>
    </div>
  </div>

  <!-- DaisyUI backdrop -->
  <button class="modal-backdrop" disabled={state.saving} onclick={() => onClose?.()}>close</button>
</div>
