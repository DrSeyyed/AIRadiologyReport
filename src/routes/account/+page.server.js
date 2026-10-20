import { error, redirect } from '@sveltejs/kit';

export async function load({ locals, fetch }) {
	if (!locals.user) throw redirect(302, '/login');
	const response = await fetch('/api/account');
	if (!response.ok) throw error(response.status, 'Unable to load account');
	const account = await response.json();
	let signingDelegates = null;
	if (account.role === 'attending') {
		const delegates = await fetch('/api/account/signing-delegates');
		if (!delegates.ok) throw error(delegates.status, 'Unable to load signing delegates');
		signingDelegates = await delegates.json();
	}
	return { account, signingDelegates };
}
