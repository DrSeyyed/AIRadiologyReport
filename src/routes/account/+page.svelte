<script>
	import { invalidateAll } from '$app/navigation';
	let { data } = $props();
	let fullName = $derived(data.account.full_name);
	let username = $derived(data.account.username ?? '');
	let password = $state('');
	let busy = $state(false);
	let error = $state('');
	let success = $state('');
	let delegateIds = $derived(data.signingDelegates?.resident_ids ?? []);
	let residentSearch = $state('');
	let delegatesBusy = $state(false);
	let delegatesError = $state('');
	let delegatesSuccess = $state('');
	let englishVariant = $derived(data.reportPreferences?.english_variant ?? 'british');
	let preferencesBusy = $state(false);
	let preferencesError = $state('');
	let preferencesSuccess = $state('');

	async function saveReportPreferences(event) {
		event.preventDefault();
		if (preferencesBusy) return;
		preferencesBusy = true;
		preferencesError = '';
		preferencesSuccess = '';
		try {
			const response = await fetch('/api/account/report-preferences', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ english_variant: englishVariant })
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(result.error || 'Unable to save report preferences.');
			await invalidateAll();
			englishVariant = result.english_variant;
			preferencesSuccess = 'Report English updated.';
		} catch (caught) {
			preferencesError = caught.message || 'Unable to save report preferences.';
		} finally {
			preferencesBusy = false;
		}
	}

	const visibleResidents = $derived((data.signingDelegates?.residents ?? []).filter(resident =>
		resident.full_name.toLocaleLowerCase().includes(residentSearch.trim().toLocaleLowerCase())
	));

	async function saveDelegates(event) {
		event.preventDefault();
		if (delegatesBusy) return;
		delegatesBusy = true;
		delegatesError = '';
		delegatesSuccess = '';
		try {
			const response = await fetch('/api/account/signing-delegates', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ resident_ids: delegateIds })
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(result.error || 'Unable to save signing delegates.');
			await invalidateAll();
			delegateIds = result.resident_ids;
			delegatesSuccess = 'Signing delegates updated.';
		} catch (caught) {
			delegatesError = caught.message || 'Unable to save signing delegates.';
		} finally {
			delegatesBusy = false;
		}
	}

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
	{#if data.account.role === 'attending'}
		<section class="space-y-3 border-t pt-4" aria-labelledby="report-english-heading">
			<h2 id="report-english-heading" class="text-xl font-semibold">Report English</h2>
			<p id="report-english-description" class="text-sm">Applies to future generated reports for studies assigned to you as the attending. Existing reports are unchanged.</p>
			{#if preferencesError}<div class="alert alert-error" role="alert">{preferencesError}</div>{/if}
			<p role="status" class="text-sm">{preferencesBusy ? 'Saving report English…' : preferencesSuccess}</p>
			<form onsubmit={saveReportPreferences} aria-busy={preferencesBusy}>
				<fieldset class="space-y-3" disabled={preferencesBusy} aria-describedby="report-english-description">
					<legend class="sr-only">Report English</legend>
					<label class="flex items-center gap-3">
						<input class="radio radio-sm" type="radio" name="english_variant" value="british" bind:group={englishVariant} onchange={() => { preferencesSuccess = ''; }} />
						<span>British English</span>
					</label>
					<label class="flex items-center gap-3">
						<input class="radio radio-sm" type="radio" name="english_variant" value="american" bind:group={englishVariant} onchange={() => { preferencesSuccess = ''; }} />
						<span>American English</span>
					</label>
					<button class="btn btn-primary" type="submit">{preferencesBusy ? 'Saving…' : 'Save report English'}</button>
				</fieldset>
			</form>
		</section>
	{/if}
	{#if data.account.role === 'attending' && data.signingDelegates}
		<section class="space-y-3 border-t pt-4" aria-labelledby="signing-delegates-heading">
			<h2 id="signing-delegates-heading" class="text-xl font-semibold">Residents who may sign for me</h2>
			<p class="text-sm">Selected residents may add or withdraw your attending approval only on studies assigned to you and recordings assigned to themselves. Resident approval is still required first. Removing permission does not remove existing signatures.</p>
			{#if delegatesError}<div class="alert alert-error" role="alert">{delegatesError}</div>{/if}
			{#if delegatesSuccess}<div class="alert alert-success" role="status">{delegatesSuccess}</div>{/if}
			<form onsubmit={saveDelegates}>
				<fieldset class="min-w-0 space-y-3" disabled={delegatesBusy}>
					<legend class="sr-only">Allowed residents</legend>
					<label class="form-control block">
						<span class="label-text">Find resident</span>
						<input class="input input-bordered w-full" type="search" bind:value={residentSearch} />
					</label>
					<p class="text-sm">{delegateIds.length} selected</p>
					<div class="max-h-64 space-y-2 overflow-y-auto rounded border p-3">
						{#each visibleResidents as resident (resident.id)}
							<label class="flex items-center gap-3">
								<input class="checkbox checkbox-sm shrink-0" type="checkbox" checked={delegateIds.includes(resident.id)} onchange={(event) => {
									delegateIds = event.currentTarget.checked ? [...delegateIds, resident.id] : delegateIds.filter(id => id !== resident.id);
									delegatesSuccess = '';
								}} />
								<span class="min-w-0 break-words">{resident.full_name}</span>
							</label>
						{:else}
							<p class="text-sm">{data.signingDelegates.residents.length ? 'No matching residents.' : 'No resident accounts available.'}</p>
						{/each}
					</div>
					<button class="btn btn-primary" type="submit">{delegatesBusy ? 'Saving…' : 'Save signing delegates'}</button>
				</fieldset>
			</form>
		</section>
	{/if}
</section>
