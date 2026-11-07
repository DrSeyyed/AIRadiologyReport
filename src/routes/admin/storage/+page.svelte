<script>
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { onMount, untrack } from 'svelte';
	let { data, form } = $props();
	let settings = $state(untrack(() => ({ ...data.settings })));
	onMount(() => {
		let refreshing = false;
		const timer = setInterval(async () => {
			if (document.visibilityState !== 'visible' || refreshing) return;
			refreshing = true;
			try { await invalidateAll(); }
			catch { /* Keep the last status visible if the server is temporarily unavailable. */ }
			finally { refreshing = false; }
		}, 5_000);
		return () => clearInterval(timer);
	});
	const numberFields = [
		['localRetentionDays', 'Keep local audio (days)', 1, 3650],
		['databaseIntervalHours', 'Recovery snapshot interval (hours)', 1, 168],
		['fileBackupHour', 'Daily full backup hour (UTC, 0–23)', 0, 23],
		['hourlyRetention', 'Recent recovery snapshots to keep', 1, 8760],
		['dailyRetention', 'Daily recovery points to keep', 1, 3650],
		['monthlyRetention', 'Monthly recovery points to keep', 1, 120]
	];
	function pauseEnhance() {
		return async ({ update, result }) => {
			await update();
			if (result.type === 'success') settings.enabled = false;
		};
	}
	function time(value) {
		if (!value) return '—';
		const date = new Date(value * 1000);
		return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Invalid timestamp';
	}
</script>

