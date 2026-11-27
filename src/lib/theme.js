export const THEME_STORAGE_KEY = 'theme';
export const themeChoices = [
	{ value: 'system', label: 'System' },
	{ value: 'light', label: 'Light' },
	{ value: 'dark', label: 'Dark' }
];

export function normalizeThemeChoice(choice) {
	return themeChoices.some((option) => option.value === choice) ? choice : 'system';
}

export function resolveTheme(choice, prefersDark) {
	const normalized = normalizeThemeChoice(choice);
	if (normalized === 'system') return prefersDark ? 'dark' : 'light';
	return normalized;
}

function storage() {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}

export function storedThemeChoice() {
	try {
		return normalizeThemeChoice(storage()?.getItem(THEME_STORAGE_KEY));
	} catch {
		return 'system';
	}
}

export function prefersDarkScheme() {
	return Boolean(globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

/** Applies and remembers the chosen theme. Storage failures (private mode) still apply it for this page. */
export function applyThemeChoice(choice, document = globalThis.document) {
	const normalized = normalizeThemeChoice(choice);
	try {
		if (normalized === 'system') storage()?.removeItem(THEME_STORAGE_KEY);
		else storage()?.setItem(THEME_STORAGE_KEY, normalized);
	} catch {
		// The theme still applies to the current page.
	}
	const theme = resolveTheme(normalized, prefersDarkScheme());
	if (document?.documentElement) document.documentElement.dataset.theme = theme;
	return theme;
}
