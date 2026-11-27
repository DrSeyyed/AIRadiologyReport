<script>
  import { invalidateAll } from '$app/navigation';
  import { onDestroy, onMount } from 'svelte';
  import { renderReportMarkdown } from '$lib/report-markdown.js';
  import { reportTitle } from '$lib/report-title.js';
  import DOMPurify from 'dompurify';
  import { studyLabel } from '$lib/study-label.js';
  import TypistSignature from './TypistSignature.svelte';
  import TranscriptionPreview from './TranscriptionPreview.svelte';
  import { DEFAULT_REPORT_TYPOGRAPHY, reportFonts, reportTypography, validReportSize, formattedReport, copyFormattedReport } from '$lib/report-copy.js';
  import { reportTypographyStorage } from '$lib/report-typography-client.js';

  let { study, recording, user, onClose, onSaved, initialText = '' } = $props();

  const state = $state({
    text: initialText,
    loading: !initialText,
    saving: false,
    savedMsg: '',
    error: '',
    tab: 'write' // 'write' | 'preview' (narrow screens; wide screens show both side by side)
  });
  let savedText = $state(initialText);
  const dirty = $derived(state.text !== savedText);

  const title = $derived(reportTitle(recording));
  const endpoint = $derived(`/api/studies/${study.id}/recordings/${recording.id}/report`);
  const editable = $derived(!study.disabled && user?.role !== 'typist' && !recording.processing && !recording.resident_checked && !recording.attending_checked && !recording.typist_checked && Boolean(recording.modality_id && recording.exam_type_id && recording.corresponding_resident_id && study.corresponding_attending_id));
  const residentSignature = $derived(recording.resident_checked
    ? `Resident signature: ${recording.resident_signer_fullname || 'Unknown signer'}${recording.resident_signed_by_user_id != null && Number(recording.resident_signed_by_user_id) !== Number(recording.corresponding_resident_id) ? ` (on behalf of ${recording.resident_fullname || 'assigned resident'})` : ''}${recording.resident_signed_at ? ` · ${recording.resident_signed_at}` : ''}`
    : 'Resident signature: not signed');
  const attendingSignature = $derived(recording.attending_checked
    ? `Attending signature: ${recording.attending_signer_fullname || 'Unknown signer'}${recording.attending_signed_at ? ` · ${recording.attending_signed_at}` : ''}`
    : 'Attending signature: not signed');
  let font = $state(DEFAULT_REPORT_TYPOGRAPHY.font);
  let fontSize = $state(DEFAULT_REPORT_TYPOGRAPHY.size.toFixed(1));
  let typographyLoading = $state(true);
  let typographySaving = $state(false);
  let typographyError = $state('');
  let typographyRevision = 0;
  let copying = $state(false);
  let transcribing = $state(false);
  let copyMessage = $state('');
  let copyError = $state('');
  const canExport = $derived(!state.loading && !typographyLoading && !state.error && Boolean(state.text.trim()) && validReportSize(fontSize));
  let printFrame;
  onDestroy(() => printFrame?.remove());

  onMount(() => {
    let active = true;
    reportTypographyStorage.load(user.id)
      .then((preferences) => {
        if (!active) return;
        font = preferences.font;
        fontSize = Number.isInteger(preferences.size) ? preferences.size.toFixed(1) : String(preferences.size);
      })
      .catch(() => {
        if (active) typographyError = 'Unable to load saved font settings. Defaults are shown.';
      })
      .finally(() => {
        if (active) typographyLoading = false;
      });
    return () => { active = false; };
  });

  async function saveTypography() {
    if (typographyLoading || !validReportSize(fontSize)) return;
    const revision = ++typographyRevision;
    typographySaving = true;
    typographyError = '';
    try {
      await reportTypographyStorage.save(user.id, { font, size: Number(fontSize) });
    } catch {
      if (revision === typographyRevision) typographyError = 'Unable to save font settings. Change the font or size to try again.';
    } finally {
      if (revision === typographyRevision) typographySaving = false;
    }
  }

  function clearCopyStatus() {
    copyMessage = '';
    copyError = '';
  }

  async function copyReport() {
    if (!canExport || copying) return;
    copying = true;
    clearCopyStatus();
    try {
      await copyFormattedReport(formatted);
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
        savedText = state.text;
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
    font,
    size: fontSize
  });
  const formatted = $derived(!state.loading && typeof document !== 'undefined' ? formattedReport(reportContent) : { html: '', text: '' });

  async function save() {
    if (!editable || state.saving || transcribing || state.loading || state.error || !state.text.trim()) return;
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
      savedText = state.text;
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

  function requestClose() {
    if (state.saving) return;
    if (dirty && editable && !confirm('Discard unsaved report changes?')) return;
    onClose?.();
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      requestClose();
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
    class="modal-box flex max-h-[94vh] w-[96vw] max-w-6xl flex-col gap-3 p-4 sm:p-5"
  >
    <header class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div class="min-w-0">
        <h3 id="report-title" class="text-lg font-bold">Text Report ? {studyLabel(study)}, recording #{recording.id}</h3>
        <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-80">
          <span>{residentSignature}</span>
          <span>{attendingSignature}</span>
        </div>
      </div>
      <div class="flex items-center gap-2 text-sm">
        {#if state.savedMsg}<span class="badge badge-ghost" role="status">{state.savedMsg}</span>
        {:else if dirty && editable}<span class="badge badge-warning badge-outline" role="status">Unsaved changes</span>{/if}
      </div>
    </header>

    <div class="text-sm">
      <TypistSignature {study} {recording} {user} onChanged={onSaved ?? invalidateAll} disabled={state.loading || state.saving || transcribing || !!state.error} />
    </div>

    <div class="report-toolbar flex flex-wrap items-end gap-2 rounded-box border border-base-content/10 bg-base-200/60 p-2" role="toolbar" aria-label="Report formatting and export">
      <label class="form-control w-52 max-w-full">
        <span class="label-text mb-1 text-xs">Report font</span>
        <select class="select select-bordered select-sm leading-normal py-0" value={font} disabled={typographyLoading}
          onchange={(event) => { font = event.currentTarget.value; clearCopyStatus(); saveTypography(); }}>
          {#each reportFonts as option (option.name)}<option value={option.name}>{option.name}</option>{/each}
        </select>
      </label>
      <label class="form-control w-24">
        <span class="label-text mb-1 text-xs">Font size (pt)</span>
        <input class="input input-bordered input-sm w-full" type="number" min="6" max="72" step="0.1" value={fontSize} disabled={typographyLoading}
          oninput={(event) => { fontSize = event.currentTarget.value; clearCopyStatus(); saveTypography(); }} />
      </label>
      <div class="ml-auto flex flex-wrap gap-2">
        <button class="btn btn-sm btn-outline" type="button" disabled={!canExport || copying} onclick={copyReport}>{copying ? 'Copying?' : 'Copy report'}</button>
        <button class="btn btn-sm btn-outline" type="button" disabled={!canExport} onclick={printReport}>Print / Save PDF</button>
      </div>
    </div>

    {#if typographyLoading}<p class="text-sm" role="status">Loading font settings?</p>
    {:else if typographySaving}<p class="text-sm" role="status">Saving font settings?</p>{/if}
    {#if typographyError}<p class="text-error text-sm" role="alert">{typographyError}</p>{/if}
    {#if !validReportSize(fontSize)}<p class="text-error text-sm" role="alert">Choose a font size between 6 and 72 pt.</p>{/if}
    {#if copyMessage}<p class="text-sm" role="status">{copyMessage}</p>{/if}
    {#if copyError}<p class="text-error text-sm" role="alert">{copyError}</p>{/if}
    {#if state.error}<div class="alert alert-error" role="alert">{state.error}</div>{/if}
    {#if !editable}<p class="text-sm">{user?.role === 'typist' ? 'Typist access: read-only.' : 'Read-only: editing requires an unsigned report, completed processing, saved resident and examination configuration, and a study attending.'}</p>{/if}

    {#if state.loading}
      <div class="space-y-2">
        <div class="skeleton h-5 w-1/3"></div>
        <div class="skeleton h-40 w-full"></div>
      </div>
    {:else}
      {#if editable}
        <div role="tablist" class="tabs tabs-boxed w-fit lg:hidden">
          <button
            role="tab"
            class="tab button-tint btn-primary {state.tab === 'write' ? 'tab-active' : ''}"
            aria-selected={state.tab === 'write'}
            disabled={state.saving}
            onclick={() => (state.tab = 'write')}
            type="button"
          >
            Write
          </button>
          <button
            role="tab"
            class="tab button-tint btn-primary {state.tab === 'preview' ? 'tab-active' : ''}"
            aria-selected={state.tab === 'preview'}
            onclick={() => (state.tab = 'preview')}
            type="button"
          >
            Preview
          </button>
        </div>
      {/if}

      <div class="grid min-h-0 flex-1 gap-3 {editable ? 'lg:grid-cols-2' : ''}">
        {#if editable}
          <label class="report-pane min-h-0 flex-col gap-1 {state.tab === 'write' ? 'flex' : 'hidden'} lg:flex">
            <span class="text-xs font-semibold opacity-70">Markdown</span>
            <textarea
              class="report-editor textarea textarea-bordered w-full flex-1 text-sm leading-relaxed"
              aria-label="Report text (Markdown)"
              dir="auto"
              bind:value={state.text}
              oninput={clearCopyStatus}
              disabled={state.saving}
              placeholder="Enter report in Markdown?"
              spellcheck="false"
            ></textarea>
          </label>
        {/if}
        <section class="report-pane min-h-0 flex-col gap-1 {!editable || state.tab === 'preview' ? 'flex' : 'hidden'} lg:flex" aria-label="Report preview">
          <span class="text-xs font-semibold opacity-70">Preview</span>
          <div class="report-paper flex-1 overflow-y-auto rounded-box border border-base-content/10 p-4">
            {#if state.text?.trim()}
              <div aria-label="Formatted report preview">
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- Report Markdown is sanitized and metadata uses text nodes. -->
                {@html formatted.html}
              </div>
            {:else}
              <div class="italic opacity-60">Nothing to preview.</div>
            {/if}
          </div>
        </section>
      </div>
    {/if}

    <TranscriptionPreview {study} {recording} {user} disabled={state.saving || state.loading} bind:busy={transcribing} />

    <div class="modal-action mt-0 flex-wrap gap-y-2">
      <button class="btn btn-ghost" type="button" disabled={state.saving} onclick={requestClose}>
        Close (Esc)
      </button>
      <button
        class="btn btn-primary min-w-40 font-semibold disabled:opacity-50"
        type="button"
        disabled={!editable || state.saving || transcribing || state.loading || !!state.error || !state.text.trim()}
        onclick={save}
      >
        {#if state.saving}Saving?{:else}Save (Ctrl/?+S){/if}
      </button>
    </div>
  </div>

  <!-- DaisyUI backdrop -->
  <button class="modal-backdrop" disabled={state.saving} onclick={requestClose}>close</button>
</div>

<style>
  .report-pane { height: min(60vh, 44rem); }
  .report-editor { resize: none; min-height: 12rem; font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Tahoma, sans-serif; }
  /* The preview mirrors the copied/printed paper (black on white) in both themes. */
  .report-paper { background: #fff; color: #000; }
  @media (max-width: 1023px) { .report-pane { height: min(55vh, 36rem); } }
</style>