<div class="mx-auto max-w-6xl space-y-6">
	<h2 class="text-2xl font-bold">Storage &amp; Backups</h2>
	<p>Encrypted audio archives free SSD space. Separate recovery snapshots protect your database, audio and reports. All schedules use UTC.</p>
	{#if form?.error}<div class="alert alert-error" role="alert">{form.error}</div>{/if}
	{#if form?.message}<div class="alert alert-info" role="status">{form.message}</div>{/if}
	{#if form?.fingerprint}<p class="break-all font-mono">Observed (not yet trusted): {form.fingerprint}</p>{/if}
	{#if !data.keyConfigured}
		<div class="alert alert-warning">Server setup required: configure a permanent STORAGE_ENCRYPTION_KEY (base64, 32 random bytes) before saving. Keep a separate, secure offsite copy; losing this key makes encrypted audio and backups unrecoverable.</div>
	{/if}
	{#if data.status.resetActive}
		<div class="alert alert-warning" role="status">Storage reset is active. Connection settings, new jobs and restore preparation are disabled. Refresh status to monitor recovery and cleanup. Cancellation remains available; schedules stay paused.</div>
	{/if}
	<form method="POST" action="?/save" use:enhance class="card space-y-4 bg-base-100 p-6 shadow">
		<fieldset disabled={data.status.resetActive} class="contents">
		<h3 class="text-lg font-semibold">SSH/SFTP connection</h3>
		<p class="text-sm">Use a dedicated storage account and existing absolute remote directory. Verify its SSH host fingerprint independently. The saved password is encrypted and is never sent back to this page. Changing an in-use destination requires a separate migration.</p>
		<div class="grid gap-4 md:grid-cols-2">
			<label class="form-control">Hostname or IP<input class="input input-bordered" name="host" bind:value={settings.host} autocomplete="off" maxlength="512" /></label>
			<label class="form-control">SSH port<input class="input input-bordered" type="number" name="port" bind:value={settings.port} min="1" max="65535" required /></label>
			<label class="form-control">Username<input class="input input-bordered" name="username" bind:value={settings.username} autocomplete="off" maxlength="512" /></label>
			<label class="form-control">Password ({data.passwordConfigured ? 'saved; leave blank to keep' : 'not saved'})<input class="input input-bordered" type="password" name="password" autocomplete="new-password" maxlength="4096" /></label>
			<label class="form-control">Remote directory<input class="input input-bordered" name="root" bind:value={settings.root} placeholder="/home/storage/radiology" maxlength="512" /></label>
			<label class="form-control">Trusted SHA256 host fingerprint<input class="input input-bordered font-mono" name="fingerprint" bind:value={settings.fingerprint} placeholder="SHA256:…" maxlength="64" /></label>
		</div>
		<div><button class="btn btn-outline" type="submit" formaction="?/probe" formnovalidate>Observe fingerprint (no login)</button></div>
		<h3 class="text-lg font-semibold">Services, schedule and retention</h3>
		<label class="flex items-center gap-3"><input type="checkbox" class="checkbox" name="enabled" bind:checked={settings.enabled} /> Enable background storage jobs</label>
		<label class="flex items-center gap-3"><input type="checkbox" class="checkbox" name="archiveEnabled" bind:checked={settings.archiveEnabled} /> Copy audio in background and evict eligible local copies</label>
		<label class="flex items-center gap-3"><input type="checkbox" class="checkbox" name="backupsEnabled" bind:checked={settings.backupsEnabled} /> Scheduled recovery snapshots and daily full backups</label>
		<div class="grid gap-4 md:grid-cols-2">
			{#each numberFields as [name, label, min, max] (name)}
				<label class="form-control">{label}<input class="input input-bordered" type="number" {name} {min} {max} bind:value={settings[name]} required /></label>
			{/each}
		</div>
		<p class="text-sm">Audio is removed from SSD only after verified archiving and a successful subsequent full recovery backup. Keep backups enabled for eviction. Pausing jobs does not disable archived-audio playback. Snapshots also include referenced audio and reports; daily full backups add other uploads and server configuration.</p>
		<p class="text-sm">Retention prunes recovery manifests, not shared encrypted file objects. Storage space is not fully reclaimed automatically. One storage server is not an independent disaster-proof copy; keep another offsite backup.</p>
		<div><button class="btn btn-primary" type="submit" disabled={!data.keyConfigured || data.status.resetActive}>Save settings</button></div>
		</fieldset>
	</form>
	<section class="card space-y-4 bg-base-100 p-6 shadow">
		<h3 class="text-lg font-semibold">Manual actions</h3>
		<p>Save connection settings first. Jobs run on the application server, survive restarts and retry failures without deleting unverified local audio.</p>
		<form method="POST" action="?/job" use:enhance class="flex flex-wrap gap-3">
			<button class="btn btn-outline" name="kind" value="test" disabled={data.status.resetActive}>Test saved connection</button>
			<button class="btn btn-outline" name="kind" value="archive" disabled={data.status.resetActive || !data.settings.enabled || !data.settings.archiveEnabled}>Archive audio now</button>
			<button class="btn btn-outline" name="kind" value="database" disabled={data.status.resetActive || !data.settings.enabled || !data.settings.backupsEnabled}>Recovery snapshot now</button>
			<button class="btn btn-primary" name="kind" value="full" disabled={data.status.resetActive || !data.settings.enabled || !data.settings.backupsEnabled}>Full recovery backup now</button>
		</form>
		<form method="POST" action="?/pause" use:enhance={pauseEnhance}>
			<button class="btn btn-warning" name="confirmation" value="pause">Pause &amp; cancel all</button>
		</form>
		<p class="text-sm">Cancel stops one job, not future scheduled work. Pause &amp; cancel all disables automatic jobs and cancels queued/retrying jobs, connection tests and restore preparations. Running work stops at its next safety check; an in-flight transfer may need to finish or time out. Wait until no jobs are running or cancelling before changing the password. Existing audio, backups and completed restore copies are preserved.</p>
		<p>Awaiting archive: {data.status.backlog}. Archived: {data.status.archived.count} audio files ({(data.status.archived.bytes / 1048576).toFixed(1)} MB); evicted from SSD: {data.status.archived.evicted}.</p>
		{#if data.settings.enabled && data.settings.backupsEnabled}<p>Next scheduled snapshot: {time(data.status.nextDatabase)}. Next daily full backup: {time(data.status.nextFull)}. Due jobs may already be queued.</p>{/if}
		{#each data.status.last as item (item.kind)}<p>Last successful {item.kind}: {time(item.at)}</p>{/each}
		<form method="GET"><button class="btn btn-sm" type="submit">Refresh status</button></form>
		<h3 class="text-lg font-semibold">Restore a recovery backup</h3>
		<p>Prepare a verified copy of the database, reports and audio in a separate server folder. This never replaces the live site. A server administrator must review the copy and activate it manually during downtime.</p>
		<p class="text-sm">Keep enough free disk space for the restored data and temporary encrypted downloads. Prepared copies remain on the application server until manually removed and must be protected like live patient data. Preparation is available even when scheduled storage jobs are paused.</p>
		<form method="POST" action="?/recoveryPoints" use:enhance>
			<button class="btn btn-outline" disabled={data.status.resetActive || !data.keyConfigured || !data.passwordConfigured}>Load recovery points from storage</button>
		</form>
		{#if form?.recoveryPoints?.length}
			<form method="POST" action="?/restore" use:enhance class="space-y-3">
				<fieldset disabled={data.status.resetActive} class="contents">
				<label class="form-control">Completed recovery point
					<select class="select select-bordered font-mono" name="backupId" required>
						<option value="">Select a backup</option>
						{#each form.recoveryPoints as point (point.id)}
							<option value={point.id}>{point.kind === 'full' ? 'Full backup' : 'Recovery snapshot'} — {time(Number(point.id.split('-')[0]))} — {point.id}</option>
						{/each}
					</select>
				</label>
				<label class="flex items-center gap-3"><input class="checkbox" type="checkbox" name="confirmation" value="prepare" required /> I understand this creates a separate recovery copy, not an automatic live restore.</label>
				<button class="btn btn-warning" type="submit" disabled={data.status.resetActive}>Prepare restore</button>
				</fieldset>
			</form>
		{/if}
		{#if data.status.preparedRestores.length}
			<h4 class="font-semibold">Recent verified copies (manual activation required)</h4>
			{#each data.status.preparedRestores as restore (restore.id)}
				<p>Job {restore.id} — {time(restore.finished_at)}: <code class="break-all">{restore.directory}</code></p>
			{/each}
		{/if}
		<p class="text-sm">After success, the job details show the prepared directory relative to the application working directory. Follow the README recovery instructions before manually activating it. Do not merge restored database files with live DB/WAL files.</p>
		<h3 class="text-lg font-semibold">Storage maintenance</h3>
		<form method="POST" action="?/clearLog" use:enhance class="space-y-3">
			<p>Clear finished jobs from this log without contacting storage or requiring the encryption key. Active and retrying jobs stay visible. Safety metadata, archived audio and backups are retained.</p>
			<button class="btn btn-outline" name="confirmation" value="clear">Clear finished log</button>
		</form>
		<div class="alert alert-warning">
			<div>
				<h4 class="font-semibold">Reset storage permanently removes remote archives and backups</h4>
				<p>First use Pause &amp; cancel all, then wait until no jobs are running or cancelling. Ensure adequate free SSD space for ALL archived audio and temporary downloads before resetting.</p>
				<p>The worker first recovers and hash-verifies all archived audio locally. Only then does it delete the app namespaces <code>audio/</code> and <code>backups/</code> under the configured remote root and clear archive tracking and job history. Other remote files are not removed. This cannot be undone.</p>
				<p>The saved connection and encryption key are kept. The live database is never automatically restored or deleted. Scheduling stays paused; review the result before re-enabling jobs.</p>
			</div>
		</div>
		<form method="POST" action="?/reset" use:enhance={pauseEnhance} class="space-y-3">
			<fieldset disabled={data.status.resetActive} class="contents">
				<label class="form-control">Type RESET STORAGE to confirm<input class="input input-bordered" name="confirmation" autocomplete="off" required /></label>
				<label class="flex items-center gap-3"><input class="checkbox" type="checkbox" name="recoverAudio" required /> I approve recovering and hash-verifying all archived audio locally before remote deletion and have ensured adequate SSD space.</label>
				<button class="btn btn-error" type="submit" disabled={data.status.resetActive || !data.keyConfigured || !data.passwordConfigured}>Reset storage</button>
			</fieldset>
		</form>
		<p class="text-sm">Status refreshes every 5 seconds while this page is visible. Audio uploads stop after 30 seconds without data progress and retry with backoff; large files can continue while data is moving.</p>
		<div class="overflow-x-auto">
			<table class="table"><thead><tr><th>Job</th><th>Type</th><th>Status</th><th>Started (UTC)</th><th>Details</th><th>Actions</th></tr></thead><tbody>
			{#each data.status.jobs as job (job.id)}
				<tr><td>{job.id}</td><td>{job.kind}</td><td>{job.status}{#if job.status !== 'cancelled'} ({job.attempts}/8){/if}</td><td>{time(job.started_at || job.created_at)}</td><td>{#if job.progress}<p class="break-all">{job.progress}</p>{/if}{job.error || ''}{#if job.backupId}<span class="break-all">Recovery ID: {job.backupId}</span>{/if}{#if job.restoreDirectory}<p class="break-all font-mono">Verified copy ready: {job.restoreDirectory}</p><p>Live site unchanged. Manual activation required.</p>{/if}{#if job.status === 'failed' && job.attempts < 8} Retry: {time(job.retry_at)}{/if}{#if job.status === 'cancelling'} Stopping at the next safety check…{/if}</td><td>{#if job.canCancel}<form method="POST" action="?/cancel" use:enhance><button class="btn btn-sm btn-outline" name="jobId" value={job.id}>Cancel</button></form>{/if}</td></tr>
			{/each}
			</tbody></table>
		</div>
	</section>
</div>
