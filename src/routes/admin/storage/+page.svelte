<script>
	import { enhance } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onMount, untrack } from 'svelte';
	let { data, form } = $props();
	const tabs = [
		{ id: 'overview', label: 'Overview & jobs' },
		{ id: 'settings', label: 'Settings' },
		{ id: 'restore', label: 'Restore' },
		{ id: 'maintenance', label: 'Maintenance' }
	];
	let activeTab = $state(untrack(() => data.tab || 'overview'));
	function selectTab(id) {
		activeTab = id;
		const url = new URL(window.location.href);
		url.searchParams.set('tab', id);
		replaceState(resolve(`/admin/storage${url.search}${url.hash}`), {});
	}
	function tabClick(event, id) {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		selectTab(id);
	}
	function tabKeydown(event, index) {
		let next;
		if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
		else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = tabs.length - 1;
		else return;
		event.preventDefault();
		selectTab(tabs[next].id);
		document.getElementById(`storage-tab-${tabs[next].id}`)?.focus();
	}
	let settings = $state(untrack(() => ({ ...data.settings })));
	let fullBackupHours = $state(untrack(() => data.settings.fullBackupHours.join(', ')));
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
	const timeoutFields = [
		['uploadTimeoutSeconds', 'Upload inactivity timeout (seconds)'],
		['verificationTimeoutSeconds', 'Verification/read and command timeout (seconds)']
	];
	const numberFields = [
		['parallelConnections', 'Parallel storage connections (default 4)', 1, 16],
		['syncIntervalMinutes', 'Automatic file sync / audio eviction check interval (minutes)', 1, 1440],
		['localRetentionDays', 'Keep local audio (days)', 1, 3650],
		['integrityAuditDays', 'Remote integrity audit cadence (days)', 1, 365],
		['hourlyRetention', 'Recent recovery points to keep', 1, 8760],
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
	<p class="text-sm text-base-content/70">Encrypted file sync and full recovery backups. All schedules use UTC.</p>
	<div class="tabs tabs-boxed flex-nowrap overflow-x-auto" role="tablist" aria-label="Storage administration">
		{#each tabs as tab, index (tab.id)}
			<a id={`storage-tab-${tab.id}`} href={resolve(`/admin/storage?tab=${tab.id}`)} role="tab" class="tab whitespace-nowrap" class:tab-active={activeTab === tab.id} aria-selected={activeTab === tab.id} aria-controls={`storage-panel-${tab.id}`} tabindex={activeTab === tab.id ? 0 : -1} onclick={(event) => tabClick(event, tab.id)} onkeydown={(event) => tabKeydown(event, index)}>{tab.label}</a>
		{/each}
	</div>
	{#if form?.error}<div class="alert alert-error" role="alert">{form.error}</div>{/if}
	{#if form?.message}<div class="alert alert-info" role="status">{form.message}</div>{/if}
	{#if form?.fingerprint}<p class="break-all font-mono">Observed (not yet trusted): {form.fingerprint}</p>{/if}
	{#if !data.keyConfigured}
		<div class="alert alert-warning">Server setup required: configure a permanent STORAGE_ENCRYPTION_KEY (base64, 32 random bytes) before saving. Keep a separate, secure offsite copy; losing this key makes encrypted audio and backups unrecoverable.</div>
	{/if}
	{#if data.status.resetActive}
		<div class="alert alert-warning" role="status">Storage reset is active. Connection settings, new jobs and restore preparation are disabled. Refresh status to monitor recovery and cleanup. Cancellation remains available; schedules stay paused.</div>
	{/if}
	<div id="storage-panel-settings" role="tabpanel" aria-labelledby="storage-tab-settings" tabindex="0" hidden={activeTab !== 'settings'}>
	<form method="POST" action="?/save&tab=settings" use:enhance class="card space-y-4 bg-base-100 p-6 shadow">
		<fieldset disabled={data.status.resetActive} class="contents">
		<h3 class="text-lg font-semibold">SSH/SFTP connection</h3>
		<p class="text-sm text-base-content/70">Use a dedicated SSH/SFTP account and verify its fingerprint independently. Leave the password blank to keep the saved one.</p>
		<div class="grid gap-4 md:grid-cols-2">
			<label class="form-control">Hostname or IP<input class="input input-bordered" name="host" bind:value={settings.host} autocomplete="off" maxlength="512" /></label>
			<label class="form-control">SSH port<input class="input input-bordered" type="number" name="port" bind:value={settings.port} min="1" max="65535" required /></label>
			<label class="form-control">Username<input class="input input-bordered" name="username" bind:value={settings.username} autocomplete="off" maxlength="512" /></label>
			<label class="form-control">Password ({data.passwordConfigured ? 'saved; leave blank to keep' : 'not saved'})<input class="input input-bordered" type="password" name="password" autocomplete="new-password" maxlength="4096" /></label>
			<label class="form-control">Remote directory<input class="input input-bordered" name="root" bind:value={settings.root} placeholder="/home/storage/radiology" maxlength="512" /></label>
			<label class="form-control">Trusted SHA256 host fingerprint<input class="input input-bordered font-mono" name="fingerprint" bind:value={settings.fingerprint} placeholder="SHA256:…" maxlength="64" /></label>
		</div>
		<div><button class="btn btn-outline" type="submit" formaction="?/probe&tab=settings" formnovalidate>Observe fingerprint (no login)</button></div>
		<details class="space-y-2 text-sm">
			<summary class="cursor-pointer font-semibold">Linux SSH setup and verification</summary>
			<p>The account needs SSH command execution as well as SFTP, including Linux <code>sha256sum</code>, <code>stat</code>, <code>mkdir</code> and <code>mv</code>. An SFTP-only account is not sufficient. A server administrator can prepare a dedicated directory and read the host fingerprint over a trusted connection:</p>
			<pre class="overflow-x-auto"><code>sudo install -d -m 700 -o storage -g storage /home/storage/radiology
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256</code></pre>
			<p>Replace the account and path as appropriate; the path must match the remote directory above. Protect this directory from other users. Do not edit or gzip immutable encrypted objects. Storage-side checks hash encrypted bytes; application verification also authenticates and checks plaintext before any local audio eviction.</p>
		</details>
		<h3 class="text-lg font-semibold">Transfer timeouts</h3>
		<div class="grid gap-4 md:grid-cols-2">
			{#each timeoutFields as [name, label] (name)}
				<label class="form-control">{label}<input class="input input-bordered" type="number" {name} min="1" max="600" step="1" bind:value={settings[name]} required /></label>
			{/each}
		</div>
		<p class="text-sm text-base-content/70">1–600 seconds. Defaults: upload 30; verification 20. Pause jobs and wait for running work to stop before changing settings.</p>
		<details class="text-sm">
			<summary class="cursor-pointer font-medium">How timeouts work</summary>
			<p class="mt-2 text-base-content/70">Uploads and download reads use inactivity limits. Storage-side hash/link commands use the verification timeout as a hard deadline, not an inactivity limit. New settings apply to subsequent jobs; changing an in-use destination requires migration.</p>
		</details>
		<h3 class="text-lg font-semibold">Services, schedule and retention</h3>
		<p class="text-sm text-base-content/70">Automatic file sync and eligible audio eviction checks: every 1–1440 minutes (default 1), in aligned time windows. Pending batches continue on the short worker cycle (normally 15 seconds); manual jobs do not wait for this interval. Full backup UTC hours are independent.</p>
		<label class="flex items-center gap-3"><input type="checkbox" class="checkbox" name="enabled" bind:checked={settings.enabled} /> Enable background storage jobs</label>
		<label class="flex items-center gap-3"><input type="checkbox" class="checkbox" name="archiveEnabled" bind:checked={settings.archiveEnabled} /> Allow eviction of eligible local audio after verified synchronization and backup</label>
		<label class="flex items-center gap-3"><input type="checkbox" class="checkbox" name="backupsEnabled" bind:checked={settings.backupsEnabled} /> Scheduled full recovery backups and background file synchronization</label>
		<label class="form-control">Full backup UTC hours (comma-separated, 0-23)<input class="input input-bordered" name="fullBackupHours" bind:value={fullBackupHours} placeholder="0, 12" required /></label>
		<p class="text-sm text-base-content/70">Choose 1–24 unique UTC hours. Defaults are twice daily at 00:00 and 12:00 UTC; saved schedules are preserved.</p>
		<div class="grid gap-4 md:grid-cols-2">
			{#each numberFields as [name, label, min, max] (name)}
				<label class="form-control">{label}<input class="input input-bordered" type="number" {name} {min} {max} bind:value={settings[name]} required /></label>
			{/each}
		</div>
		<p class="text-sm text-base-content/70">Only audio is eligible for local removal, after verified sync and a subsequent full backup. Reports stay local. Keep an independent offsite backup.</p>
		<details class="space-y-2 text-sm">
			<summary class="cursor-pointer font-medium">Synchronization, parallelism and retention</summary>
			<p>Parallel storage connections: 1–16, default 4. More connections use more memory, temporary space and SSH slots. Respect your storage server's limits.</p>
			<p>Either service enables file sync. Files are immutable, individually encrypted objects without gzip compression; unchanged objects are reused. Keep backups enabled for eviction. Pausing does not disable archived playback.</p>
			<p>Full backups capture the database, managed files and server configuration. Missed slots coalesce into the latest due backup. Integrity audits run in batches (default every 7 days).</p>
			<p>Retention removes recovery manifests, not shared objects; it does not fully reclaim storage space.</p>
		</details>
		<div><button class="btn btn-primary" type="submit" disabled={!data.keyConfigured || data.status.resetActive}>Save settings</button></div>
		</fieldset>
	</form>
	</div>
	<div id="storage-panel-overview" role="tabpanel" aria-labelledby="storage-tab-overview" tabindex="0" hidden={activeTab !== 'overview'} class="card space-y-4 bg-base-100 p-6 shadow">
		<h3 class="text-lg font-semibold">Overview &amp; jobs</h3>
		<p class="text-sm text-base-content/70">Use the saved connection to sync files or create a backup.</p>
		<form method="POST" action="?/job&tab=overview" use:enhance class="flex flex-wrap gap-3">
			<button class="btn btn-outline" name="kind" value="test" disabled={data.status.resetActive}>Test saved connection</button>
			<button class="btn btn-outline" name="kind" value="archive" disabled={data.status.resetActive || !data.settings.enabled || (!data.settings.archiveEnabled && !data.settings.backupsEnabled)}>Sync files now</button>
			<button class="btn btn-primary" name="kind" value="full" disabled={data.status.resetActive || !data.settings.enabled || !data.settings.backupsEnabled}>Full recovery backup now</button>
		</form>
		<form method="POST" action="?/pause&tab=overview" use:enhance={pauseEnhance}>
			<button class="btn btn-warning" name="confirmation" value="pause">Pause &amp; cancel all</button>
		</form>
		<p class="text-sm text-base-content/70">Pause disables schedules and requests cancellation. Existing audio, backups and prepared copies are kept.</p>
		<p>Audio awaiting synchronization: {data.status.backlog}. Archived: {data.status.archived.count} audio files ({(data.status.archived.bytes / 1048576).toFixed(1)} MB); evicted from SSD: {data.status.archived.evicted}.</p>
		{#if data.settings.enabled && data.settings.backupsEnabled}<p>Next scheduled full backup: {time(data.status.nextFull)}. Due jobs may already be queued.</p>{/if}
		{#each data.status.last as item (item.kind)}<p>Last successful {item.kind}: {time(item.at)}</p>{/each}
		<form method="GET"><button class="btn btn-sm" type="submit">Refresh status</button></form>
		{@render jobLog()}
	</div>
	<div id="storage-panel-restore" role="tabpanel" aria-labelledby="storage-tab-restore" tabindex="0" hidden={activeTab !== 'restore'} class="card space-y-4 bg-base-100 p-6 shadow">
		<h3 class="text-lg font-semibold">Restore a recovery backup</h3>
		<p class="text-sm">Prepare a verified copy in a separate server folder. <strong>The live site is not replaced.</strong> Manual activation during downtime is required.</p>
		<details class="text-sm">
			<summary class="cursor-pointer font-medium">Restore requirements and activation</summary>
			<p class="mt-2 text-base-content/70">Allow disk space for restored data and temporary downloads. Protect prepared copies like patient data and remove them manually when no longer needed. Preparation works while schedules are paused. Follow the README recovery procedure; never merge restored DB/WAL files with the live database.</p>
		</details>
		<form method="POST" action="?/recoveryPoints&tab=restore" use:enhance>
			<button class="btn btn-outline" disabled={data.status.resetActive || !data.keyConfigured || !data.passwordConfigured}>Load recovery points from storage</button>
		</form>
		{#if form?.recoveryPoints?.length}
			<form method="POST" action="?/restore&tab=restore" use:enhance class="space-y-3">
				<fieldset disabled={data.status.resetActive} class="contents">
				<label class="form-control">Completed recovery point
					<select class="select select-bordered font-mono" name="backupId" required>
						<option value="">Select a backup</option>
						{#each form.recoveryPoints as point (point.id)}
							<option value={point.id}>{point.kind === 'full' ? 'Full backup' : 'Legacy recovery snapshot'} — {time(Number(point.id.split('-')[0]))} — {point.id}</option>
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
		<p class="text-sm text-base-content/70">After preparation, find the verified directory in Overview &amp; jobs.</p>
	</div>
	<div id="storage-panel-maintenance" role="tabpanel" aria-labelledby="storage-tab-maintenance" tabindex="0" hidden={activeTab !== 'maintenance'} class="card space-y-4 bg-base-100 p-6 shadow">
		<h3 class="text-lg font-semibold">Storage maintenance</h3>
		<form method="POST" action="?/clearLog&tab=maintenance" use:enhance class="space-y-3">
			<p class="text-sm text-base-content/70">Hide finished jobs only. Active jobs, safety metadata, audio and backups are kept.</p>
			<button class="btn btn-outline" name="confirmation" value="clear">Clear finished log</button>
		</form>
		<div class="alert alert-warning">
			<div>
				<h4 class="font-semibold">Reset storage permanently removes remote archives and backups</h4>
				<p>Pause jobs and wait for cancellation first. Allow free SSD space for all archived audio and temporary downloads.</p>
				<p>Audio is recovered and verified locally before the app's remote <code>audio/</code>, <code>files/</code> and <code>backups/</code> are deleted. <strong>Remote backups are permanently lost.</strong></p>
				<details class="mt-2 text-sm">
					<summary class="cursor-pointer font-medium">What reset keeps</summary>
					<p>The live database, local files, connection, encryption key and unrelated remote files are kept. Archive tracking and old job history are cleared. Scheduling stays paused until explicitly re-enabled.</p>
				</details>
			</div>
		</div>
		<form method="POST" action="?/reset&tab=maintenance" use:enhance={pauseEnhance} class="space-y-3">
			<fieldset disabled={data.status.resetActive} class="contents">
				<label class="form-control">Type RESET STORAGE to confirm<input class="input input-bordered" name="confirmation" autocomplete="off" required /></label>
				<label class="flex items-center gap-3"><input class="checkbox" type="checkbox" name="recoverAudio" required /> I approve recovering and hash-verifying all archived audio locally before remote deletion and have ensured adequate SSD space.</label>
				<button class="btn btn-error" type="submit" disabled={data.status.resetActive || !data.keyConfigured || !data.passwordConfigured}>Reset storage</button>
			</fieldset>
		</form>
	</div>
</div>

{#snippet jobLog()}
		<h3 class="text-lg font-semibold">Job log</h3>
		<p class="text-sm text-base-content/70">Status refreshes every 5 seconds while this page is visible.</p>
		<details class="text-sm">
			<summary class="cursor-pointer font-medium">Progress and cancellation help</summary>
			<div class="mt-2 space-y-2 text-base-content/70">
				<p>File totals can grow during collection. Checksum MiB are hashed on storage, not downloaded or read back. Recent activity alone does not prove a job has completed.</p>
				<p>Cancel stops one job; future schedules stay enabled. Pause &amp; cancel all also disables schedules. Reset cancellation aborts active SSH requests; other work stops at safety checks or its timeout. Wait for cancellation before changing credentials.</p>
			</div>
		</details>
		<div class="overflow-x-auto">
			<table class="table"><thead><tr><th>Job</th><th>Type</th><th>Status</th><th>Started (UTC)</th><th>Details</th><th>Actions</th></tr></thead><tbody>
			{#each data.status.jobs as job (job.id)}
				<tr><td>{job.id}</td><td>{job.kind}</td><td>{job.status}{#if job.status !== 'cancelled'} ({job.attempts}/8){/if}</td><td>{time(job.started_at || job.created_at)}</td><td>{#if job.progress}<p class="break-all">{job.progress}</p>{/if}{job.error || ''}{#if job.backupId}<span class="break-all">Recovery ID: {job.backupId}</span>{/if}{#if job.restoreDirectory}<p class="break-all font-mono">Verified copy ready: {job.restoreDirectory}</p><p>Live site unchanged. Manual activation required.</p>{/if}{#if job.status === 'failed' && job.attempts < 8} Retry: {time(job.retry_at)}{/if}{#if job.status === 'cancelling'} Stopping at the next safety check…{/if}</td><td class="whitespace-nowrap">{#if job.canCancel}<form method="POST" action="?/cancel&tab=overview" use:enhance class="inline-flex"><button class="btn btn-sm btn-outline min-w-max whitespace-nowrap" name="jobId" value={job.id}>Cancel</button></form>{/if}</td></tr>
			{/each}
			</tbody></table>
		</div>
{/snippet}

<style>
	[role='tabpanel'][hidden] {
		display: none;
	}
</style>
