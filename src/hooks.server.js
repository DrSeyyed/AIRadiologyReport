import { building } from '$app/environment';
import { getSession } from '$lib/server/auth';
import { startVoiceWorker } from '$lib/server/voice-worker';
import { getDb } from '$lib/server/db';
import { startStudyNotificationWorker } from '$lib/server/study-notifications.js';
import { startGroupInvitationWorker } from '$lib/server/telegram-invitations.js';
import { startTelegramStudyRefreshWorker } from '$lib/server/telegram-study-refresh.js';
import { startStorageWorker } from '$lib/server/storage-worker.js';
import { restoreActivation } from '$lib/server/restore-activation-runtime.js';
import { siteMaintenanceStatus } from '$lib/server/site-maintenance.js';
import { maintenanceResponse } from '$lib/server/maintenance-response.js';
import { applyIntegrationSettings } from '$lib/server/integration-settings.js';

import { setGlobalDispatcher, ProxyAgent } from 'undici';

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.ALL_PROXY ||
  '';

if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log('[proxy] Using proxy for server fetch ->', proxyUrl);
}

if (!building) {
  applyIntegrationSettings();
  startVoiceWorker(getDb);
  startStudyNotificationWorker(getDb);
  startGroupInvitationWorker(getDb);
  startTelegramStudyRefreshWorker(getDb);
  startStorageWorker(getDb);
}

export const handle = async ({ event, resolve }) => {
  if (event.url.pathname === '/__restore-health') {
    if (event.request.method !== 'GET' || !process.env.RESTORE_STARTUP_TOKEN ||
      event.request.headers.get('x-restore-startup-token') !== process.env.RESTORE_STARTUP_TOKEN)
      return new Response(null, { status: 404 });
    getDb().prepare('SELECT 1').get();
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  }
  const maintenance = siteMaintenanceStatus();
  event.locals.maintenance = maintenance;
  if (maintenance.enabled && event.url.pathname === '/api/telegram/webhook')
    return resolve(event);
  if (restoreActivation.maintenance())
    return maintenanceResponse(event.request, { activating: true });
  return restoreActivation.request(async () => {
    // Read cookie
    const cookie = event.cookies.get('session');
    const got = getSession(cookie);

    if (got) {
      event.locals.user = got.user;        // id, full_name, role
      event.locals.session = got.session;  // id, user_id, expires_at
    } else {
      event.locals.user = null;
      event.locals.session = null;
    }

    if (maintenance.enabled && event.locals.user?.role !== 'admin' &&
      !['/login', '/logout'].includes(event.url.pathname))
      return maintenanceResponse(event.request);

    // Continue
    return resolve(event);
  });
};