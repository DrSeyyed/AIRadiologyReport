<script>
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	let pending = $state(false);
	let rotateWebhookSecret = $state(false);
	let hasWebhookSecret = $state(false);
	let fields = $derived(data.settings.fields);
	let telegramDisabled = $derived(pending || data.maintenanceEnabled || !data.settings.encryptionConfigured);

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

	const providers = [
		{ key: 'OPENAI_API_KEY', label: 'OpenAI API key' },
		{ key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API key' },
		{ key: 'GEMINI_API_KEY', label: 'Gemini API key' }
	];

	function status(key) {
		const field = fields[key];
		const source = { admin: 'administrator settings', environment: 'legacy environment', unset: 'unset' };
		return `${field.configured ? 'Configured' : 'Not configured'} · ${source[field.source]}`;
	}

	function enhanceSettings({ formElement }) {
		pending = true;
		return async ({ update }) => {
			try {
				await update();
			} finally {
				for (const input of formElement.querySelectorAll('input[type="password"]')) input.value = '';
				hasWebhookSecret = false;
				rotateWebhookSecret = false;
				pending = false;
			}
		};
	}
</script>

<section class="w-full min-w-0 max-w-5xl space-y-6">
	<h1 class="page-title">Integrations</h1>
	<p class="text-sm">Manage encrypted provider keys and Telegram settings. Secrets are never displayed; blank secret fields keep existing values.</p>

	{#if data.pendingRestore?.pending}
		<div class="alert alert-warning" role="status"><div>
			<p class="font-semibold">Credential restore pending</p>
			<p>Selected settings apply when you reopen in Admin → Maintenance. Current settings remain active until then.</p>
			{#if data.pendingRestore.error}<p>Pending restore details are unavailable. Check the server encryption configuration before retrying.</p>
			{:else if pendingRestoreLabels.length}<p>Waiting settings: {pendingRestoreLabels.join(', ')}.</p>{/if}
			<p>Provider keys remain editable, but the pending restore will replace selected fields on reopening. Unselected fields remain unchanged.</p>
			<details class="mt-2 text-sm">
				<summary class="cursor-pointer font-medium">Restore order and recovery</summary>
				<p class="mt-2">Original Telegram group permissions are restored first. Complete Telegram settings automatically register the webhook. If applying settings or registration fails, maintenance stays enabled and the restore stays pending; correct the problem and retry reopening.</p>
			</details>
		</div></div>
	{/if}
	{#if !data.settings.encryptionConfigured}
		<div class="alert alert-warning" role="alert">Server encryption is not configured. Configure STORAGE_ENCRYPTION_KEY on the server before saving integration settings.</div>
	{/if}
	{#if form?.error}<div class="alert alert-error" role="alert">{form.error}</div>{/if}
	{#if form?.message}<div class="alert alert-success" role="status">{form.message}</div>
	{:else if form?.success}<div class="alert alert-success" role="status">Operation completed.</div>{/if}
	{#if form?.webhookError}<div class="alert alert-warning" role="alert">{form.webhookError}</div>{/if}


	<section aria-labelledby="integration-providers-heading" class="space-y-3">
	<h2 id="integration-providers-heading" class="section-title">AI providers</h2>
	<form method="POST" action="?/saveProviders" use:enhance={enhanceSettings} class="card border bg-base-100 p-4">
		<fieldset disabled={pending || !data.settings.encryptionConfigured} class="min-w-0 space-y-4">
			<legend class="sr-only">Provider keys</legend>
			<p id="provider-help" class="text-sm">Blank keeps the saved key. Clear disables the provider and its legacy fallback; do not also enter a replacement.</p>
			<div class="grid gap-4 md:grid-cols-3">
			{#each providers as provider (provider.key)}
				<div class="rounded-box space-y-2 border border-base-300 p-3">
					<label class="form-control min-w-0">
						<span class="label-text">{provider.label}</span>
						<span id={`${provider.key}-status`} class="mb-1 text-sm opacity-70">{status(provider.key)}</span>
						<input type="password" name={provider.key} class="input input-bordered w-full" autocomplete="new-password" spellcheck="false" aria-describedby={`${provider.key}-status provider-help`} />
					</label>
					<label class="flex items-center gap-3">
						<input type="checkbox" name={`clear_${provider.key}`} class="checkbox shrink-0" />
						<span class="text-sm">Clear {provider.label}</span>
					</label>
				</div>
			{/each}
			</div>
			<button type="submit" class="btn btn-primary">Save provider keys</button>
		</fieldset>
	</form>

	</section>
	<section aria-labelledby="integration-telegram-heading" class="space-y-3">
	<h2 id="integration-telegram-heading" class="section-title">Telegram</h2>
	{#if data.maintenanceEnabled}
		<div class="alert alert-warning" role="alert">Telegram changes and webhook registration or removal are unavailable during site maintenance. Provider keys remain editable.</div>
	{/if}
	<div class="grid items-start gap-4 lg:grid-cols-3">
	<form method="POST" action="?/saveTelegram" use:enhance={enhanceSettings} class="card border bg-base-100 p-4 lg:col-span-2">
		<fieldset disabled={telegramDisabled} class="min-w-0 space-y-4">
			<legend class="text-lg font-semibold">Bot &amp; connection</legend>
			<p class="text-sm">Saving a configured bot and website URL automatically registers the webhook.</p>
			<div class="rounded-box border border-warning p-3 text-sm" role="note">Retiring a bot? Remove its webhook below before changing tokens. Clearing the website URL does not remove the remote webhook.</div>
			<label class="form-control min-w-0">
				<span class="label-text">Bot token</span>
				<span id="bot-status" class="mb-1 text-sm opacity-70">{status('TELEGRAM_BOT_TOKEN')}</span>
				<input type="password" name="TELEGRAM_BOT_TOKEN" class="input input-bordered w-full" autocomplete="new-password" spellcheck="false" aria-describedby="bot-status telegram-secret-help" />
			</label>
			<details class="rounded-box border border-base-300 p-3">
				<summary class="cursor-pointer font-medium">Emergency bot replacement</summary>
			<label class="form-control mt-3 min-w-0">
				<span class="label-text">Emergency bot replacement confirmation (optional)</span>
				<input name="replaceBotConfirmation" placeholder="REPLACE BOT" class="input input-bordered w-full" autocomplete="off" spellcheck="false" aria-describedby="replace-bot-help" />
			</label>
			<p id="replace-bot-help" class="mt-2 text-sm">Only type REPLACE BOT if the old token is invalid or inaccessible and its webhook cannot be removed. This does not remove the old webhook; retire or revoke that bot separately. Leave blank for initial configuration or same-token updates.</p>
			</details>
			<label class="form-control min-w-0">
				<span class="label-text">Group chat ID</span>
				<span id="chat-status" class="mb-1 text-sm opacity-70">{status('TELEGRAM_CHAT_ID')}</span>
				<input name="TELEGRAM_CHAT_ID" value={fields.TELEGRAM_CHAT_ID.value ?? ''} class="input input-bordered w-full" autocomplete="off" spellcheck="false" aria-describedby="chat-status group-help" />
			</label>
			<p id="group-help" class="text-sm">For maintenance controls, the bot must be a group administrator with permission to restrict members.</p>
			<section aria-labelledby="integration-endpoint-heading" class="space-y-4 border-t border-base-300 pt-4">
			<h3 id="integration-endpoint-heading" class="section-title">Webhook endpoint &amp; authentication</h3>
			<label class="form-control min-w-0">
				<span class="label-text">Website URL (public HTTPS origin)</span>
				<span id="url-status" class="mb-1 text-sm opacity-70">{status('TELEGRAM_WEBHOOK_BASE_URL')}</span>
				<input type="url" name="TELEGRAM_WEBHOOK_BASE_URL" value={fields.TELEGRAM_WEBHOOK_BASE_URL.value ?? ''} placeholder="https://pacs.example.com" class="input input-bordered w-full" autocomplete="off" spellcheck="false" aria-describedby="url-status webhook-help" />
			</label>
			<details class="text-sm">
				<summary class="cursor-pointer font-medium">Webhook URL and update types</summary>
				<p id="webhook-help" class="mt-2">The website URL creates <code>/api/telegram/webhook</code>. Registration includes message, edited-message and callback-query updates.</p>
			</details>
			<label class="form-control min-w-0">
				<span class="label-text">Webhook secret</span>
				<span id="secret-status" class="mb-1 text-sm opacity-70">{status('TELEGRAM_WEBHOOK_SECRET')}</span>
				<input type="password" name="TELEGRAM_WEBHOOK_SECRET" disabled={rotateWebhookSecret} oninput={(event) => hasWebhookSecret = event.currentTarget.value.length > 0} class="input input-bordered w-full" autocomplete="new-password" spellcheck="false" aria-describedby="secret-status telegram-secret-help" />
			</label>
			<p id="telegram-secret-help" class="text-sm">Blank token or secret keeps the existing value. A random webhook secret is generated if needed. Choose either a new secret or rotation, not both.</p>
			<label class="flex items-center gap-3">
				<input type="checkbox" name="rotateWebhookSecret" bind:checked={rotateWebhookSecret} disabled={hasWebhookSecret} class="checkbox shrink-0" />
				<span class="text-sm">Generate a new random webhook secret</span>
			</label>
			</section>
			<button type="submit" class="btn btn-primary">Save Telegram settings</button>
		</fieldset>
	</form>

	<section aria-labelledby="integration-webhook-heading" class="card space-y-4 border bg-base-100 p-4">
		<h3 id="integration-webhook-heading" class="section-title">Webhook status</h3>
		<dl class="space-y-2" aria-live="polite">
			<div><dt class="font-semibold">State</dt><dd>{data.webhook.state}</dd></div>
			{#if data.webhook.url}<div><dt class="font-semibold">URL</dt><dd class="break-all">{data.webhook.url}</dd></div>{/if}
		</dl>
		{#if data.webhook.error}<div class="alert alert-warning" role="alert">{data.webhook.error}</div>{/if}
		<form method="POST" action="?/registerWebhook" use:enhance={enhanceSettings}>
			<button type="submit" class="btn btn-primary" disabled={telegramDisabled}>Register / retry webhook</button>
		</form>
		<details class="border-t border-base-300 pt-4">
			<summary class="cursor-pointer font-medium">Remove current bot webhook</summary>
		<form method="POST" action="?/removeWebhook" use:enhance={enhanceSettings} class="mt-4">
			<fieldset disabled={telegramDisabled} class="space-y-4">
				<legend class="font-semibold">Remove current bot webhook</legend>
				<p class="text-sm">Removes the remote webhook without dropping pending updates. Registration can be retried above.</p>
				<label class="form-control min-w-0">
					<span class="label-text">Type REMOVE WEBHOOK exactly</span>
					<input name="confirmation" required pattern="REMOVE WEBHOOK" class="input input-bordered w-full" autocomplete="off" spellcheck="false" />
				</label>
				<button type="submit" class="btn btn-warning">Remove webhook</button>
			</fieldset>
		</form>
		</details>
	</section>
	</div>
	</section>
	{#if pending}<p role="status">Updating integration settings…</p>{/if}
	<section aria-labelledby="integration-guidance-heading" class="space-y-3 border-t border-base-300 pt-4">
	<h2 id="integration-guidance-heading" class="section-title">Configuration &amp; recovery guidance</h2>
	<details class="rounded-box border bg-base-100 p-4 text-sm">
		<summary class="cursor-pointer font-medium">Private settings and restore behavior</summary>
		<p class="mt-3">Settings are stored separately from restored databases in <code>config/settings.json</code> (the private <code>/app/config</code> volume in Docker). Restore activation keeps current settings unless individual fields are explicitly selected; selected fields apply only when an administrator reopens maintenance after original Telegram group permissions are restored. Preserve this private configuration volume and the original server-side <code>STORAGE_ENCRYPTION_KEY</code> across deployments and restores. This master key must match the backup and is never restored or managed here.</p>
	</details>
	{#if Object.values(fields).some((field) => field.source === 'environment' && field.configured)}
		<details class="rounded-box border bg-base-100 p-4">
			<summary class="cursor-pointer font-medium">Import legacy environment settings</summary>
		<form method="POST" action="?/importEnvironment" use:enhance={enhanceSettings} class="mt-4">
			<fieldset disabled={telegramDisabled} class="min-w-0 space-y-4">
				<legend class="text-lg font-semibold">Import legacy environment settings</legend>
				<p class="text-sm">Copy configured legacy environment credentials into encrypted administrator settings without retyping or displaying secrets. After a successful import, legacy API environment variables can be removed.</p>
				{#if data.maintenanceEnabled}<p class="text-sm">Import is unavailable during site maintenance.</p>{/if}
				<label class="form-control min-w-0">
					<span class="label-text">Type IMPORT SETTINGS exactly</span>
					<input name="confirmation" required pattern="IMPORT SETTINGS" class="input input-bordered w-full" autocomplete="off" spellcheck="false" />
				</label>
				<button type="submit" class="btn btn-primary">Import environment settings</button>
			</fieldset>
		</form>
		</details>
	{/if}

	</section>
</section>
