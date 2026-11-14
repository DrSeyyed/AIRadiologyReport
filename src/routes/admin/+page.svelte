<script>
	import { resolve } from '$app/paths';
	import { adminNavigation } from '$lib/admin-navigation.js';

	let { data } = $props();
	const groups = $derived(adminNavigation(data.user));
</script>

<section class="space-y-6">
	<header class="space-y-1">
		<h1 class="page-title">Administration</h1>
		<p class="text-sm text-base-content/70">Choose an area to manage. Clinical work remains on the Studies page.</p>
	</header>
	<div class="grid min-w-0 gap-6 xl:grid-cols-3">
		{#each groups as group (group.id)}
			<section class="min-w-0 space-y-4 rounded-box border border-base-300 p-4" aria-labelledby={`admin-group-${group.id}`}>
				<header class="space-y-1">
					<h2 id={`admin-group-${group.id}`} class="section-title">{group.label}</h2>
					<p class="text-sm text-base-content/70">{group.description}</p>
				</header>
				<ul class="space-y-2">
					{#each group.links as link (link.href)}
						<li><a href={resolve(link.href)} class="block space-y-1 rounded-btn border border-base-200 p-3 hover:border-primary hover:bg-base-200">
							<span class="block font-medium">{link.label}</span>
							<span class="block text-sm text-base-content/70">{link.description}</span>
						</a></li>
					{/each}
				</ul>
			</section>
		{/each}
	</div>
</section>
