import { json } from '@sveltejs/kit';
import { destroySession } from '$lib/server/auth';

export async function POST({cookies}) {
  const sessionId = cookies.get('session');
  if (sessionId) {
    destroySession(sessionId);
    cookies.delete('session', { path: '/' });
  }
  return json({ ok: true });
}
