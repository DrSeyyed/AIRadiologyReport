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

<div class="drawer min-h-screen w-full min-w-0 bg-green-100">
	<input id="main-drawer" type="checkbox" class="drawer-toggle" aria-label="Open navigation" bind:checked={drawerOpen} />
	<div class="drawer-content flex min-h-screen min-w-0 flex-col">
		<header class="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-blue-100 px-4 py-2">
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
			<li><a href={resolve('/studies')} class="link link-primary p-3">Studies</a></li>
			{#if data.user}
				<li><a href={resolve('/account')} class="link link-primary p-3">Account</a></li>
			{/if}
			{#if canManageTemplates(data.user)}
				<li><a href={resolve('/admin/templates')} class="link link-primary p-3">Templates</a></li>
			{/if}
			{#if data.user?.role === 'admin'}
				<li class="menu-title">Admin</li>
				<li><a href={resolve('/admin/users')} class="link link-primary p-3">Users</a></li>
				<li><a href={resolve('/admin/body-parts')} class="link link-primary p-3">Body parts</a></li>
				<li><a href={resolve('/admin/pacs')} class="link link-primary p-3">PACS viewer settings</a></li>
				<li><a href={resolve('/admin/transcription')} class="link link-primary p-3">Transcription settings</a></li>
				<li><a href={resolve('/admin/reporting')} class="link link-primary p-3">Reporting settings</a></li>
				<li><a href={resolve('/admin/telegram-registrations')} class="link link-primary p-3">Telegram registrations</a></li>
			{/if}
		</ul>
	</aside>
</div>
