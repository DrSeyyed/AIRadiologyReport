<script>
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { telegramRefreshDatePresets, telegramRefreshDateRange } from '$lib/telegram-refresh-date-range.js';

	let dateRange = $state('all');
	let dateFrom = $state('');
	let dateTo = $state('');
	let status = $state(null);
	let sending = $state(false);
	let stopping = $state(false);
	let statusVersion = 0;
	let error = $state('');
	let message = $state('');
	let mounted = false;
	let timer;

	function schedulePoll() {
		clearTimeout(timer);
		if (mounted && !stopping && status?.pending) timer = setTimeout(loadStatus, 3000);
	}

	async function loadStatus() {
		const version = statusVersion;
		try {
			const response = await fetch(resolve('/api/telegram/study-refresh'));
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Unable to load Telegram refresh status.');
			if (mounted && version === statusVersion) {
				status = result;
				error = '';
			}
		} catch (caught) {
			if (mounted && version === statusVersion) error = caught.message || 'Unable to load Telegram refresh status.';
		} finally {
			schedulePoll();
		}
	}

	async function refresh() {
		if (sending || stopping || !status?.configured) return;
		const filters = { date_range: dateRange };
		if (dateRange === 'custom') Object.assign(filters, { date_from: dateFrom, date_to: dateTo });
		let range;
		try { range = telegramRefreshDateRange(filters); }
		catch (caught) { error = caught.message; return; }
		const scope = range.preset === 'all' ? 'all examination dates'
			: `${range.label}: ${range.date_from} to ${range.date_to} (Jalali, inclusive)`;
		if (!window.confirm(`Refresh Telegram study messages for ${scope}, including disabled studies? This ignores current filters. Already queued work remains unchanged. Missing messages will be recreated with the current status; reports and signatures will not change. Deleted voices and replies will not be reposted.`)) return;
		sending = true;
		statusVersion++;
		error = '';
		message = '';
		try {
			const response = await fetch(resolve('/api/telegram/study-refresh'), {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filters)
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Unable to queue Telegram refresh.');
			if (mounted) {
				status = result;
				message = result.already_running ? 'A Telegram refresh is already running.'
					: result.queued ? `Queued ${result.queued} study messages. Refresh continues if you leave this page.`
						: 'No studies found in the selected examination date range.';
			}
		} catch (caught) {
			if (mounted) error = caught.message || 'Unable to queue Telegram refresh.';
		} finally {
			sending = false;
			schedulePoll();
		}
	}

	async function stop() {
		if (stopping || sending || !status?.pending) return;
		if (!window.confirm('Cancel all pending Telegram study refreshes, including individually queued studies? Requests already sent may finish. Completed changes will be kept.')) return;
		stopping = true;
		statusVersion++;
		clearTimeout(timer);
		error = '';
		message = '';
		try {
			const response = await fetch(resolve('/api/telegram/study-refresh'), { method: 'DELETE' });
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Unable to cancel Telegram refresh.');
			if (mounted) {
				status = result;
				message = result.cancelled ? `Cancelled ${result.cancelled} queued refreshes (counted as skipped). Requests already sent may finish; completed changes are kept.`
					: 'No pending Telegram refreshes to cancel.';
			}
		} catch (caught) {
			if (mounted) error = caught.message || 'Unable to cancel Telegram refresh.';
		} finally {
			stopping = false;
			schedulePoll();
		}
	}

	onMount(() => {
		mounted = true;
		loadStatus();
		return () => { mounted = false; clearTimeout(timer); };
	});
</script>

<div class="min-w-0 max-w-full space-y-3">
	<div class="grid gap-3 sm:grid-cols-3">
		<label class="form-control min-w-0">
			<span class="label-text mb-1">Examination date range</span>
			<select class="select select-bordered w-full" bind:value={dateRange} disabled={sending || stopping} aria-describedby="refresh-dates-help">
				{#each telegramRefreshDatePresets as preset (preset.value)}<option value={preset.value}>{preset.label}</option>{/each}
			</select>
		</label>
		{#if dateRange === 'custom'}
			<label class="form-control min-w-0">
				<span class="label-text mb-1">From (Jalali)</span>
				<input class="input input-bordered w-full" type="text" bind:value={dateFrom} disabled={sending || stopping} placeholder="YYYY-MM-DD" dir="ltr" aria-describedby="refresh-dates-help" />
			</label>
			<label class="form-control min-w-0">
				<span class="label-text mb-1">To (Jalali)</span>
				<input class="input input-bordered w-full" type="text" bind:value={dateTo} disabled={sending || stopping} placeholder="YYYY-MM-DD" dir="ltr" aria-describedby="refresh-dates-help" />
			</label>
		{/if}
	</div>
	<p id="refresh-dates-help" class="text-xs">Uses examination dates (Jalali, inclusive). Presets use Tehran calendar days. Includes disabled studies; worklist filters do not apply. Already queued work remains unchanged.</p>
	<div class="flex flex-wrap gap-2">
		<button type="button" class="btn btn-outline h-auto min-h-10 max-w-full whitespace-normal" onclick={refresh}
			disabled={sending || stopping || !status?.configured}>
			{sending ? 'Queuing Telegram refresh…' : 'Refresh & recover Telegram study messages'}
		</button>
		{#if status?.pending}
			<button type="button" class="btn btn-outline btn-error h-auto min-h-10 max-w-full whitespace-normal" onclick={stop}
				disabled={sending || stopping}>{stopping ? 'Cancelling…' : 'Stop & cancel refresh'}</button>
		{/if}
	</div>
	<p class="text-xs">Missing messages are recreated with current details and status. Voices and replies are not reposted.</p>
	{#if status && !status.configured}<p class="text-xs">Configure the Telegram bot token and study group first.</p>{/if}
	{#if message}<p class="text-xs" role="status">{message}</p>{/if}
	{#if status?.total}
		<p class="text-xs" role="status">Pending: {status.pending} · Refreshed / recovered: {status.refreshed} · Failed: {status.failed} · Skipped: {status.skipped}</p>
		{#if !status.pending && status.failed}<p class="text-xs">Check bot permissions and Telegram configuration, then refresh again to retry.</p>{/if}
	{/if}
	{#if error}<p class="text-error text-xs" role="alert">{error}</p>{/if}
</div>
