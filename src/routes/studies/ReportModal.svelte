<script>
  import { invalidateAll } from '$app/navigation';
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';

  // props: study, onClose, initialText
  let { study, onClose, initialText = '' } = $props();

  const state = $state({
    text: initialText,
    loading: !initialText,
    saving: false,
    savedMsg: '',
    tab: 'write' // 'write' | 'preview'
  });

  $effect(async () => {
    if (!state.loading) return;
    try {
      const res = await fetch(`/api/studies/${study.id}/report`);
      const d = await res.json();
      state.text = d?.text ?? '';
    } catch {
      // optionally show an error alert here
    } finally {
      state.loading = false;
    }
  });

  const previewHtml = $derived(
    DOMPurify.sanitize(marked.parse(state.text || ''))
  );

  async function save() {
    if (state.saving) return;
    state.saving = true;
    try {
      const res = await fetch(`/api/studies/${study.id}/report`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: state.text })
      });
      if (!res.ok) throw new Error('Save failed');
      state.savedMsg = 'Saved';
      await invalidateAll();
    } catch {
      state.savedMsg = 'Failed to save';
    } finally {
      state.saving = false;
      setTimeout(() => (state.savedMsg = ''), 1200);
    }
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      onClose?.();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  }
</script>

<div class="modal modal-open">
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="report-title"
    class="modal-box max-w-3xl"
  >
    <h3 id="report-title" class="font-bold text-lg mb-3">
      Text Report — Study #{study.id}
    </h3>

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
          placeholder="Enter report in Markdown…"
          spellcheck="false"
        ></textarea>
      {:else}
        <div class="rounded-box border border-base-content/10 p-3 h-[40vh] overflow-y-auto">
          {#if state.text?.trim()}
            <div class="prose dark:prose-invert max-w-none">
              {@html previewHtml}
            </div>
          {:else}
            <div class="opacity-60 italic">Nothing to preview.</div>
          {/if}
        </div>
      {/if}
    {/if}

    <div class="modal-action">
      <button class="btn btn-ghost" type="button" onclick={() => onClose?.()}>
        Close (Esc)
      </button>
      <button
        class="btn btn-outline disabled:opacity-50"
        type="button"
        disabled={state.saving}
        onclick={save}
      >
        {#if state.saving}Saving…{:else}Save (Ctrl/⌘+S){/if}
      </button>
    </div>
  </div>

  <!-- DaisyUI backdrop -->
  <button class="modal-backdrop" onclick={() => onClose?.()}>close</button>
</div>
