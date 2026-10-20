<script>
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';

	let status = $state(null);
	let sending = $state(false);
	let error = $state('');
	let message = $state('');
	let mounted = false;
	let timer;

	function schedulePoll() {
		clearTimeout(timer);
		if (mounted && status?.pending) timer = setTimeout(loadStatus, 3000);
	}

	async function loadStatus() {
		try {
			const response = await fetch(resolve('/api/telegram/study-refresh'));
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Unable to load Telegram refresh status.');
			if (mounted) {
				status = result;
				error = '';
			}
		} catch (caught) {
			if (mounted) error = caught.message || 'Unable to load Telegram refresh status.';
		} finally {
			schedulePoll();
		}
	}

	async function refresh() {
		if (sending || status?.pending || !status?.configured) return;
		if (!window.confirm('Refresh all existing linked Telegram study messages, including disabled studies? This ignores current filters. No new messages will be sent, and reports and signatures will not change.')) return;
		sending = true;
		error = '';
		message = '';
		try {
			const response = await fetch(resolve('/api/telegram/study-refresh'), {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Unable to queue Telegram refresh.');
			if (mounted) {
				status = result;
				message = result.already_running ? 'A Telegram refresh is already running.'
					: result.queued ? `Queued ${result.queued} study messages. Refresh continues if you leave this page.`
						: 'No linked Telegram study messages found.';
			}
		} catch (caught) {
			if (mounted) error = caught.message || 'Unable to queue Telegram refresh.';
		} finally {
			sending = false;
			schedulePoll();
		}
	}

	onMount(() => {
		mounted = true;
		loadStatus();
		return () => { mounted = false; clearTimeout(timer); };
	});
</script>

<div class="min-w-0 max-w-full space-y-1">
	<button type="button" class="btn btn-outline h-auto min-h-10 max-w-full whitespace-normal" onclick={refresh}
		disabled={sending || !status?.configured || Boolean(status?.pending)}>
		{sending ? 'Queuing Telegram refresh…' : 'Refresh all Telegram study messages'}
	</button>
	<p class="text-xs">All linked studies, including disabled; ignores current filters.</p>
	{#if status && !status.configured}<p class="text-xs">Configure the Telegram bot token and study group first.</p>{/if}
	{#if message}<p class="text-xs" role="status">{message}</p>{/if}
	{#if status?.total}
		<p class="text-xs" role="status">Pending: {status.pending} · Refreshed: {status.refreshed} · Failed: {status.failed} · Skipped: {status.skipped}</p>
		{#if !status.pending && status.failed}<p class="text-xs">Check bot permissions or missing messages, then refresh again to retry.</p>{/if}
	{/if}
	{#if error}<p class="text-error text-xs" role="alert">{error}</p>{/if}
</div>
