import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import config from '../tailwind.config.js';
import { applyThemeChoice, normalizeThemeChoice, resolveTheme, storedThemeChoice } from '../src/lib/theme.js';

function withBrowser(t, { stored = null, prefersDark = false, storageFails = false } = {}) {
	const values = new Map(stored ? [['theme', stored]] : []);
	const fail = () => { throw new Error('Storage unavailable'); };
	const storage = {
		getItem: storageFails ? fail : (key) => values.get(key) ?? null,
		setItem: storageFails ? fail : (key, value) => values.set(key, value),
		removeItem: storageFails ? fail : (key) => values.delete(key)
	};
	const document = { documentElement: { dataset: {} } };
	for (const [name, value] of [['localStorage', storage], ['matchMedia', () => ({ matches: prefersDark })]]) {
		const previous = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
		t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
	}
	return { values, document };
}

test('theme choices normalize to system and resolve against the OS preference', () => {
	for (const invalid of [null, undefined, '', 'blue', 1]) assert.equal(normalizeThemeChoice(invalid), 'system');
	assert.equal(resolveTheme('system', true), 'dark');
	assert.equal(resolveTheme('system', false), 'light');
	assert.equal(resolveTheme('light', true), 'light');
	assert.equal(resolveTheme('dark', false), 'dark');
});

test('explicit choices persist, system clears storage and follows the OS', (t) => {
	const { values, document } = withBrowser(t, { prefersDark: true });
	assert.equal(applyThemeChoice('light', document), 'light');
	assert.equal(values.get('theme'), 'light');
	assert.equal(document.documentElement.dataset.theme, 'light');
	assert.equal(storedThemeChoice(), 'light');
	assert.equal(applyThemeChoice('system', document), 'dark');
	assert.equal(values.has('theme'), false);
	assert.equal(document.documentElement.dataset.theme, 'dark');
	assert.equal(storedThemeChoice(), 'system');
});

test('unavailable storage still applies the theme to the current page', (t) => {
	const { document } = withBrowser(t, { storageFails: true });
	assert.equal(storedThemeChoice(), 'system');
	assert.equal(applyThemeChoice('dark', document), 'dark');
	assert.equal(document.documentElement.dataset.theme, 'dark');
});

test('the saved theme is applied before first paint and both DaisyUI themes are built without OS auto-switching', async () => {
	const html = readFileSync(new URL('../src/app.html', import.meta.url), 'utf8');
	assert.match(html, /data-theme="light"/);
	assert.ok(html.indexOf("localStorage.getItem('theme')") < html.indexOf('%sveltekit.head%'));
	assert.deepEqual(config.daisyui.themes, ['light', 'dark']);
	assert.equal(config.daisyui.darkTheme, false);
	const source = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
	const { css } = await postcss([tailwindcss(config)]).process(source, { from: undefined });
	assert.match(css, /\[data-theme=dark\]/);
	assert.match(css, /html\[data-theme='dark'\] \{[^}]*--app-page: #0f172a/);
	assert.match(css, /html\[data-theme='dark'\] \{[^}]*--fallback-b1: #1d232a/);
	assert.doesNotMatch(css, /prefers-color-scheme: dark\)\s*\{\s*:root/);
});

test('the header offers System, Light and Dark theme choices', () => {
	const layout = readFileSync(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
	assert.match(layout, /aria-label="Color theme"[^>]*onchange=\{chooseTheme\}/);
	assert.match(layout, /prefers-color-scheme: dark/);
});
