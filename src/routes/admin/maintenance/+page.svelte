<script>
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	let pending = $state(false);
	let status = $derived(form?.status ?? data.status);
	let busy = $derived(pending || ['enabling', 'disabling'].includes(status.phase));
	let needsRetry = $derived(status.phase === 'error' || status.telegram === 'error' || !!status.error);
	const integrationLabels = {
		OPENAI_API_KEY: 'OpenAI API key',
		ELEVENLABS_API_KEY: 'ElevenLabs API key',
		GEMINI_API_KEY: 'Gemini API key',
		TELEGRAM_BOT_TOKEN: 'Telegram bot token',
		TELEGRAM_CHAT_ID: 'Telegram group chat ID',
		TELEGRAM_WEBHOOK_SECRET: 'Telegram webhook secret',
		TELEGRAM_WEBHOOK_BASE_URL: 'Telegram website URL'
	};
	let pendingRestoreLabels = $derived((data.pendingRestore?.fields ?? []).filter((key) => Object.hasOwn(integrationLabels, key)).map((key) => integrationLabels[key]));

	function enhanceChange() {
		pending = true;
		return async ({ update }) => {
			try {
				await update();
			} finally {
				pending = false;
			}
		};
	}
</script>

<section class="w-full min-w-0 max-w-3xl space-y-4">
	<h1 class="text-2xl font-semibold">Site maintenance</h1>
	<p>Close the website for updates while keeping administrator login and access available. Other visitors see a friendly updating page.</p>
	{#if form?.error}<div class="alert alert-error" role="alert">{form.error}</div>{/if}
	{#if form?.message}<div class="alert alert-success" role="status">{form.message}</div>{/if}
	{#if data.pendingRestore?.pending}
		<div class="alert alert-warning" role="status"><div>
			<p>Selected integration settings are waiting for reopening below. First the original Telegram group permissions are restored, then the selected settings apply. Current settings remain active until then; unselected fields stay unchanged.</p>
			{#if data.pendingRestore.error}<p>Pending restore details are unavailable. Check the server encryption configuration before retrying.</p>
			{:else if pendingRestoreLabels.length}<p>Waiting settings: {pendingRestoreLabels.join(', ')}.</p>{/if}
			<p>Complete Telegram settings automatically register the webhook. If applying settings or registration fails, maintenance stays enabled and the restore stays pending; correct the problem and retry reopening.</p>
		</div></div>
		<form method="POST" action="?/discardIntegrationRestore" use:enhance={enhanceChange} class="card space-y-4 border bg-base-100 p-4">
			<fieldset disabled={busy} class="space-y-4">
				<legend class="text-lg font-semibold">Discard pending credential restore</legend>
				<p class="text-sm">Use this if invalid or expired backup credentials prevent reopening. This removes only the pending restore retry; it does not undo credentials already applied and leaves maintenance enabled. Then explicitly reopen the website below. After reopening, check, register or fix Telegram in Admin → Integrations if necessary.</p>
				<label class="form-control">
					<span class="label-text">Type DISCARD CREDENTIAL RESTORE exactly</span>
					<input name="confirmation" class="input input-bordered w-full" required pattern="DISCARD CREDENTIAL RESTORE" autocomplete="off" spellcheck="false" />
				</label>
				<label class="flex items-start gap-3">
					<input type="checkbox" name="acknowledgement" value="on" class="checkbox shrink-0" required />
					<span>I understand this removes only the pending retry, does not undo credentials already applied, and leaves maintenance enabled.</span>
				</label>
				<button type="submit" class="btn btn-warning">Discard pending credential restore</button>
			</fieldset>
		</form>
	{/if}
	<div class="card border bg-base-100 p-4" aria-live="polite">
		<dl class="space-y-2">
			<div><dt class="font-semibold">Website</dt><dd>{status.enabled ? 'Closed for maintenance' : 'Open'}</dd></div>
			<div><dt class="font-semibold">Maintenance phase</dt><dd>{status.phase}</dd></div>
			<div><dt class="font-semibold">Telegram group</dt><dd>{status.telegram === 'disabled' ? 'Not configured' : status.telegram}</dd></div>
			{#if status.updatedAt}<div><dt class="font-semibold">Last updated</dt><dd>{status.updatedAt}</dd></div>{/if}
		</dl>
	</div>
	{#if needsRetry}
		<div class="alert alert-warning" role="alert">The website may remain closed if Telegram lock or unlock fails. Correct the bot permissions, then retry the intended operation below. The bot must be a group administrator with permission to restrict members.</div>
	{/if}
	<ul class="list-disc space-y-2 pl-5 text-sm">
		<li>Maintenance pauses new Telegram processing and normal background tasks. Existing tasks may finish; explicit restore preparation and storage connection tests remain available.</li>
		<li>The configured Telegram group is locked for ordinary members; group administrators can still post. Original group permissions are saved and restored, not blanket enabled.</li>
		<li>Private-chat messages receive an updating notice and are ignored, not queued. Users must resend them after reopening.</li>
		<li>A stopped container cannot send bot replies. The group lock remains in Telegram while the container is stopped.</li>
		<li>Manual maintenance is persisted outside the database and remains on after restore until an administrator turns it off. Restore activation enables maintenance automatically.</li>
		<li>Unconfirmed or offline startup temporarily blocks everyone until startup is confirmed.</li>
	</ul>
	{#each [true, false] as enabled (enabled)}
		{@const confirmation = enabled ? 'ENABLE MAINTENANCE' : 'DISABLE MAINTENANCE'}
		<form method="POST" action={enabled ? '?/enable' : '?/disable'} use:enhance={enhanceChange} class="card space-y-4 border bg-base-100 p-4">
			<fieldset disabled={busy} class="space-y-4">
				<legend class="text-lg font-semibold">{enabled ? 'Enable maintenance' : 'Reopen the website'}</legend>
				<label class="form-control">
					<span class="label-text">Type {confirmation} exactly</span>
					<input name="confirmation" class="input input-bordered w-full" required autocomplete="off" spellcheck="false" />
				</label>
				<label class="flex items-start gap-3">
					<input type="checkbox" name="acknowledgement" class="checkbox shrink-0" required />
					<span>{enabled ? 'I understand this closes the website, pauses new processing and locks ordinary Telegram group members when configured.' : 'I confirm reopening the website, resuming processing and restoring the original Telegram group permissions when configured.'}</span>
				</label>
				<button type="submit" class={enabled ? 'btn btn-warning' : 'btn btn-primary'}>{needsRetry ? 'Retry: ' : ''}{enabled ? 'Enable maintenance' : 'Disable maintenance & reopen'}</button>
			</fieldset>
		</form>
	{/each}
	{#if busy}<p role="status">Updating maintenance. Wait for the operation to finish, then reload for the current status.</p>{/if}
</section>
