<script>
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { resolve } from '$app/paths';
	import { goto, invalidateAll } from '$app/navigation';
	import { canManageTemplates } from '$lib/template-permissions.js';
	import { page } from '$app/state';
	import { pageTitle } from '$lib/page-title.js';

	let { data, children } = $props();
	let drawerOpen = $state(false);
	let navigationButton = $state();
	const adminPanelActive = $derived(page.route.id === '/admin' || Boolean(page.route.id?.startsWith('/admin/')));

	function closeNavigation() {
		drawerOpen = false;
		navigationButton?.focus();
	}

	async function logout() {
		await fetch('/api/auth/logout', { method: 'POST' });
		await invalidateAll();
		goto(resolve('/login'));
	}
</script>

<svelte:head>
	<title>{pageTitle(page.route.id)}</title>
	<link rel="icon" href={favicon} />
</svelte:head>

<svelte:window onkeydown={(event) => {
	if (drawerOpen && event.key === 'Escape' && !event.defaultPrevented) {
		event.preventDefault();
		closeNavigation();
	}
}} />

<div class="drawer min-h-screen w-full min-w-0 bg-slate-50">
	<input id="main-drawer" type="checkbox" class="drawer-toggle" aria-label="Open navigation" bind:checked={drawerOpen} />
	<div class="drawer-content flex min-h-screen min-w-0 flex-col">
		<header class="sticky top-0 z-30 flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-blue-100 px-4 py-2">
			<div class="flex min-w-0 items-center gap-2">
				<button type="button" bind:this={navigationButton} class="btn btn-primary drawer-button" aria-label="Open navigation"
					aria-controls="main-navigation" aria-expanded={drawerOpen} onclick={() => (drawerOpen = !drawerOpen)}>☰</button>
				<h1 class="min-w-0 break-words font-semibold">Personal Taleghani PACS</h1>
			</div>
			<div class="flex min-w-0 flex-wrap items-center gap-3 text-sm">
				{#if data.user}
					<span class="min-w-0 break-words opacity-80">Logged in as <strong>{data.user.full_name}</strong> ({data.user.role})</span>
					<button class="btn btn-primary shrink-0" onclick={logout}>Logout</button>
				{:else}
					<button class="btn btn-primary" onclick={() => goto(resolve('/login'))}>Login</button>
				{/if}
			</div>
		</header>
		{#if data.user?.role === 'admin' && data.maintenance?.enabled}
			<div class="alert alert-warning rounded-none" role="status">
				<span>Site maintenance is enabled. Non-admin access is closed.</span>
				<a class="link" href={resolve('/admin/maintenance')}>Manage maintenance</a>
			</div>
		{/if}
		<main class="w-full min-w-0 flex-1 p-4">
			{@render children?.()}
		</main>
	</div>
	<aside id="main-navigation" class="drawer-side z-40" aria-label="Navigation">
		<label for="main-drawer" aria-label="Close navigation" class="drawer-overlay"></label>
		<ul class="menu min-h-full w-64 max-w-full bg-blue-100 p-4 text-base-content">
			<li class="menu-title flex-row items-center justify-between gap-2">
				<span>Dashboard</span>
				<button type="button" class="btn btn-ghost btn-square btn-sm" aria-label="Close navigation" onclick={closeNavigation}>
					<span aria-hidden="true">✕</span>
				</button>
			</li>
			<li><a href={resolve('/studies')} class="p-3" class:active={page.route.id === '/studies'} aria-current={page.route.id === '/studies' ? 'page' : undefined} onclick={closeNavigation}>Studies</a></li>
			{#if data.user}
				<li><a href={resolve('/favorites')} class="p-3" class:active={page.route.id === '/favorites'} aria-current={page.route.id === '/favorites' ? 'page' : undefined} onclick={closeNavigation}>My study favorites</a></li>
			{/if}
			{#if ['admin', 'resident', 'attending', 'typist'].includes(data.user?.role)}
				<li><a href={resolve('/pathology-search')} class="p-3" class:active={page.route.id === '/pathology-search'} aria-current={page.route.id === '/pathology-search' ? 'page' : undefined} onclick={closeNavigation}>Pathology search</a></li>
			{/if}
			{#if data.user?.role === 'admin'}
				<li><a href={resolve('/admin')} class="p-3" class:active={adminPanelActive} aria-current={adminPanelActive ? (page.route.id === '/admin' ? 'page' : 'location') : undefined} onclick={closeNavigation}>Admin panel</a></li>
			{:else}
				{#if data.user}
					<li><a href={resolve('/account')} class="p-3" class:active={page.route.id === '/account'} aria-current={page.route.id === '/account' ? 'page' : undefined} onclick={closeNavigation}>Account</a></li>
				{/if}
				{#if ['resident', 'attending', 'typist'].includes(data.user?.role)}
					<li><a href={resolve('/statistics')} class="p-3" class:active={page.route.id === '/statistics'} aria-current={page.route.id === '/statistics' ? 'page' : undefined} onclick={closeNavigation}>Statistics</a></li>
				{/if}
				{#if canManageTemplates(data.user)}
					<li><a href={resolve('/admin/templates')} class="p-3" onclick={closeNavigation}>Report templates</a></li>
				{/if}
			{/if}
		</ul>
	</aside>
</div>
