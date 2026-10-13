<script>
	let { study, recording, user, onChanged, disabled = false } = $props();
	let busy = $state(false);
	let error = $state('');
	const signed = $derived(Boolean(recording.typist_checked));
	const clinicallySigned = $derived(Boolean(recording.resident_checked && recording.attending_checked));
	const authorized = $derived(user?.role === 'admin' || user?.role === 'typist' ||
		(user?.role === 'attending' && Number(user.id) === Number(study.corresponding_attending_id)) ||
		(user?.role === 'resident' && Number(user.id) === Number(recording.corresponding_resident_id)));
	const blocked = $derived(disabled || busy || Boolean(recording.processing) || !authorized || (!signed && !clinicallySigned));

	async function sign(input) {
		const checked = input.checked;
		if (blocked) { input.checked = !checked; return; }
		busy = true;
		error = '';
		let saved = false;
		try {
			const response = await fetch(`/api/studies/${study.id}/recordings/${recording.id}/sign`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ role: 'typist', checked })
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(result.error || 'Unable to update typist signature');
			saved = true;
			await onChanged();
		} catch (caught) {
			if (!saved) input.checked = !checked;
			error = caught.message || 'Unable to update typist signature';
		} finally {
			busy = false;
		}
	}
</script>

<div class="space-y-1 text-sm">
	<label class="flex items-center gap-2">
		<input type="checkbox" class="checkbox checkbox-sm" checked={signed} disabled={blocked} onchange={(event) => sign(event.currentTarget)} />
		Typist signed (printed)
	</label>
	{#if signed}
		<p>Typist confirmation by {recording.typist_signer_fullname || 'Unknown signer'}{#if recording.typist_signed_at} · {recording.typist_signed_at}{/if}</p>
	{:else if !clinicallySigned}
		<p class="text-xs opacity-70">Resident and attending must sign before confirming printing.</p>
	{:else}
		<p class="text-xs opacity-70">Confirm only after printing.</p>
	{/if}
	{#if busy}<p role="status">Updating typist signature…</p>{/if}
	{#if error}<p class="text-error" role="alert">{error}</p>{/if}
</div>
