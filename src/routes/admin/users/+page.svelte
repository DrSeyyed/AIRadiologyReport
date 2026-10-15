<script>
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  let { data } = $props();

  const form = $state({ full_name: '', username: '', password: '' });
  let editing = $state(null);
  let loading = $state(false);
  let error = $state('');
  let success = $state('');
  let selectedUserIds = $state([]);
  const eligibleUsers = $derived(data.users.filter(isTelegramEligible));
  const selectedIds = $derived(eligibleUsers
    .map((user) => Number(user.id))
    .filter((id) => selectedUserIds.includes(id)));
  const allSelected = $derived(eligibleUsers.length > 0 && selectedIds.length === eligibleUsers.length);
  const hasPendingInvitations = $derived(data.users.some((user) => user.telegram_invite_status === 'pending'));

  function isTelegramEligible(user) {
    return Boolean(user.has_telegram) && Number.isSafeInteger(Number(user.id)) && Number(user.id) > 0;
  }

  function toggleUser(user, checked) {
    const id = Number(user.id);
    if (loading || !isTelegramEligible(user)) return;
    selectedUserIds = checked
      ? [...new Set([...selectedIds, id])]
      : selectedIds.filter((selectedId) => selectedId !== id);
  }

  function invitationStatus(user) {
    if (!user.has_telegram) return 'No Telegram';
    return { pending: 'Queued', sent: 'Sent', failed: 'Failed' }[user.telegram_invite_status] ?? '-';
  }

  $effect(() => {
    if (!hasPendingInvitations || loading) return;
    let polling = false;
    const interval = setInterval(async () => {
      if (polling || loading) return;
      polling = true;
      try {
        await invalidateAll();
      } catch {
        // Keep the last known statuses and retry on the next polling interval.
      } finally {
        polling = false;
      }
    }, 5000);
    return () => clearInterval(interval);
  });

  async function sendGroupLink() {
    if (loading || selectedIds.length === 0) return;
    const userIds = [...selectedIds];
    loading = true;
    error = '';
    success = '';
    try {
      const response = await fetch('/api/users/telegram-invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_ids: userIds })
      });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || 'Unable to queue group links.');
      selectedUserIds = selectedUserIds.filter((id) => !userIds.includes(id));
      success = `${result.queued ?? 0} queued; ${result.already_queued ?? 0} already queued; ${result.skipped?.length ?? 0} skipped.`;
      await invalidateAll();
    } catch (caught) {
      error = caught.message || 'Unable to queue group links.';
    } finally {
      loading = false;
    }
  }

  function validate(values, requireCredentials = false) {
    if (!values.full_name.trim() || values.full_name.trim().length > 100) return 'Full name must be between 1 and 100 characters.';
    if (requireCredentials && (!values.username || !values.password)) return 'Username and password are required.';
    if (values.username && !/^[a-z][a-z0-9._-]{2,31}$/.test(values.username)) {
      return 'Username must be 3–32 lowercase characters, start with a letter, and contain only letters, numbers, dots, underscores or hyphens.';
    }
    if (values.password && (values.password.length < 8 || new TextEncoder().encode(values.password).length > 72)) {
      return 'Password must be at least 8 characters and at most 72 UTF-8 bytes.';
    }
    return '';
  }

  async function save(event, isEdit = false) {
    event.preventDefault();
    if (loading) return;
    const values = isEdit ? editing : form;
    error = validate(values, !isEdit);
    success = '';
    if (error) return;
    loading = true;
    try {
      const response = await fetch(isEdit ? `/api/users/${values.id}` : '/api/users', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: values.full_name.trim(),
          ...(values.username || values.hasCredentials ? { username: values.username } : {}),
          role: isEdit ? values.role : 'admin',
          ...(isEdit ? { can_sign_as_attending: values.role === 'resident' && values.can_sign_as_attending } : {}),
          ...(values.password ? { password: values.password } : {})
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Unable to save user.');
      if (isEdit) editing = null;
      else { form.full_name = ''; form.username = ''; form.password = ''; }
      await invalidateAll();
      success = isEdit ? 'User updated.' : 'Administrator created.';
    } catch (caught) {
      error = caught.message || 'Unable to save user.';
    } finally {
      loading = false;
    }
  }

  function editUser(user) {
    error = '';
    success = '';
    editing = { id: user.id, full_name: user.full_name, username: user.username ?? '', password: '', role: user.role, can_sign_as_attending: Boolean(user.can_sign_as_attending), hasCredentials: Boolean(user.username) };
  }

  async function removeUser(user) {
    if (loading || user.id === data.user?.id) return;
    if (!confirm(`Remove ${user.full_name}? Studies and audio will be retained, but this user's assignments will be cleared. This cannot be undone.`)) return;
    loading = true;
    error = '';
    success = '';
    try {
      const response = await fetch(`/api/users/${user.id}`, { method: 'DELETE' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Unable to remove user.');
      if (editing?.id === user.id) editing = null;
      await invalidateAll();
      success = 'User removed. Studies and audio retained.';
    } catch (caught) {
      error = caught.message || 'Unable to remove user.';
    } finally {
      loading = false;
    }
  }
</script>

<section class="space-y-6">
  <div class="flex items-center justify-between">
    <h2 class="text-2xl font-semibold">User Management</h2>
    <a href={resolve('/studies')} class="text-sm underline">Back to Studies</a>
  </div>

  <p class="text-sm">Create administrators here; other roles require approved Telegram registration. <a class="link" href={resolve('/admin/telegram-registrations')}>Review Telegram registrations</a>.</p>
  {#if error}<div class="text-sm text-red-600 border border-red-200 rounded p-2" role="alert">{error}</div>{/if}
  {#if success}<div class="text-sm text-green-700 border border-green-200 rounded p-2" role="status">{success}</div>{/if}

  <form class="grid gap-4 md:grid-cols-2 border rounded p-4" onsubmit={save}>
    <h3 class="md:col-span-2 font-semibold">Create administrator</h3>
    <label class="text-sm">
      <div class="mb-1">Full name</div>
      <input class="border rounded px-2 py-1 w-full" bind:value={form.full_name} required disabled={loading} />
    </label>
    <div class="text-sm">Role: Admin</div>
    <label class="text-sm">
      <div class="mb-1">Username</div>
      <input class="border rounded px-2 py-1 w-full" bind:value={form.username} autocomplete="username" pattern={'[a-z][a-z0-9._\\-]{2,31}'} minlength="3" maxlength="32" required disabled={loading} />
    </label>
    <label class="text-sm">
      <div class="mb-1">Password (8+ characters, at most 72 UTF-8 bytes)</div>
      <input class="border rounded px-2 py-1 w-full" type="password" bind:value={form.password} autocomplete="new-password" minlength="8" required disabled={loading} />
    </label>
    <div class="md:col-span-2 flex gap-2">
      <button class="border rounded px-3 py-2 hover:bg-gray-100" type="submit" disabled={loading}>Create administrator</button>
      <button class="border rounded px-3 py-2" type="button" disabled={loading} onclick={() => { form.full_name = ''; form.username = ''; form.password = ''; }}>Reset</button>
    </div>
  </form>

  {#if editing}
    <form class="grid gap-4 md:grid-cols-2 border rounded p-4" onsubmit={(event) => save(event, true)}>
      <h3 class="md:col-span-2 font-semibold">Edit user</h3>
      <label class="text-sm">
        <div class="mb-1">Full name</div>
        <input class="border rounded px-2 py-1 w-full" bind:value={editing.full_name} required disabled={loading} />
      </label>
      <label class="text-sm">
        <div class="mb-1">Role</div>
        <select class="border rounded px-2 py-1 w-full" bind:value={editing.role} required disabled={loading}>
          <option value="admin">Admin</option>
          <option value="resident">Resident</option>
          <option value="attending">Attending</option>
          <option value="typist">Typist</option>
        </select>
      </label>
      {#if editing.role === 'resident'}
        <label class="md:col-span-2 text-sm flex items-center gap-2">
          <input type="checkbox" bind:checked={editing.can_sign_as_attending} disabled={loading} />
          Allow attending signature on assigned recordings
        </label>
      {/if}
      <label class="text-sm">
        <div class="mb-1">Username</div>
        <input class="border rounded px-2 py-1 w-full" bind:value={editing.username} autocomplete="username" pattern={'[a-z][a-z0-9._\\-]{2,31}'} minlength="3" maxlength="32" required={editing.hasCredentials} disabled={loading} />
      </label>
      <label class="text-sm">
        <div class="mb-1">New password (optional)</div>
        <input class="border rounded px-2 py-1 w-full" type="password" bind:value={editing.password} autocomplete="new-password" minlength="8" disabled={loading} />
      </label>
      <p class="md:col-span-2 text-sm">Blank password keeps the current one. Use 8+ characters, at most 72 UTF-8 bytes. To enable login, provide both username and password. Signed or processing assignments may block role changes or removal. The last administrator cannot be removed or demoted.</p>
      <div class="md:col-span-2 flex gap-2">
        <button class="border rounded px-3 py-2 hover:bg-gray-100" type="submit" disabled={loading}>Save changes</button>
        <button class="border rounded px-3 py-2" type="button" disabled={loading} onclick={() => (editing = null)}>Cancel</button>
      </div>
    </form>
  {/if}

  <div class="flex flex-wrap items-center gap-3">
    <span class="text-sm" role="status">{selectedIds.length} selected</span>
    <button class="border rounded px-3 py-2 hover:bg-gray-100" type="button" disabled={loading || selectedIds.length === 0} onclick={sendGroupLink}>Send group link</button>
  </div>

  <div class="border rounded overflow-auto">
    <table class="min-w-full text-sm">
      <thead class="bg-gray-50">
        <tr>
          <th class="text-left p-2">
            <input type="checkbox" class="align-middle" aria-label="Select all users with Telegram" checked={allSelected} indeterminate={selectedIds.length > 0 && !allSelected} disabled={loading || eligibleUsers.length === 0} onchange={(event) => { selectedUserIds = event.currentTarget.checked ? eligibleUsers.map((user) => Number(user.id)) : []; }} />
          </th>
          <th class="text-left p-2">Name</th>
          <th class="text-left p-2">Role</th>
          <th class="text-left p-2">Username</th>
          <th class="text-left p-2">Group link</th>
          <th class="text-left p-2">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each data.users as user (user.id)}
          <tr class="border-t">
            <td class="p-2">
              <input type="checkbox" class="align-middle" aria-label={`Select ${user.full_name} for a Telegram group link`} checked={selectedIds.includes(Number(user.id))} disabled={loading || !isTelegramEligible(user)} onchange={(event) => toggleUser(user, event.currentTarget.checked)} />
            </td>
            <td class="p-2">{user.full_name}</td>
            <td class="p-2">{user.role}{user.role === 'resident' && user.can_sign_as_attending ? ' · Can sign as attending' : ''}</td>
            <td class="p-2">{user.username ?? '-'}</td>
            <td class="p-2 whitespace-nowrap">{invitationStatus(user)}</td>
            <td class="p-2">
              <div class="flex gap-2">
                <button class="border rounded px-3 py-1" disabled={loading} onclick={() => editUser(user)}>Edit</button>
                <button class="border rounded px-3 py-1 text-red-600" disabled={loading || user.id === data.user?.id} title={user.id === data.user?.id ? 'You cannot remove your own account.' : 'Remove user'} onclick={() => removeUser(user)}>Remove</button>
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
