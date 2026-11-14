<script>
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import TemplateEditor from '$lib/components/TemplateEditor.svelte';
  let { data } = $props();
  let selected = $state(null);
  let editorVersion = $state(0);
  let editorBusy = $state(false);
  let error = $state('');

  function resetForm() {
    selected = null;
    editorVersion++;
  }

  function editRow(row) {
    selected = row;
    editorVersion++;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function deleteRow(row) {
    if (!confirm(`Delete template ${row.modality_code} / ${row.exam_type_name}?`)) return;
    error = '';
    try {
      const res = await fetch(`/api/report-templates/${row.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const result = await res.json().catch(() => ({}));
        throw new Error(result.error || 'Delete failed');
      }
      if (selected?.id === row.id) resetForm();
      await invalidateAll();
    } catch (caught) {
      error = caught.message || 'Delete failed';
    }
  }
</script>


<section class="w-full min-w-0 max-w-5xl space-y-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h1 class="page-title">Report templates</h1>
    <a href={resolve('/studies')} class="text-sm underline">Back to Studies</a>
  </div>
  
  <p class="text-sm text-base-content/70">Manage shared report templates by modality and body part.</p>

  {#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
  <div class="min-w-0 space-y-4 rounded-box border border-base-300 bg-base-100 p-4">
    <h2 class="section-title">{selected ? 'Edit template' : 'Create template'}</h2>
    <button class="btn btn-sm btn-outline" type="button" disabled={editorBusy} onclick={resetForm}>New template</button>
    {#key editorVersion}
      <TemplateEditor modalities={data.modalities} examTypes={data.exam_types} initialModalityId={selected?.modality_id ?? ''} initialExamTypeId={selected?.exam_type_id ?? ''} onSaved={invalidateAll} onBusyChange={(value) => (editorBusy = value)} />
    {/key}
  </div>

  <div class="min-w-0 space-y-4 rounded-box border border-base-300 bg-base-100 p-4">
    <h2 class="section-title">Existing templates ({data.templates.length})</h2>
    {#if data.templates.length === 0}
      <div class="text-sm opacity-70">No templates yet.</div>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b">
              <th scope="col" class="text-left p-2">Modality</th>
              <th scope="col" class="text-left p-2">Exam Type</th>
              <th scope="col" class="text-left p-2">Preview</th>
              <th scope="col" class="text-left p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each data.templates as row (row.id)}
              <tr class="border-b align-top">
                <td class="p-2 whitespace-nowrap">{row.modality_code} — {row.modality_name}</td>
                <td class="p-2 whitespace-nowrap">{row.exam_type_name}</td>
                <td class="p-2">
                  <pre class="max-w-[36ch] whitespace-pre-wrap line-clamp-3">{row.text}</pre>
                </td>
                <td class="p-2 whitespace-nowrap">
                  <button class="button-tint border rounded px-2 py-1 text-xs mr-1" disabled={editorBusy} onclick={() => editRow(row)}>Edit</button>
                  {#if data.user.role === 'admin'}<button class="button-tint btn-error border rounded px-2 py-1 text-xs" disabled={editorBusy} onclick={() => deleteRow(row)}>Delete</button>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</section>