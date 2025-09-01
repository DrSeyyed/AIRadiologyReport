import { getSession } from '$lib/server/auth';
import { startVoiceWorker } from '$lib/server/voice-worker';

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

startVoiceWorker();

export const handle = async ({ event, resolve }) => {
  // Read cookie
  const cookie = event.cookies.get('session');
  const got = getSession(cookie);

  if (got) {
    event.locals.user = got.user;        // id, full_name, role, email
    event.locals.session = got.session;  // id, user_id, expires_at
  } else {
    event.locals.user = null;
    event.locals.session = null;
  }

  // Continue
  return resolve(event);
};