<script>
	import { tick } from 'svelte';
	import { filterSearchOptions } from '$lib/search-options.js';

	let { label, options, value = $bindable(''), name, emptyLabel = 'All', compact = false, resetOnSelect = false, onSelect } = $props();
	const id = $props.id();
	let container = $state();
	let input = $state();
	let list = $state();
	let open = $state(false);
	let text = $state('');
	let query = $state('');
	let active = $state(-1);
	let upward = $state(false);
	let menuHeight = $state(240);
	const matches = $derived(filterSearchOptions(options, query));
	const selected = $derived(options.find((option) => String(option.id) === String(value)));
	const selectedLabel = $derived(selected ? `${selected.code} — ${selected.name}` : '');
	const choices = $derived([{ id: '', name: emptyLabel }, ...matches]);

	function positionMenu() {
		if (!input) return;
		const bounds = input.getBoundingClientRect();
		const modal = input.closest('[role="dialog"]')?.getBoundingClientRect();
		const viewportTop = window.visualViewport?.offsetTop ?? 0;
		const viewportBottom = viewportTop + (window.visualViewport?.height ?? window.innerHeight);
		const below = Math.min(viewportBottom, modal?.bottom ?? viewportBottom) - bounds.bottom;
		const above = bounds.top - Math.max(viewportTop, modal?.top ?? viewportTop);
		upward = below < 200 && above > below;
		menuHeight = Math.max(48, Math.min(240, (upward ? above : below) - 12));
	}

	function showOptions() {
		if (open || input?.matches(':disabled')) return;
		text = selectedLabel;
		query = '';
		active = Math.max(0, choices.findIndex((option) => String(option.id) === String(value)));
		open = true;
		positionMenu();
	}

	function choose(option) {
		if (!option || input?.matches(':disabled')) return;
		const chosen = String(option.id);
		value = resetOnSelect ? '' : chosen;
		open = false;
		query = '';
		onSelect?.(chosen);
	}

	function keydown(event) {
		if (event.isComposing) return;
		if (event.key === 'Escape' && open) {
			event.preventDefault();
			event.stopPropagation();
			open = false;
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (!open) showOptions();
			else active = (active + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
		} else if (open && (event.key === 'Home' || event.key === 'End')) {
			event.preventDefault();
			active = event.key === 'Home' ? 0 : choices.length - 1;
		} else if (open && event.key === 'Enter') {
			event.preventDefault();
			if (active >= 0) choose(choices[active]);
		} else if (event.key === 'Tab') open = false;
	}

	$effect(() => {
		if (!open) return;
		function outside(event) { if (!container.contains(event.target)) open = false; }
		document.addEventListener('pointerdown', outside);
		window.addEventListener('resize', positionMenu);
		window.addEventListener('scroll', positionMenu, true);
		const viewport = window.visualViewport;
		viewport?.addEventListener('resize', positionMenu);
		viewport?.addEventListener('scroll', positionMenu);
		return () => {
			document.removeEventListener('pointerdown', outside);
			window.removeEventListener('resize', positionMenu);
			window.removeEventListener('scroll', positionMenu, true);
			viewport?.removeEventListener('resize', positionMenu);
			viewport?.removeEventListener('scroll', positionMenu);
		};
	});

	$effect(() => {
		if (open && active >= 0) {
			const index = active;
			tick().then(() => list?.children[index]?.scrollIntoView({ block: 'nearest' }));
		}
	});
</script>

<div class="form-control min-w-0 gap-1" bind:this={container} onfocusout={(event) => { if (!container.contains(event.relatedTarget)) open = false; }}>
	<label class="label-text text-sm" for={id}>{label}</label>
	<input type="hidden" {name} {value} />
	<div class="relative min-w-0">
		<input
			{id}
			bind:this={input}
			class={compact ? 'input input-bordered input-sm h-9 w-full min-w-0 pr-8' : 'input input-bordered w-full min-w-0 pr-8'}
			role="combobox"
			aria-expanded={open}
			aria-controls={`${id}-list`}
			aria-autocomplete="list"
			aria-activedescendant={open && active >= 0 ? `${id}-option-${active}` : undefined}
			placeholder={emptyLabel}
			autocomplete="off"
			value={open ? text : selectedLabel}
			onfocus={(event) => { showOptions(); event.currentTarget.select(); }}
			onclick={showOptions}
			oninput={(event) => {
				text = event.currentTarget.value;
				query = text;
				open = true;
				active = query.trim() ? matches.length ? 1 : -1 : 0;
				positionMenu();
			}}
			onkeydown={keydown}
		/>
		<button type="button" class="absolute inset-y-0 right-0 w-8" aria-label={`Show ${label} options`} tabindex="-1"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => { if (open) open = false; else { input.focus(); showOptions(); } }}><span aria-hidden="true">▾</span></button>
		{#if open}
			<ul bind:this={list} id={`${id}-list`} role="listbox" aria-label={label}
				class="absolute z-50 w-full overflow-y-auto overscroll-contain rounded-box border border-base-content/30 bg-base-100 p-1 shadow-lg"
				style:max-height={`${menuHeight}px`} style:bottom={upward ? 'calc(100% + 4px)' : undefined} style:top={upward ? undefined : 'calc(100% + 4px)'}>
				{#each choices as option, index (option.id)}
					<li role="presentation">
						<button type="button" role="option" id={`${id}-option-${index}`} aria-selected={String(value) === String(option.id)} tabindex="-1"
							class="w-full rounded px-3 py-2 text-left text-sm whitespace-normal break-words hover:bg-base-200" class:bg-base-200={active === index}
							onmousedown={(event) => event.preventDefault()} onclick={() => choose(option)}>{option.code ? `${option.code} — ${option.name}` : option.name}</button>
					</li>
				{/each}
				{#if !matches.length}<li class="px-3 py-2 text-sm" role="presentation">No matching options</li>{/if}
			</ul>
		{/if}
	</div>
</div>
