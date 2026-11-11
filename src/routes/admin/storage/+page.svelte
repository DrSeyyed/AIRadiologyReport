<script>
	import { enhance } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onMount, untrack } from 'svelte';
	let { data, form } = $props();
	const integrationLabels = {
		OPENAI_API_KEY: 'OpenAI API key',
		ELEVENLABS_API_KEY: 'ElevenLabs API key',
		GEMINI_API_KEY: 'Gemini API key',
		TELEGRAM_BOT_TOKEN: 'Telegram bot token',
		TELEGRAM_CHAT_ID: 'Telegram group chat ID',
		TELEGRAM_WEBHOOK_SECRET: 'Telegram webhook secret',
		TELEGRAM_WEBHOOK_BASE_URL: 'Telegram website URL'
	};
	let selectedIntegrationFields = $state({});
	let pendingIntegrationLabels = $derived((data.integrationRestore?.fields ?? []).filter((key) => Object.hasOwn(integrationLabels, key)).map((key) => integrationLabels[key]));
	function selectIntegrationField(restoreId, key, checked) {
		const selected = selectedIntegrationFields[restoreId] ?? [];
		selectedIntegrationFields[restoreId] = checked ? [...selected, key] : selected.filter((field) => field !== key);
	}
	function activationEnhance(restoreId) {
		return () => async ({ result, update }) => {
			await update();
			if (result.type === 'success') selectedIntegrationFields[restoreId] = [];
		};
	}
	const tabs = [
		{ id: 'overview', label: 'Overview & jobs' },
		{ id: 'settings', label: 'Settings' },
		{ id: 'restore', label: 'Backups & restore' },
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
	let recoveryPoints = $state(untrack(() => form?.recoveryPoints || []));
	function recoveryEnhance() {
		return async ({ result, update }) => {
			if (result.type === 'success' && Array.isArray(result.data?.recoveryPoints))
				recoveryPoints = result.data.recoveryPoints;
			await update();
		};
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
	function restoreAudioLabel(mode) {
		return mode === 'remote' ? 'Keep archived audio on storage' : 'Download all audio';
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
	{#if form?.activationQueued}<p role="status">Activation is queued. Wait for the restart, then <a class="link" href={resolve('/admin/storage?tab=restore')}>reload this page</a>.</p>{/if}
	{#if data.integrationRestore?.pending}
		<div class="alert alert-warning" role="status"><div>
			<p>Selected integration settings are waiting for an administrator to reopen the website in <a class="link" href={resolve('/admin/maintenance')}>Admin → Maintenance</a>, after the original Telegram group permissions are restored. Current settings remain active until then.</p>
			{#if data.integrationRestore.error}<p>Pending restore details are unavailable. Check the server encryption configuration before retrying.</p>
			{:else if pendingIntegrationLabels.length}<p>Waiting settings: {pendingIntegrationLabels.join(', ')}.</p>{/if}
			<p>Complete Telegram settings automatically register the webhook. If applying settings or registration fails, maintenance stays enabled and the restore stays pending; correct the problem and retry reopening.</p>
		</div></div>
	{/if}
	{#if data.activation?.state && data.activation.state !== 'idle'}
		<div class="alert alert-info" role="status"><div>Last restore activation: {data.activation.state}{#if data.activation.id} — {data.activation.id}{/if}.{#if data.activation.rollbackDirectory}<p>Private rollback copy: <code class="break-all">{data.activation.rollbackDirectory}</code>. Keep it until the restored site has been tested.</p>{/if}{#if data.activation.error}<p>{data.activation.error}</p>{/if}</div></div>
	{/if}
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
			<p>Parallel storage connections: 1–16, default 4. Applies to independent file transfers and checks in synchronization, backups, restores, audits and maintenance. Connection tests probe every configured session. Database checks, publication and ordering-dependent cleanup stay serial; jobs still run one at a time. More workers use more memory, temporary space and SSH slots. Respect your storage server's limits.</p>
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
		<form method="POST" action="?/audit&tab=overview" use:enhance class="space-y-2">
			<button class="btn btn-outline" name="confirmation" value="audit" disabled={data.status.resetActive || !data.keyConfigured || !data.passwordConfigured}>Run full checksum audit</button>
			<p class="text-sm text-base-content/70">Hash all tracked encrypted files, protected backup copies and legacy audio on storage, even if recently checked. No downloads. Shows progress, checksum MiB and elapsed time; cancellable in the job log. Works while schedules are paused.</p>
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
		<p class="text-sm">Prepare a verified copy in a separate server folder. <strong>Preparation does not replace the live site.</strong> Then explicitly activate a verified copy below to preserve rollback data, replace the site and restart automatically.</p>
		<details class="text-sm">
			<summary class="cursor-pointer font-medium">Restore requirements and activation</summary>
			<p class="mt-2 text-base-content/70">Allow disk space for locally restored files and temporary downloads; downloading all audio requires space for the full dataset. Keeping archived audio on storage is not a self-contained copy: after activation, playback requires the saved matching storage destination and original encryption key. Only audio whose hash and size match authenticated snapshot archive metadata can remain remote; other files restore locally. Retained audio is checksum-verified at the original archive paths, not just in backup objects. Missing or mismatching archives fail preparation; choose download mode instead. Legacy mixed bundles may still transfer archived audio bytes when needed for the database or other local files; audio-only bundles are skipped. Storage services start paused in either mode. Original storage objects are kept. Protect prepared copies like patient data and remove them manually when no longer needed. Preparation works while schedules are paused. Independent downloads, decryption and verification use the saved parallel connection limit. Follow the README recovery procedure; never merge restored DB/WAL files with the live database.</p>
		</details>
		<form method="POST" action="?/recoveryPoints&tab=restore" use:enhance={recoveryEnhance}>
			<button class="btn btn-outline" disabled={data.status.resetActive || !data.keyConfigured || !data.passwordConfigured}>Load recovery points from storage</button>
		</form>
		{#if recoveryPoints.length}
			<form method="POST" action="?/restore&tab=restore" use:enhance class="space-y-3">
				<fieldset disabled={data.status.resetActive} class="contents">
				<label class="form-control">Completed recovery point
					<select class="select select-bordered font-mono" name="backupId" required>
						<option value="">Select a backup</option>
						{#each recoveryPoints as point (point.id)}
							<option value={point.id}>{point.kind === 'full' ? 'Full backup' : 'Legacy recovery snapshot'} — {time(Number(point.id.split('-')[0]))} — {point.id}</option>
						{/each}
					</select>
				</label>
				<label class="form-control">Restore audio
					<select class="select select-bordered" name="audioMode" required aria-describedby="restore-audio-help">
						<option value="remote" selected>Keep archived audio on storage (less local disk)</option>
						<option value="download">Download all audio (independent copy)</option>
					</select>
				</label>
				<p id="restore-audio-help" class="text-sm text-base-content/70">Keeping archived audio remote is not self-contained: playback after activation needs the saved matching storage destination, original archive paths and original encryption key. Other files restore locally. Downloading all audio needs full disk space and is the offline restore default.</p>
				<label class="flex items-center gap-3"><input class="checkbox" type="checkbox" name="confirmation" value="prepare" required /> I understand this creates a separate recovery copy, not an automatic live restore.</label>
				<button class="btn btn-warning" type="submit" disabled={data.status.resetActive}>Prepare restore</button>
				</fieldset>
			</form>
		{/if}
		{@render backupDeletion()}
		{#if data.status.preparedRestores.length}
			<h4 class="font-semibold">Recent verified copies</h4>
			{#if !data.activation?.supported}
				<p class="text-sm text-warning">Automatic activation requires the updated Docker startup supervisor and persistent restore-staging and voice mounts. External VOICE_SAVE_DIR locations require manual activation. Preparing a copy alone never changes the live site.</p>
			{/if}
			{#each data.status.preparedRestores as restore (restore.id)}
				<div class="space-y-3 border-t border-base-300 pt-3">
				<p>Job {restore.id} — {time(restore.finished_at)}: <code class="break-all">{restore.directory}</code> — {restoreAudioLabel(restore.audioMode)}{#if restore.remoteAudioFiles !== undefined}; audio files kept remote: {restore.remoteAudioFiles}{/if}{#if restore.audioMode === 'remote'} (not self-contained; matching storage and original key required){/if}</p>
				<details class="space-y-3">
					<summary class="cursor-pointer font-semibold text-error">Activate this restore and restart</summary>
					<p class="text-sm">This replaces the live database and local files, discarding changes made after this backup. The site will be briefly unavailable. Current data is preserved as a private rollback copy before replacement. Keep enough disk space for that copy and the replacement. If installation or startup validation fails, the previous data is restored. Keep the original storage encryption key; remote audio still needs the matching storage. Activation enables site maintenance and locks configured Telegram group posting (the bot needs administrator restriction permissions). Maintenance stays enabled after restart or rollback. You may need to sign in using an administrator account from the backup; test the restored site, then explicitly reopen it in Admin → Maintenance. Storage schedules remain paused separately.</p>
					<form method="POST" action="?/activateRestore&tab=restore" use:enhance={activationEnhance(restore.id)} class="space-y-3">
						<fieldset disabled={!data.activation?.supported || form?.activationQueued || data.activation?.maintenance || data.status.resetActive} class="space-y-3">
							<input type="hidden" name="jobId" value={restore.id} />
							<fieldset disabled={restore.integrationUnavailable} class="space-y-3 rounded border border-base-300 p-3">
								<legend class="font-semibold">Integration settings from this backup (optional)</legend>
								<p class="text-sm">All checkboxes start unchecked: keep current settings. Select only settings to restore. Selecting an empty backup field explicitly disables that current setting; unchecked fields never change.</p>
								{#if restore.integrationUnavailable}
									<p class="text-sm text-warning" role="alert">The encrypted integration snapshot could not be read. Credential selection is unavailable; clinical data can still be restored while keeping current credentials.</p>
								{:else if !restore.integrationFields?.length}
									<p class="text-sm">This older backup has no integration snapshot. Clinical data can still be restored; current credentials are retained.</p>
								{:else}
									{#each restore.integrationFields.filter((field) => Object.hasOwn(integrationLabels, field.key)) as descriptor (descriptor.key)}
										<label class="flex items-start gap-3">
											<input class="checkbox shrink-0" type="checkbox" name="integrationField" value={descriptor.key} checked={(selectedIntegrationFields[restore.id] ?? []).includes(descriptor.key)} onchange={(event) => selectIntegrationField(restore.id, descriptor.key, event.currentTarget.checked)} />
											<span>{descriptor.label} — {descriptor.configured ? 'Configured in backup' : 'Empty in backup (disables current setting if selected)'}</span>
										</label>
									{/each}
									<label class="form-control">Type RESTORE CREDENTIALS only if selecting settings<input class="input input-bordered" name="integrationConfirmation" autocomplete="off" spellcheck="false" required={!restore.integrationUnavailable && !!selectedIntegrationFields[restore.id]?.length} pattern="RESTORE CREDENTIALS" /></label>
								{/if}
							</fieldset>
							<p class="text-sm">Selected settings do not apply during restore or activation. They apply only when an administrator explicitly reopens the website in Admin → Maintenance, after the original Telegram group permissions are restored. Complete Telegram settings automatically register the webhook. Application or registration failures leave maintenance enabled and the restore pending; correct the problem and retry reopening.</p>
							<p class="text-sm">Restoring a different bot while keeping the current webhook secret may require removing the old bot's webhook separately. Unchecked fields are never changed automatically. The original master encryption key stays server-side and must match the backup; it cannot be selected or restored here.</p>
							<label class="form-control">Type ACTIVATE RESTORE to confirm<input class="input input-bordered" name="confirmation" autocomplete="off" required /></label>
							<label class="flex items-start gap-3"><input class="checkbox shrink-0" type="checkbox" name="acknowledgement" required /> I approve replacing the live site with this backup and automatically restarting, and have enough free disk for rollback.</label>
							<button class="btn btn-error" type="submit">Activate restore &amp; restart</button>
						</fieldset>
					</form>
				</details>
				</div>
			{/each}
		{/if}
		{@render jobLog('restore', ['restore', 'delete'])}
	</div>
	<div id="storage-panel-maintenance" role="tabpanel" aria-labelledby="storage-tab-maintenance" tabindex="0" hidden={activeTab !== 'maintenance'} class="card space-y-4 bg-base-100 p-6 shadow">
		<h3 class="text-lg font-semibold">Storage maintenance</h3>
		<p class="text-sm text-base-content/70">Backup deletion is beside the recovery-point list in Backups &amp; restore.</p>
		<a class="btn btn-outline w-fit" href={resolve('/admin/storage?tab=restore')} onclick={(event) => tabClick(event, 'restore')}>Delete backups</a>
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

{#snippet backupDeletion()}
	<div class="space-y-3 border-t border-base-300 pt-4">
		<h4 class="font-semibold">Delete selected recovery points</h4>
		<p class="text-sm text-base-content/70">Permanently removes selected backup indexes and manifests, including the newest if selected. Shared file objects and live data stay intact, so this may reclaim little space.</p>
		{#if !recoveryPoints.length}<p class="text-sm">Load recovery points above to select backups. The delete button becomes available after loading a non-empty list.</p>{/if}
		<form method="POST" action="?/deleteBackups&tab=restore" use:enhance={recoveryEnhance} class="space-y-3">
			<fieldset disabled={data.status.resetActive || !recoveryPoints.length} class="space-y-3">
				<legend class="font-medium">Select recovery points (up to 100)</legend>
				{#if recoveryPoints.length}
					<div class="max-h-64 space-y-2 overflow-y-auto rounded border border-base-300 p-3">
						{#each recoveryPoints as point (point.id)}
							<label class="flex items-start gap-3 break-all"><input class="checkbox shrink-0" type="checkbox" name="backupIds" value={point.id} /><span>{point.kind === 'full' ? 'Full backup' : 'Legacy snapshot'} — {time(Number(point.id.split('-')[0]))}<br /><span class="font-mono text-xs">{point.id}</span></span></label>
						{/each}
					</div>
				{/if}
				<label class="form-control">Type DELETE BACKUPS to confirm<input class="input input-bordered" name="confirmation" autocomplete="off" required /></label>
				<label class="flex items-center gap-3"><input class="checkbox" type="checkbox" name="acknowledge" required /> I understand that selected recovery points are permanently lost, even if they are the newest or only backups.</label>
				<button class="btn btn-error" type="submit" disabled={data.status.resetActive || !recoveryPoints.length}>Delete selected backups</button>
			</fieldset>
		</form>
		<p class="text-sm text-base-content/70">Deletion progress and cancellation appear below. Cancelling cannot undo completed deletions. Reload the list afterward. Restore preparation must finish or be cancelled first.</p>
	</div>
{/snippet}

{#snippet jobLog(tab = 'overview', kinds = null)}
		<h3 class="text-lg font-semibold">{tab === 'restore' ? 'Restore & backup deletion job log' : 'Job log'}</h3>
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
			{#each data.status.jobs.filter((job) => !kinds || kinds.includes(job.kind)) as job (job.id)}
				<tr><td>{job.id}</td><td>{job.kind}</td><td>{job.status}{#if job.status !== 'cancelled'} ({job.attempts}/8){/if}</td><td>{time(job.started_at || job.created_at)}</td><td>{#if job.kind === 'restore'}<p>{restoreAudioLabel(job.audioMode)}{#if job.remoteAudioFiles !== undefined}; audio files kept remote: {job.remoteAudioFiles}{/if}{#if job.audioMode === 'remote'} (not self-contained; matching storage and original key required){/if}</p>{/if}{#if job.progress}<p class="break-all">{job.progress}</p>{/if}{job.error || ''}{#if job.backupId}<span class="break-all">Recovery ID: {job.backupId}</span>{/if}{#if job.restoreDirectory}<p class="break-all font-mono">Verified copy ready: {job.restoreDirectory}</p><p>Preparation left the live site unchanged. Activate this copy from Recent verified copies when ready.</p>{/if}{#if job.status === 'failed' && job.attempts < 8} Retry: {time(job.retry_at)}{/if}{#if job.status === 'cancelling'} Stopping at the next safety check…{/if}</td><td class="whitespace-nowrap">{#if job.canCancel}<form method="POST" action={`?/cancel&tab=${tab}`} use:enhance class="inline-flex"><button class="btn btn-sm btn-outline min-w-max whitespace-nowrap" name="jobId" value={job.id}>Cancel</button></form>{/if}</td></tr>
			{:else}
				<tr><td colspan="6">No {tab === 'restore' ? 'restore or backup deletion ' : ''}jobs in the recent log.</td></tr>
			{/each}
			</tbody></table>
		</div>
{/snippet}

<style>
	[role='tabpanel'][hidden] {
		display: none;
	}
</style>
