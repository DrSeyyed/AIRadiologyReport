<script>
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { adminNavigation } from '$lib/admin-navigation.js';

	let { data, children } = $props();
	const groups = $derived(adminNavigation(data.user));
	const activeGroup = $derived(groups.find((group) => group.links.some((link) => link.href === page.route.id)));
</script>

<div class="mx-auto w-full min-w-0 max-w-screen-2xl space-y-6">
	<nav class="space-y-3 rounded-box border border-base-300 bg-base-100 p-4" aria-label="Administration">
		<div class="flex flex-wrap items-center gap-2">
			{#if data.user?.role === 'admin'}
				<a href={resolve('/admin')} class="btn btn-sm" class:btn-primary={page.route.id === '/admin'} class:btn-ghost={page.route.id !== '/admin'} aria-current={page.route.id === '/admin' ? 'page' : undefined}>Admin overview</a>
			{/if}
			{#each groups as group (group.id)}
				<a href={resolve(group.links[0].href)} class="btn btn-sm" class:btn-neutral={activeGroup?.id === group.id} class:btn-ghost={activeGroup?.id !== group.id} aria-current={activeGroup?.id === group.id ? 'location' : undefined}>{group.label}</a>
			{/each}
		</div>
		{#if activeGroup}
			<div class="flex flex-wrap gap-2 border-t border-base-200 pt-3" role="group" aria-label={`${activeGroup.label} pages`}>
				{#each activeGroup.links as link (link.href)}
					<a href={resolve(link.href)} class="rounded-btn px-3 py-2 text-sm hover:bg-base-200" class:bg-primary={page.route.id === link.href} class:text-primary-content={page.route.id === link.href} aria-current={page.route.id === link.href ? 'page' : undefined}>{link.label}</a>
				{/each}
			</div>
		{/if}
	</nav>
	<div class="min-w-0 rounded-box border border-base-300 bg-base-100 p-4 sm:p-6">
		{@render children?.()}
	</div>
</div>
