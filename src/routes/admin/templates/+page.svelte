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


<div class="max-w-5xl mx-auto p-4 space-y-6">
  <div class="flex items-center justify-between">
    <h2 class="text-2xl font-semibold">Patient Management</h2>
    <a href={resolve('/studies')} class="text-sm underline">Back to Studies</a>
  </div>
  
  <h1 class="text-xl font-semibold">Report Templates</h1>

  {#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
  <div class="border rounded p-4 bg-base-100 space-y-3">
    <button class="btn btn-sm btn-outline" type="button" disabled={editorBusy} onclick={resetForm}>New template</button>
    {#key editorVersion}
      <TemplateEditor modalities={data.modalities} examTypes={data.exam_types} initialModalityId={selected?.modality_id ?? ''} initialExamTypeId={selected?.exam_type_id ?? ''} onSaved={invalidateAll} onBusyChange={(value) => (editorBusy = value)} />
    {/key}
  </div>

  <!-- List card -->
  <div class="border rounded p-4 bg-white dark:bg-black">
    <div class="mb-3 font-medium">Existing Templates</div>
    {#if data.templates.length === 0}
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
            {#each data.templates as row (row.id)}
              <tr class="border-b align-top">
                <td class="p-2 whitespace-nowrap">{row.modality_code} — {row.modality_name}</td>
                <td class="p-2 whitespace-nowrap">{row.exam_type_name}</td>
                <td class="p-2">
                  <pre class="max-w-[36ch] whitespace-pre-wrap line-clamp-3">{row.text}</pre>
                </td>
                <td class="p-2 whitespace-nowrap">
                  <button class="border rounded px-2 py-1 text-xs mr-1 hover:bg-gray-100" disabled={editorBusy} onclick={() => editRow(row)}>Edit</button>
                  {#if data.user.role === 'admin'}<button class="border rounded px-2 py-1 text-xs hover:bg-red-50" disabled={editorBusy} onclick={() => deleteRow(row)}>Delete</button>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>