<script>
	import TelegramStudyRefresh from './TelegramStudyRefresh.svelte';
</script>

<section class="max-w-3xl space-y-4">
	<header class="space-y-1">
		<h1 class="text-2xl font-semibold">Telegram study message refresh</h1>
		<p class="text-sm text-base-content/70">Update existing linked Telegram study messages with current study details and links. No new messages are sent, and reports and signatures are unchanged.</p>
	</header>
	<div class="rounded-box border bg-base-100 p-4 sm:p-6">
		<TelegramStudyRefresh />
	</div>
</section>
