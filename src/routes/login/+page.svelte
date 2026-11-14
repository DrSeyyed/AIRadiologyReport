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

<section class="w-full min-w-0 max-w-md py-6 sm:py-10" aria-labelledby="login-title">
  <form class="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8" on:submit|preventDefault={onSubmit} aria-busy={loading}>
    <div class="space-y-3">
      <div class="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-600" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="5" y="10" width="14" height="11" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
        </svg>
      </div>
      <div class="space-y-1">
        <h1 id="login-title" class="page-title">Sign in</h1>
        <p class="text-sm text-slate-500">Welcome back to Personal Taleghani PACS.</p>
      </div>
    </div>

    {#if error}
      <div class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</div>
    {/if}

    <div class="space-y-4">
      <label class="block text-sm">
        <span class="mb-1.5 block font-medium text-slate-700">Username</span>
        <input
          class="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
          bind:value={username}
          autocomplete="username"
          autocapitalize="none"
          spellcheck="false"
          required
        />
      </label>

      <label class="block text-sm">
        <span class="mb-1.5 block font-medium text-slate-700">Password</span>
        <input
          type="password"
          class="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
          bind:value={password}
          autocomplete="current-password"
          required
        />
      </label>
    </div>

    <button class="btn btn-primary min-h-11 w-full" disabled={loading} type="submit">
      {#if loading}Signing in...{:else}Sign in{/if}
    </button>
  </form>
</section>
