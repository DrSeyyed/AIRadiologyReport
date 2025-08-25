<script>
  import { invalidateAll } from '$app/navigation';
  let { data } = $props();
  import { year } from '$lib/time.client';

  // form state
  const form = $state({
    patient_code: '',
    firstname: '',
    lastname: '',
    gender: 'male', // male | female
    birth_year: ''
  });

  let loading = $state(false);
  let error = $state('');
  let success = $state('');

  async function createPatient(e) {
    e.preventDefault();
    error = '';
    success = '';
    loading = true;

    // minimal checks
    if (!form.patient_code.trim()) { error = 'Patient code is required'; loading = false; return; }
    if (!form.firstname.trim()) { error = 'First name is required'; loading = false; return; }
    if (!form.lastname.trim()) { error = 'Last name is required'; loading = false; return; }
    if (!form.gender) { error = 'Gender is required'; loading = false; return; }
    if (!form.birth_year) { error = 'Birth year is required'; loading = false; return; }

    // optional basic range check
    const y = Number(form.birth_year);
    if (!Number.isInteger(y) || y < 1300 || y > $year) {
      error = `Birth year must be between 1300 and ${$year}`;
      loading = false;
      return;
    }

    try {
      const res = await fetch('/api/patients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patient_code: form.patient_code.trim(),
          firstname: form.firstname.trim(),
          lastname: form.lastname.trim(),
          gender: form.gender,
          birth_year: y
        })
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d?.error || 'Failed to create patient');
      }

      // clear form
      form.patient_code = '';
      form.firstname = '';
      form.lastname = '';
      form.gender = 'male';
      form.birth_year = '';

      success = 'Patient created.';
      await invalidateAll(); // refresh list
    } catch (err) {
      error = err.message || 'Failed to create patient';
    } finally {
      loading = false;
    }
  }
</script>

<section class="space-y-6">
  <div class="flex items-center justify-between">
    <h2 class="text-2xl font-semibold">Patient Management</h2>
    <a href="/studies" class="text-sm underline">Back to Studies</a>
  </div>

  <!-- Add form -->
  <form class="grid gap-4 md:grid-cols-2 border rounded p-4" onsubmit={(e) => createPatient(e)}>
    {#if error}
      <div class="md:col-span-2 text-sm text-red-600 border border-red-200 rounded p-2">{error}</div>
    {/if}
    {#if success}
      <div class="md:col-span-2 text-sm text-green-700 border border-green-200 rounded p-2">{success}</div>
    {/if}

    <label class="text-sm">
      <div class="mb-1">Patient Code</div>
      <input class="border rounded px-2 py-1 w-full" bind:value={form.patient_code} required />
    </label>

    <label class="text-sm">
      <div class="mb-1">Gender</div>
      <select class="border rounded px-2 py-1 w-full" bind:value={form.gender} required>
        <option value="male">Male</option>
        <option value="female">Female</option>
      </select>
    </label>

    <label class="text-sm">
      <div class="mb-1">First name</div>
      <input class="border rounded px-2 py-1 w-full" bind:value={form.firstname} required />
    </label>

    <label class="text-sm">
      <div class="mb-1">Last name</div>
      <input class="border rounded px-2 py-1 w-full" bind:value={form.lastname} required />
    </label>

    <label class="text-sm">
      <div class="mb-1">Birth year</div>
      <input class="border rounded px-2 py-1 w-full" type="number" min="1300" max={$year} bind:value={form.birth_year} required />
    </label>

    <div class="md:col-span-2 flex gap-2">
      <button class="border rounded px-3 py-2 hover:bg-gray-100" type="submit" disabled={loading}>
        {#if loading}Creating...{:else}Create patient{/if}
      </button>
      <button class="border rounded px-3 py-2" type="button"
              onclick={() => { form.patient_code=''; form.firstname=''; form.lastname=''; form.gender='male'; form.birth_year=''; }}>
        Reset
      </button>
    </div>
  </form>

  <!-- Patients list -->
  <div class="border rounded overflow-auto">
    <table class="min-w-full text-sm">
      <thead class="bg-gray-50">
        <tr>
          <th class="text-left p-2">ID</th>
          <th class="text-left p-2">Patient Code</th>
          <th class="text-left p-2">First name</th>
          <th class="text-left p-2">Last name</th>
          <th class="text-left p-2">Gender</th>
          <th class="text-left p-2">Birth year</th>
        </tr>
      </thead>
      <tbody>
        {#each data.patients as p}
          <tr class="border-t">
            <td class="p-2">{p.id}</td>
            <td class="p-2">{p.patient_code}</td>
            <td class="p-2">{p.firstname}</td>
            <td class="p-2">{p.lastname}</td>
            <td class="p-2">{p.gender}</td>
            <td class="p-2">{p.birth_year}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
