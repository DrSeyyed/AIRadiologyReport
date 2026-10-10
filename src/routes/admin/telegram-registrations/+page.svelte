<script>
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';

	let { data } = $props();
	let roles = $state({});
	let status = $state('pending');
	let busy = $state(null);
	let error = $state('');
	let success = $state('');
	let warning = $state('');
	const registrations = $derived(data.registrations.filter((registration) => !status || registration.step === status));
	const pendingCount = $derived(data.registrations.filter((registration) => registration.step === 'pending').length);

	async function review(registration, action) {
		if (busy !== null || registration.step !== 'pending') return;
		const role = roles[registration.id] ?? registration.role;
		if (action === 'approve' && !['resident', 'attending', 'typist'].includes(role)) {
			error = 'Verify a resident, attending or typist role before approval.';
			return;
		}
		if (!confirm(action === 'approve'
			? `Approve ${registration.full_name} as ${role} and create website account "${registration.username}"?`
			: `Reject registration for ${registration.full_name}?`)) return;
		busy = registration.id;
		error = '';
		success = '';
		warning = '';
		try {
			const response = await fetch(`/api/telegram/registrations/${registration.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action, ...(action === 'approve' ? { role } : {}) })
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(result.error || 'Registration review failed');
			success = action === 'approve' ? 'Registration approved; website account created.' : 'Registration rejected.';
			warning = result.notification_warning || '';
			await invalidateAll();
		} catch (caught) {
			error = caught.message || 'Registration review failed';
		} finally {
			busy = null;
		}
	}
</script>

<svelte:head><title>Telegram registrations</title></svelte:head>

<section class="space-y-4">
	<div class="flex flex-wrap items-center gap-4">
		<h1 class="text-2xl font-semibold">Telegram registrations</h1>
		<a class="btn btn-ghost" href={resolve('/admin/users')}>User management</a>
	</div>
	<p>Residents, attendings and typists register privately with the Telegram bot using their full name, role and website username/password. Verify the identity and role before approving. Approval automatically creates the website account; pending and rejected applicants do not appear in staff selectors. Passwords are never displayed here.</p>
	{#if !data.telegramConfigured}
		<div class="alert alert-warning" role="status">Telegram is not configured. Configure the bot before accepting private registrations or sending notifications.</div>
	{/if}
	{#if !data.webhookConfigured}
		<div class="alert alert-warning" role="status">Telegram webhook security is not configured. Set TELEGRAM_WEBHOOK_SECRET on the server and configure the bot webhook with the matching secret before using Telegram onboarding.</div>
	{/if}
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	{#if success}<div class="alert alert-success" role="status">{success}</div>{/if}
	{#if warning}<div class="alert alert-warning" role="status">{warning}</div>{/if}
	<div class="flex flex-wrap items-end gap-4">
		<label class="form-control">
			<span class="label-text">Status ({pendingCount} pending)</span>
			<select class="select select-bordered" bind:value={status} disabled={busy !== null}>
				<option value="pending">Pending</option>
				<option value="approved">Approved</option>
				<option value="rejected">Rejected</option>
				<option value="">All</option>
			</select>
		</label>
		<button class="btn btn-outline" disabled={busy !== null} onclick={() => { error = ''; invalidateAll().catch((caught) => (error = caught.message || 'Refresh failed')); }}>Refresh</button>
	</div>
	<div class="overflow-x-auto rounded-box border">
		<table class="table table-sm">
			<thead><tr><th>Name / website username</th><th>Telegram identity</th><th>Requested / verified role</th><th>Status / account</th><th>Created / updated</th><th>Review</th></tr></thead>
			<tbody>
				{#each registrations as registration (registration.id)}
					<tr>
						<td>{registration.full_name}<div class="text-sm">{registration.username}</div></td>
						<td>{registration.telegram_username ? `@${registration.telegram_username}` : 'No Telegram username'}<div class="text-xs">ID: {registration.telegram_user_id}</div></td>
						<td>
							<div>Requested: {registration.role}</div>
							{#if registration.step === 'pending'}
								<label class="form-control">
									<span class="label-text">Verified role for approval</span>
									<select class="select select-bordered select-sm" value={roles[registration.id] ?? registration.role} disabled={busy !== null} onchange={(event) => (roles[registration.id] = event.currentTarget.value)}>
										<option value="resident">Resident</option>
										<option value="attending">Attending</option>
										<option value="typist">Typist</option>
									</select>
								</label>
							{/if}
						</td>
						<td><span class="badge">{registration.step}</span>{#if registration.user_id}<div>Website user #{registration.user_id}</div>{/if}</td>
						<td>{registration.created_at}<div class="text-xs">{registration.updated_at}</div></td>
						<td>
							{#if registration.step === 'pending'}
								<div class="flex gap-2">
									<button class="btn btn-success btn-sm" disabled={busy !== null} onclick={() => review(registration, 'approve')}>Approve</button>
									<button class="btn btn-error btn-outline btn-sm" disabled={busy !== null} onclick={() => review(registration, 'reject')}>Reject</button>
								</div>
								{#if busy === registration.id}<span role="status">Saving…</span>{/if}
							{:else}Reviewed{/if}
						</td>
					</tr>
				{:else}<tr><td colspan="6">No {status || ''} registrations.</td></tr>{/each}
			</tbody>
		</table>
	</div>
</section>
