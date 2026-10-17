import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { queueGroupInvitations, queueWebsiteLinks, validateInvitationUserIds, validateWebsiteUrl } from '$lib/server/telegram-invitations.js';
import { getTelegramWebsiteUrl, setTelegramWebsiteUrl } from '$lib/server/telegram-settings.js';

export async function PATCH({ locals, request }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.user.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
	try {
		const body = await request.json();
		if (typeof body?.website_url !== 'string')
			return json({ error: 'Provide a website link.' }, { status: 400 });
		const value = body.website_url.trim();
		if (value) validateWebsiteUrl(value);
		return json({ website_url: setTelegramWebsiteUrl(getDb(), value) });
	} catch (error) {
		return json({ error: error.status === 400 ? error.message : 'Unable to save website link.' }, { status: 400 });
	}
}

export async function POST({ locals, request }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.user.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
	let kind;
	try {
		const body = await request.json().catch(() => null);
		const ids = validateInvitationUserIds(body?.user_ids);
		kind = body.kind ?? 'group';
		if (!['group', 'website'].includes(kind)) return json({ error: 'Invalid link type.' }, { status: 400 });
		if (kind === 'website') {
			const link = body.website_url === undefined
				? getTelegramWebsiteUrl(getDb()) : validateWebsiteUrl(body.website_url);
			if (!link) return json({ error: 'Save the website link in User Management first.' }, { status: 400 });
			return json(await queueWebsiteLinks(getDb(), ids, link));
		}
		return json(await queueGroupInvitations(getDb(), ids));
	} catch (error) {
		return json({ error: error.status === 400 ? error.message : kind === 'website' ? 'Unable to queue website links.' : 'Unable to queue invitations. Check the study group and bot invite permissions.' }, { status: error.status || 503 });
	}
}
