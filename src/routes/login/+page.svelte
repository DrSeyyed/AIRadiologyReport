<script>
  import { goto, invalidateAll } from '$app/navigation';

  let username = '';
  let password = '';
  let loading = false;
  let error = '';

  async function onSubmit(e) {
    e.preventDefault();
    error = '';
    loading = true;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || 'Login failed');
      }

      await invalidateAll();
      goto('/studies');
    } catch (err) {
      error = err.message || 'Login failed';
    } finally {
      loading = false;
    }
  }
</script>

<div class="w-full min-w-0">
  <form class="w-full max-w-sm border rounded p-6 space-y-4 bg-pink-100" on:submit|preventDefault={onSubmit}>
    <h2 class="page-title">Login</h2>

    {#if error}
      <div class="text-red-600 text-sm border border-red-200 rounded p-2">{error}</div>
    {/if}

    <label class="block text-sm">
      <span class="block mb-1">Username</span>
      <input
        class="w-full border rounded px-3 py-2"
        bind:value={username}
        autocomplete="username"
        required
      />
    </label>

    <label class="block text-sm">
      <span class="block mb-1">Password</span>
      <input
        type="password"
        class="w-full border rounded px-3 py-2"
        bind:value={password}
        autocomplete="current-password"
        required
      />
    </label>

    <button
      class="button-tint btn-primary w-full border rounded px-3 py-2 font-medium"
      disabled={loading}
      type="submit"
    >
      {#if loading}Signing in...{:else}Sign in{/if}
    </button>

  </form>
</div>
