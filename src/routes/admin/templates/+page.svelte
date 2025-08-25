<script>
  let { data } = $props(); // from +page.server.js

  const state = $state({
    loading: false,
    modalities: data.modalities,
    exam_types: data.exam_types,
    templates: data.templates,
    id: null, modality_id: null, exam_type_id: null, text: '',
    saving: false, msg: ''
  });

  function resetForm() {
    state.id = null;
    state.modality_id = null;
    state.exam_type_id = null;
    state.text = '';
    state.msg = '';
  }

  function editRow(row) {
    state.id = row.id;
    state.modality_id = row.modality_id;
    state.exam_type_id = row.exam_type_id;
    state.text = row.text || '';
    state.msg = '';
    // scroll to form (optional)
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function saveTemplate() {
    state.saving = true;
    try {
      const res = await fetch('/api/report-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: state.id,
          modality_id: state.modality_id,
          exam_type_id: state.exam_type_id,
          text: state.text
        })
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e?.error || 'Save failed');
      }
      const saved = await res.json();
      const idx = state.templates.findIndex(t => t.id === saved.id);
      if (idx >= 0) state.templates[idx] = saved; else state.templates.push(saved);
      state.msg = 'Saved ✓';
    } catch (e) {
      // use alert only in browser
      if (typeof window !== 'undefined') alert(e.message);
      else console.error(e);
    } finally {
      state.saving = false;
      setTimeout(() => (state.msg = ''), 1500);
    }
  }

  async function deleteRow(row) {
    if (typeof window !== 'undefined' && !confirm(`Delete template ${row.modality_code} / ${row.exam_type_name}?`)) return;
    const res = await fetch(`/api/report-templates/${row.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      if (typeof window !== 'undefined') alert(e?.error || 'Delete failed'); else console.error(e);
      return;
    }
    state.templates = state.templates.filter(t => t.id !== row.id);
    if (state.id === row.id) resetForm();
  }
</script>


<div class="max-w-5xl mx-auto p-4 space-y-6">
  <div class="flex items-center justify-between">
    <h2 class="text-2xl font-semibold">Patient Management</h2>
    <a href="/studies" class="text-sm underline">Back to Studies</a>
  </div>
  
  <h1 class="text-xl font-semibold">Report Templates</h1>

  <!-- Editor card -->
  <div class="border rounded p-4 bg-white dark:bg-black">
    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
      <label class="text-sm">
        <div class="mb-1">Modality</div>
        <select
          class="border rounded px-2 py-1 w-full"
          value={state.modality_id ?? ''}
          onchange={(e) => {
            const v = e.currentTarget.value;
            state.modality_id = v === '' ? null : Number(v);
          }}
        >
          <option value="" disabled>Select modality</option>
          {#each state.modalities as m}
            <option value={m.id}>{m.code} — {m.name}</option>
          {/each}
        </select>
      </label>

      <label class="text-sm">
        <div class="mb-1">Exam Type</div>
        <select
          class="border rounded px-2 py-1 w-full"
          value={state.exam_type_id ?? ''}
          onchange={(e) => {
            const v = e.currentTarget.value;
            state.exam_type_id = v === '' ? null : Number(v);
          }}
        >
          <option value="" disabled>Select exam type</option>
          {#each state.exam_types as t}
            <option value={t.id}>{t.name}</option>
          {/each}
        </select>
      </label>

      <div class="flex items-end gap-2">
        <button class="border rounded px-3 py-2" type="button" onclick={resetForm}>New</button>
        <button class="border rounded px-3 py-2 hover:bg-gray-100" type="button" onclick={saveTemplate} disabled={state.saving}>
          {#if state.saving}Saving…{:else}Save{/if}
        </button>
      </div>
    </div>

    <div class="mt-3">
      <div class="mb-1 text-sm">Template Text</div>
      <textarea
        class="w-full border rounded p-2 min-h-[240px]"
        bind:value={state.text}
        placeholder="Indication:\n\nTechnique:\n\nFindings:\n\nImpression:\n\nConclusion:\n"
      ></textarea>
      {#if state.msg}
        <div class="text-sm mt-2 text-green-700">{state.msg}</div>
      {/if}
    </div>
  </div>

  <!-- List card -->
  <div class="border rounded p-4 bg-white dark:bg-black">
    <div class="mb-3 font-medium">Existing Templates</div>
    {#if state.loading}
      <div class="text-sm opacity-70">Loading…</div>
    {:else if state.templates.length === 0}
      <div class="text-sm opacity-70">No templates yet.</div>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b">
              <th class="text-left p-2">Modality</th>
              <th class="text-left p-2">Exam Type</th>
              <th class="text-left p-2">Preview</th>
              <th class="text-left p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each state.templates as row}
              <tr class="border-b align-top">
                <td class="p-2 whitespace-nowrap">{row.modality_code} — {row.modality_name}</td>
                <td class="p-2 whitespace-nowrap">{row.exam_type_name}</td>
                <td class="p-2">
                  <pre class="max-w-[36ch] whitespace-pre-wrap line-clamp-3">{row.text}</pre>
                </td>
                <td class="p-2 whitespace-nowrap">
                  <button class="border rounded px-2 py-1 text-xs mr-1 hover:bg-gray-100" onclick={() => editRow(row)}>Edit</button>
                  <button class="border rounded px-2 py-1 text-xs hover:bg-red-50" onclick={() => deleteRow(row)}>Delete</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>