<script>
	import { invalidateAll } from '$app/navigation';
	let { data } = $props();
	let fullName = $derived(data.account.full_name);
	let username = $derived(data.account.username ?? '');
	let password = $state('');
	let busy = $state(false);
	let error = $state('');
	let success = $state('');

	async function save(event) {
		event.preventDefault();
		if (busy) return;
		error = '';
		success = '';
		if (!fullName.trim() || fullName.trim().length > 100) {
			error = 'Full name must be between 1 and 100 characters.';
			return;
		}
		if ((username || data.account.username) && !/^[a-z][a-z0-9_.-]{2,31}$/.test(username)) {
			error = 'Username must be 3–32 lowercase characters, starting with a letter.';
			return;
		}
		if (password && (password.length < 8 || new TextEncoder().encode(password).length > 72)) {
			error = 'Password must be at least 8 characters and at most 72 UTF-8 bytes.';
			return;
		}
		busy = true;
		try {
			const response = await fetch('/api/account', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ full_name: fullName.trim(), ...(username ? {username} : {}), ...(password ? {password} : {}) })
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(result.error || 'Unable to update account.');
			password = '';
			fullName = result.full_name;
			username = result.username ?? '';
			await invalidateAll();
			success = 'Account updated.';
		} catch (caught) {
			error = caught.message || 'Unable to update account.';
		} finally {
			busy = false;
		}
	}
</script>


<section class="max-w-xl space-y-4">
	<h1 class="text-2xl font-semibold">Account</h1>
	<p>Only administrators can change roles or remove accounts.</p>
	<p>Role: {data.account.role}</p>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	{#if success}<div class="alert alert-success" role="status">{success}</div>{/if}
	<form class="space-y-4" onsubmit={save}>
		<label class="form-control block">
			<span class="label-text">Full name</span>
			<input class="input input-bordered w-full" bind:value={fullName} required maxlength="100" disabled={busy} autocomplete="name" />
		</label>
		<label class="form-control block">
			<span class="label-text">Username</span>
			<input class="input input-bordered w-full" bind:value={username} required={Boolean(data.account.username)} minlength="3" maxlength="32" disabled={busy} autocomplete="username" />
		</label>
		<label class="form-control block">
			<span class="label-text">New password (optional)</span>
			<input class="input input-bordered w-full" type="password" bind:value={password} minlength="8" disabled={busy} autocomplete="new-password" />
		</label>
		<p class="text-sm">Blank password keeps the current one. Use 8+ characters, at most 72 UTF-8 bytes. Changing it signs out other sessions. To enable login, provide both username and password.</p>
		<button class="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
	</form>
</section>
