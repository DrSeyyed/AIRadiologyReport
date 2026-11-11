import { error, fail, redirect } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { getDb } from './db.js';
import { readIntegrationSettings, resolveIntegrationSettings, saveIntegrationSettings, applyIntegrationSettings } from './integration-settings.js';
import { siteMaintenanceStatus } from './site-maintenance.js';
import { withIntegrationConfigurationLock } from './integration-coordination.js';
import { createWebhookRegistration } from './integration-webhook.js';
import { pendingRestoreMetadata } from './integration-restore-admin.js';

const PROVIDERS = ['OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'GEMINI_API_KEY'];
const TELEGRAM = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_WEBHOOK_BASE_URL', 'TELEGRAM_WEBHOOK_SECRET'];
const SAVE_ERROR = 'Unable to save integration settings. Check the values and the server STORAGE_ENCRYPTION_KEY; no secret values are displayed.';
const WEBHOOK_ERROR = 'Telegram webhook setup failed. The saved settings are retained. Check the bot token and public HTTPS website, then retry registration.';
class ActionError extends Error {
	constructor(status, message) { super(message); this.status = status; }
}
function requireAdmin(locals) {
	if (!locals.user) throw redirect(302, '/login');
	if (locals.user.role !== 'admin') throw error(403, 'Forbidden');
}
function validateFields(form, allowed) {
	for (const name of form.keys()) {
		if (!allowed.includes(name) || form.getAll(name).length !== 1 || typeof form.get(name) !== 'string')
			throw new ActionError(400, 'Submit each recognized setting once.');
	}
}

export function createIntegrationAdmin({
	env = process.env, readSettings = readIntegrationSettings, resolveSettings = resolveIntegrationSettings,
	saveSettings = saveIntegrationSettings, applySettings = applyIntegrationSettings,
	maintenanceStatus = siteMaintenanceStatus, coordinate = withIntegrationConfigurationLock,
	getDatabase = getDb, webhook = createWebhookRegistration,
	pendingRestore = pendingRestoreMetadata,
	generateSecret = () => randomBytes(32).toString('hex')
} = {}) {
	const registration = () => webhook({ db: getDatabase(), env });
	const options = { env };
	function requireTelegramAvailable() {
		if (maintenanceStatus().enabled) throw new ActionError(409, 'Reopen site maintenance before changing Telegram settings or its webhook, so the original group permissions remain recoverable.');
	}
	function action(operation) {
		return async ({ locals, request }) => {
			requireAdmin(locals);
			if (!Number.isSafeInteger(locals.user.id) || locals.user.id <= 0) return fail(400, { error: 'A valid administrator account is required.' });
			try {
				const form = await request.formData();
				return await coordinate(() => operation(form));
			} catch (cause) {
				return fail(cause instanceof ActionError ? cause.status : 400, { error: cause instanceof ActionError ? cause.message : SAVE_ERROR });
			}
		};
	}
	return {
		load({ locals }) {
			requireAdmin(locals);
			try {
				return { settings: readSettings(options), webhook: registration().status(), maintenanceEnabled: maintenanceStatus().enabled, pendingRestore: pendingRestore() };
			} catch { throw error(503, 'Integration settings are unavailable. Check the retained server encryption key and private settings file.'); }
		},
		actions: {
			importEnvironment: action(async (form) => {
				requireTelegramAvailable();
				validateFields(form, ['confirmation']);
				if (form.get('confirmation') !== 'IMPORT SETTINGS') throw new ActionError(400, 'Type IMPORT SETTINGS exactly to copy legacy environment values into encrypted administrator settings.');
				const metadata = readSettings(options);
				const current = resolveSettings(options);
				const updates = {};
				for (const key of [...PROVIDERS, ...TELEGRAM]) {
					if (metadata.fields[key]?.source === 'environment' && metadata.fields[key].configured) updates[key] = current[key];
				}
				if (current.TELEGRAM_BOT_TOKEN && current.TELEGRAM_WEBHOOK_BASE_URL && !current.TELEGRAM_WEBHOOK_SECRET) updates.TELEGRAM_WEBHOOK_SECRET = generateSecret();
				if (Object.keys(updates).length) saveSettings(updates, options);
				applySettings(options);
				if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_BASE_URL) {
					try { await registration().register(); }
					catch { return { success: true, message: 'Legacy settings imported.', webhookError: WEBHOOK_ERROR }; }
				}
				return { success: true, message: 'Legacy environment settings imported. Keep the original server STORAGE_ENCRYPTION_KEY; imported API and Telegram environment values may now be removed from the deployment.' };
			}),
			saveProviders: action((form) => {
				validateFields(form, [...PROVIDERS, ...PROVIDERS.map(key => `clear_${key}`)]);
				const updates = {};
				for (const key of PROVIDERS) {
					const value = form.get(key) || '';
					const clear = form.get(`clear_${key}`);
					if (clear !== null && clear !== 'on') throw new ActionError(400, 'Use the clear checkbox once to disable a key.');
					if (clear && value) throw new ActionError(400, 'Choose either a replacement key or clear, not both.');
					if (clear || value) updates[key] = clear ? '' : value;
				}
				if (Object.keys(updates).length) {
					saveSettings(updates, options);
					applySettings(options);
				}
				return { success: true, message: 'Provider settings saved. New requests use the updated keys.' };
			}),
			saveTelegram: action(async (form) => {
				requireTelegramAvailable();
				validateFields(form, [...TELEGRAM, 'rotateWebhookSecret', 'replaceBotConfirmation']);
				const current = resolveSettings(options);
				const updates = {};
				for (const key of TELEGRAM) {
					if (!form.has(key)) continue;
					const value = form.get(key);
					if (value || !['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'].includes(key)) updates[key] = value;
				}
				const rotate = form.get('rotateWebhookSecret');
				if (rotate !== null && rotate !== 'on') throw new ActionError(400, 'Select secret rotation once.');
				if (rotate && updates.TELEGRAM_WEBHOOK_SECRET) throw new ActionError(400, 'Choose either a new secret or automatic secret rotation, not both.');
				const replacementConfirmation = form.get('replaceBotConfirmation');
				if (replacementConfirmation && replacementConfirmation !== 'REPLACE BOT') throw new ActionError(400, 'Type REPLACE BOT exactly only when the old bot webhook cannot be removed.');
				const replacingBot = Boolean(updates.TELEGRAM_BOT_TOKEN && current.TELEGRAM_BOT_TOKEN && updates.TELEGRAM_BOT_TOKEN !== current.TELEGRAM_BOT_TOKEN);
				const oldWebhookUnremoved = replacingBot && registration().status().state !== 'removed';
				if (oldWebhookUnremoved && replacementConfirmation !== 'REPLACE BOT')
					throw new ActionError(409, 'Remove the current bot webhook before replacing its token. If the old token is invalid or inaccessible, explicitly confirm REPLACE BOT and retire the old bot separately.');
				const effective = { ...current, ...updates };
				if (rotate || (replacingBot && !updates.TELEGRAM_WEBHOOK_SECRET) || (effective.TELEGRAM_BOT_TOKEN && effective.TELEGRAM_WEBHOOK_BASE_URL && !effective.TELEGRAM_WEBHOOK_SECRET)) updates.TELEGRAM_WEBHOOK_SECRET = generateSecret();
				if (Object.keys(updates).length) saveSettings(updates, options);
				applySettings(options);
				if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_BASE_URL) {
					try { await registration().register(); }
					catch { return { success: true, message: `Telegram settings saved.${oldWebhookUnremoved ? ' The old bot webhook was not removed; retire that bot separately.' : ''}`, webhookError: WEBHOOK_ERROR }; }
					return { success: true, message: `Telegram settings saved and webhook registered automatically.${oldWebhookUnremoved ? ' The old bot webhook was not removed; retire that bot separately.' : ''}` };
				}
				return { success: true, message: `Telegram settings saved. Set the bot token and public HTTPS website to register its webhook. Clearing the website does not remove a previously registered webhook.${oldWebhookUnremoved ? ' The old bot webhook was not removed; retire that bot separately.' : ''}` };
			}),
			registerWebhook: action(async (form) => {
				requireTelegramAvailable();
				validateFields(form, []);
				try { await registration().register(); }
				catch { throw new ActionError(503, WEBHOOK_ERROR); }
				return { success: true, message: 'Telegram webhook registered.' };
			}),
			removeWebhook: action(async (form) => {
				requireTelegramAvailable();
				validateFields(form, ['confirmation']);
				if (form.get('confirmation') !== 'REMOVE WEBHOOK') throw new ActionError(400, 'Type REMOVE WEBHOOK exactly to remove the bot webhook without dropping pending updates.');
				try { await registration().remove(); }
				catch { throw new ActionError(503, WEBHOOK_ERROR); }
				return { success: true, message: 'Telegram webhook removed. Pending updates were not discarded.' };
			})
		}
	};
}
