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
		if (mounted && status?.configured) timer = setTimeout(loadStatus, status.active ? 3000 : 10000);
	}

	async function loadStatus() {
		try {
			const response = await fetch(resolve('/api/telegram/study-indexes'));
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Unable to load Telegram index status.');
			if (mounted) { status = result; error = ''; }
		} catch (caught) {
			if (mounted) error = caught.message || 'Unable to load Telegram index status.';
		} finally {
			schedulePoll();
		}
	}

	async function rebuild() {
		if (sending || status?.active || !status?.configured) return;
		if (!window.confirm('Rebuild date-topic indexes for all linked studies, including disabled studies? This creates or updates attending lists in Telegram topics, ignoring current filters. Original study messages, replies, reports and signatures remain unchanged.')) return;
		sending = true;
		error = '';
		message = '';
		try {
			const response = await fetch(resolve('/api/telegram/study-indexes'), {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Unable to rebuild Telegram indexes.');
			if (mounted) {
				status = result;
				message = result.already_running ? 'Telegram index synchronization is already running.'
					: 'Telegram index rebuild queued. It continues if you leave this page.';
			}
		} catch (caught) {
			if (mounted) error = caught.message || 'Unable to rebuild Telegram indexes.';
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
	<button type="button" class="btn btn-outline h-auto min-h-10 max-w-full whitespace-normal" onclick={rebuild}
		disabled={sending || !status?.configured || Boolean(status?.active)}>
		{sending ? 'Queuing index rebuild…' : 'Rebuild Telegram indexes'}
	</button>
	<p class="text-xs">Automatic date topics: study date/time, 08:00–08:00, separate attending lists.</p>
	{#if status && !status.configured}<p class="text-xs">Configure the Telegram bot token and study group first.</p>{/if}
	{#if message}<p class="text-xs" role="status">{message}</p>{/if}
	{#if status?.configured}
		<p class="text-xs" role="status">Topics: {status.topics} · Pending lists: {status.pending} · Synced: {status.synced} · Failed: {status.failed}</p>
		{#if status.planning && !status.paused}<p class="text-xs" role="status">Preparing date-topic indexes…</p>{/if}
		{#if status.skipped}<p class="text-xs">Skipped {status.skipped} studies with invalid dates/times or unavailable message links.</p>{/if}
		{#if status.paused}<p class="text-xs text-warning" role="status">Telegram indexing is paused. Correct the configuration, then rebuild.</p>{/if}
		{#if status.last_error}<p class="text-xs text-warning" role="status">{status.last_error}</p>{/if}
	{/if}
	{#if error}<p class="text-xs text-error" role="alert">{error}</p>{/if}
</div>
