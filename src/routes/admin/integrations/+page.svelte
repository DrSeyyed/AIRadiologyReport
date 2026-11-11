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

<section class="w-full min-w-0 max-w-3xl space-y-4">
	<h1 class="text-2xl font-semibold">Integrations</h1>
	<p class="text-sm">Manage provider keys and Telegram settings. Saved settings are encrypted. Secrets stay masked and are never shown here; blank secret fields keep existing values.</p>
	<p class="text-sm">Settings are stored separately from restored databases in <code>config/settings.json</code> (the private <code>/app/config</code> volume in Docker). Restore activation keeps current settings unless individual fields are explicitly selected; selected fields apply only when an administrator reopens maintenance after original Telegram group permissions are restored. Preserve this private configuration volume and the original server-side <code>STORAGE_ENCRYPTION_KEY</code> across deployments and restores. This master key must match the backup and is never restored or managed here.</p>
	{#if data.pendingRestore?.pending}
		<div class="alert alert-warning" role="status"><div>
			<p>Selected integration settings are waiting for reopening in Admin → Maintenance, after the original Telegram group permissions are restored. Current settings remain active until then.</p>
			{#if data.pendingRestore.error}<p>Pending restore details are unavailable. Check the server encryption configuration before retrying.</p>
			{:else if pendingRestoreLabels.length}<p>Waiting settings: {pendingRestoreLabels.join(', ')}.</p>{/if}
			<p>Provider keys remain editable, but the pending restore will replace selected fields on reopening. Unselected fields remain unchanged.</p>
			<p>Complete Telegram settings automatically register the webhook. If applying settings or registration fails, maintenance stays enabled and the restore stays pending; correct the problem and retry reopening.</p>
		</div></div>
	{/if}
	{#if !data.settings.encryptionConfigured}
		<div class="alert alert-warning" role="alert">Server encryption is not configured. Configure STORAGE_ENCRYPTION_KEY on the server before saving integration settings.</div>
	{/if}
	{#if form?.error}<div class="alert alert-error" role="alert">{form.error}</div>{/if}
	{#if form?.message}<div class="alert alert-success" role="status">{form.message}</div>
	{:else if form?.success}<div class="alert alert-success" role="status">Operation completed.</div>{/if}
	{#if form?.webhookError}<div class="alert alert-warning" role="alert">{form.webhookError}</div>{/if}

	{#if Object.values(fields).some((field) => field.source === 'environment' && field.configured)}
		<form method="POST" action="?/importEnvironment" use:enhance={enhanceSettings} class="card border bg-base-100 p-4">
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
	{/if}

	<form method="POST" action="?/saveProviders" use:enhance={enhanceSettings} class="card border bg-base-100 p-4">
		<fieldset disabled={pending || !data.settings.encryptionConfigured} class="min-w-0 space-y-4">
			<legend class="text-lg font-semibold">AI providers</legend>
			<p id="provider-help" class="text-sm">Leave a key blank to keep it. Clear explicitly disables that provider, including its legacy environment fallback. Do not enter a replacement key and select Clear together.</p>
			{#each providers as provider (provider.key)}
				<div class="space-y-2">
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
			<button type="submit" class="btn btn-primary">Save provider keys</button>
		</fieldset>
	</form>

	{#if data.maintenanceEnabled}
		<div class="alert alert-warning" role="alert">Telegram changes and webhook registration or removal are unavailable during site maintenance. Provider keys remain editable.</div>
	{/if}
	<form method="POST" action="?/saveTelegram" use:enhance={enhanceSettings} class="card border bg-base-100 p-4">
		<fieldset disabled={telegramDisabled} class="min-w-0 space-y-4">
			<legend class="text-lg font-semibold">Telegram</legend>
			<div class="alert alert-warning" role="note">Before changing bots, remove the existing webhook below if the old bot is being retired. Clearing the website URL alone does not remove the remote webhook.</div>
			<label class="form-control min-w-0">
				<span class="label-text">Bot token</span>
				<span id="bot-status" class="mb-1 text-sm opacity-70">{status('TELEGRAM_BOT_TOKEN')}</span>
				<input type="password" name="TELEGRAM_BOT_TOKEN" class="input input-bordered w-full" autocomplete="new-password" spellcheck="false" aria-describedby="bot-status telegram-secret-help" />
			</label>
			<label class="form-control min-w-0">
				<span class="label-text">Emergency bot replacement confirmation (optional)</span>
				<input name="replaceBotConfirmation" placeholder="REPLACE BOT" class="input input-bordered w-full" autocomplete="off" spellcheck="false" aria-describedby="replace-bot-help" />
			</label>
			<p id="replace-bot-help" class="text-sm">Normally remove the old webhook first. Only type REPLACE BOT to replace an invalid or inaccessible old token when its webhook cannot be removed. This does not remove the old bot’s webhook; retire or revoke the old bot separately. Leave blank for initial configuration or same-token updates.</p>
			<label class="form-control min-w-0">
				<span class="label-text">Group chat ID</span>
				<span id="chat-status" class="mb-1 text-sm opacity-70">{status('TELEGRAM_CHAT_ID')}</span>
				<input name="TELEGRAM_CHAT_ID" value={fields.TELEGRAM_CHAT_ID.value ?? ''} class="input input-bordered w-full" autocomplete="off" spellcheck="false" aria-describedby="chat-status group-help" />
			</label>
			<p id="group-help" class="text-sm">For maintenance controls, the bot must be a group administrator with permission to restrict members.</p>
			<label class="form-control min-w-0">
				<span class="label-text">Website URL (public HTTPS origin)</span>
				<span id="url-status" class="mb-1 text-sm opacity-70">{status('TELEGRAM_WEBHOOK_BASE_URL')}</span>
				<input type="url" name="TELEGRAM_WEBHOOK_BASE_URL" value={fields.TELEGRAM_WEBHOOK_BASE_URL.value ?? ''} placeholder="https://pacs.example.com" class="input input-bordered w-full" autocomplete="off" spellcheck="false" aria-describedby="url-status webhook-help" />
			</label>
			<p id="webhook-help" class="text-sm">The website URL automatically creates <code>/api/telegram/webhook</code>. Saving a configured bot token and URL automatically registers message, edited-message and callback-query updates.</p>
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
			<button type="submit" class="btn btn-primary">Save Telegram settings</button>
		</fieldset>
	</form>

	<div class="card space-y-4 border bg-base-100 p-4">
		<h2 class="text-lg font-semibold">Webhook</h2>
		<dl class="space-y-2" aria-live="polite">
			<div><dt class="font-semibold">State</dt><dd>{data.webhook.state}</dd></div>
			{#if data.webhook.url}<div><dt class="font-semibold">URL</dt><dd class="break-all">{data.webhook.url}</dd></div>{/if}
		</dl>
		{#if data.webhook.error}<div class="alert alert-warning" role="alert">{data.webhook.error}</div>{/if}
		<form method="POST" action="?/registerWebhook" use:enhance={enhanceSettings}>
			<button type="submit" class="btn btn-primary" disabled={telegramDisabled}>Register / retry webhook</button>
		</form>
		<form method="POST" action="?/removeWebhook" use:enhance={enhanceSettings}>
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
	</div>
	{#if pending}<p role="status">Updating integration settings…</p>{/if}
</section>
