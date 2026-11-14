<script>
	import { resolve } from '$app/paths';
	import FavoriteCategories from '../studies/FavoriteCategories.svelte';
	let { data } = $props();
</script>

<svelte:head><title>My study favorites</title></svelte:head>

<section class="w-full min-w-0 max-w-4xl space-y-6">
	<a class="btn btn-outline btn-sm" href={resolve('/studies')}>Back to studies</a>
	<h1 class="text-2xl font-bold">My study favorites</h1>
	<FavoriteCategories {data} />
</section>
