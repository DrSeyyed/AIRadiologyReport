<script>
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { goto, invalidateAll} from '$app/navigation';

	let { data, children } = $props();
  	
	let sidebarOpen = $state(true);

	function toggleSidebar() {
		sidebarOpen = !sidebarOpen;
	}

	async function logout() {
		await fetch('/api/auth/logout', { method: 'POST' });
		// Send them to login page
		await invalidateAll();
		goto('/login');
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="min-h-screen flex flex-col bg-green-100">
  <!-- Top bar -->
  <header class="flex items-center justify-between px-4 h-14 border-b bg-blue-100 dark:bg-black">
    <div class="flex items-center gap-2">
      <input id="my-drawer_1" type="checkbox" class="drawer-toggle" />
      <div class="drawer-content flex flex-col items-center justify-center">
        <label for="my-drawer_1" class="btn btn-primary drawer-button">
          ☰
        </label>
      </div>
      <div class="drawer-side">
      <label for="my-drawer_1" aria-label="close sidebar" class="drawer-overlay"></label>
      <ul class="menu bg-blue-100 text-base-content min-h-full w-64 p-4">
        <!-- Sidebar content here -->
        <div class="divider p-3">Dashboard</div>
        <a href="/" class="link link-primary p-3">Home</a>
        <a href="/studies" class="link link-primary p-3">Studies</a>
        {#if data?.user?.role === 'admin'}
          <div class="divider p-3">Admin</div>
          <a href="/admin/users" class="link link-primary p-3">Users</a>
          <a href="/admin/patients" class="link link-primary p-3">Patients</a>
          <a href="/admin/templates" class="link link-primary p-3">Templates</a>
        {/if}
      </ul>
    </div>
      <h1 class="font-semibold">Personal Taleghani PACS</h1>
    </div>
    <!-- Right side: auth status -->
    <div class="flex items-center gap-3 text-sm">
      {#if data.user}
        <span class="opacity-80">
          Logged in as <strong>{data.user.full_name}</strong> ({data.user.role})
        </span>
        <button class="btn btn-primary" onclick={logout}>
          Logout
        </button>
      {:else}
        <button class="btn btn-primary" onclick={goto('/login')}>
          Login
        </button>
      {/if}
    </div>
  </header>

  <!-- Page Content -->
  <div class="flex-1 flex">
    <main class="flex-1 p-4">
      {@render children?.()}
    </main>
  </div>
</div>
