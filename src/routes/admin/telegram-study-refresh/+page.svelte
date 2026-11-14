<script>
	import TelegramStudyRefresh from './TelegramStudyRefresh.svelte';
</script>

<section class="max-w-3xl space-y-4">
	<header class="space-y-1">
		<h1 class="page-title">Telegram study message refresh</h1>
		<p class="text-sm text-base-content/70">Update Telegram study messages with current study details and status, and recreate missing messages. Disabled studies stay marked disabled; reports and signatures are unchanged.</p>
	</header>
	<div class="rounded-box border bg-base-100 p-4 sm:p-6">
		<TelegramStudyRefresh />
	</div>
</section>
