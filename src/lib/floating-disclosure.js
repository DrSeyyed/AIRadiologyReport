const GAP = 4;
const MARGIN = 8;
const openDisclosures = new Set();

/** Places a panel below its anchor (or above when there is no room), kept inside the viewport. */
export function floatingPosition(anchor, panel, viewport) {
	const maxHeight = Math.max(0, viewport.height - MARGIN * 2);
	const height = Math.min(panel.height, maxHeight);
	const left = Math.max(MARGIN, Math.min(anchor.left, viewport.width - panel.width - MARGIN));
	let top = anchor.bottom + GAP;
	if (top + height > viewport.height - MARGIN) {
		const above = anchor.top - GAP - height;
		top = above >= MARGIN ? above : Math.max(MARGIN, viewport.height - MARGIN - height);
	}
	return { left, top, maxHeight };
}

/**
 * Svelte action for a <details> element whose panel (marked data-floating-panel) floats
 * above the page instead of expanding the surrounding table row.
 */
export function floatingDisclosure(details) {
	const summary = () => details.querySelector(':scope > summary');
	const panel = () => details.querySelector(':scope > [data-floating-panel]');
	let resizeObserver;

	function position() {
		const anchorElement = summary();
		const panelElement = panel();
		if (!anchorElement || !panelElement) return;
		const anchor = anchorElement.getBoundingClientRect();
		if (anchor.bottom < 0 || anchor.top > window.innerHeight) {
			details.open = false;
			return;
		}
		Object.assign(panelElement.style, { position: 'fixed', zIndex: '35', margin: '0', overflowY: 'auto' });
		const size = panelElement.getBoundingClientRect();
		const { left, top, maxHeight } = floatingPosition(anchor, size, { width: window.innerWidth, height: window.innerHeight });
		Object.assign(panelElement.style, { left: `${left}px`, top: `${top}px`, maxHeight: `${maxHeight}px` });
	}

	function onScroll(event) {
		if (!panel()?.contains(event.target)) position();
	}

	function onPointerDown(event) {
		if (!details.contains(event.target)) details.open = false;
	}

	function onKeydown(event) {
		if (event.key !== 'Escape' || event.defaultPrevented) return;
		event.preventDefault();
		details.open = false;
		summary()?.focus();
	}

	function listen(add) {
		const method = add ? 'addEventListener' : 'removeEventListener';
		window[method]('scroll', onScroll, true);
		window[method]('resize', position);
		document[method]('pointerdown', onPointerDown, true);
		document[method]('keydown', onKeydown);
		resizeObserver?.disconnect();
		resizeObserver = undefined;
		if (add && typeof ResizeObserver === 'function' && panel()) {
			resizeObserver = new ResizeObserver(position);
			resizeObserver.observe(panel());
		}
	}

	function onToggle() {
		if (details.open) {
			for (const other of openDisclosures) if (other !== details) other.open = false;
			openDisclosures.add(details);
			position();
			listen(true);
		} else {
			openDisclosures.delete(details);
			listen(false);
		}
	}

	details.addEventListener('toggle', onToggle);
	return {
		destroy() {
			details.removeEventListener('toggle', onToggle);
			openDisclosures.delete(details);
			listen(false);
		}
	};
}
