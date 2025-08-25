<script>
  import { invalidateAll } from '$app/navigation';
  let { data } = $props();

  // form state
  const form = $state({
    full_name: '',
    role: 'resident', // resident | attending | admin
    email: '',
    username: '',
    password: ''
  });

  let loading = $state(false);
  let error = $state('');
  let success = $state('');

  async function createUser(e) {
    e.preventDefault();
    error = '';
    success = '';
    loading = true;

    // minimal checks
    if (!form.full_name.trim()) { error = 'Full name is required'; loading = false; return; }
    if (!form.role) { error = 'Role is required'; loading = false; return; }
    // username/password are optional; if one given, require the other
    if ((form.username && !form.password) || (!form.username && form.password)) {
      error = 'Provide both username and password, or leave both empty.';
      loading = false;
      return;
    }

    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d?.error || 'Failed to create user');
      }

      // clear form
      form.full_name = '';
      form.role = 'resident';
      form.email = '';
      form.username = '';
      form.password = '';

      success = 'User created.';
      await invalidateAll(); // refresh list
    } catch (err) {
      error = err.message || 'Failed to create user';
    } finally {
      loading = false;
    }
  }
</script>

<section class="space-y-6">
  <div class="flex items-center justify-between">
    <h2 class="text-2xl font-semibold">User Management</h2>
    <a href="/studies" class="text-sm underline">Back to Studies</a>
  </div>

  <!-- Add form -->
  <form class="grid gap-4 md:grid-cols-2 border rounded p-4" onsubmit={(e) => createUser(e)}>
    {#if error}
      <div class="md:col-span-2 text-sm text-red-600 border border-red-200 rounded p-2">{error}</div>
    {/if}
    {#if success}
      <div class="md:col-span-2 text-sm text-green-700 border border-green-200 rounded p-2">{success}</div>
    {/if}

    <label class="text-sm">
      <div class="mb-1">Full name</div>
      <input class="border rounded px-2 py-1 w-full" bind:value={form.full_name} required />
    </label>

    <label class="text-sm">
      <div class="mb-1">Role</div>
      <select class="border rounded px-2 py-1 w-full" bind:value={form.role} required>
        <option value="resident">Resident</option>
        <option value="attending">Attending</option>
        <option value="admin">Admin</option>
      </select>
    </label>

    <label class="text-sm">
      <div class="mb-1">Email (optional)</div>
      <input class="border rounded px-2 py-1 w-full" type="email" bind:value={form.email} />
    </label>

    <div class="md:col-span-2 grid gap-4 md:grid-cols-2">
      <label class="text-sm">
        <div class="mb-1">Username</div>
        <input class="border rounded px-2 py-1 w-full" bind:value={form.username} autocomplete="username" required/>
      </label>
      <label class="text-sm">
        <div class="mb-1">Password</div>
        <input class="border rounded px-2 py-1 w-full" type="password" bind:value={form.password} autocomplete="new-password" required/>
      </label>
    </div>

    <div class="md:col-span-2 flex gap-2">
      <button class="border rounded px-3 py-2 hover:bg-gray-100" type="submit" disabled={loading}>
        {#if loading}Creating...{:else}Create user{/if}
      </button>
      <button class="border rounded px-3 py-2" type="button"
              onclick={() => { form.full_name=''; form.role='resident'; form.email=''; form.username=''; form.password=''; }}>
        Reset
      </button>
    </div>
  </form>

  <!-- Users list -->
  <div class="border rounded overflow-auto">
    <table class="min-w-full text-sm">
      <thead class="bg-gray-50">
        <tr>
          <th class="text-left p-2">Name</th>
          <th class="text-left p-2">Role</th>
          <th class="text-left p-2">Email</th>
          <th class="text-left p-2">Username</th>
        </tr>
      </thead>
      <tbody>
        {#each data.users as u}
          <tr class="border-t">
            <td class="p-2">{u.full_name}</td>
            <td class="p-2">{u.role}</td>
            <td class="p-2">{u.email ?? '-'}</td>
            <td class="p-2">{u.username ?? '-'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
