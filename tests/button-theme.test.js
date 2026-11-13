import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import config from '../tailwind.config.js';

const source = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
const control = ':is(.btn.btn, .button-tint.button-tint)';
const enabled = ":where(:not(:disabled, [disabled], .btn-disabled, [aria-disabled='true']))";
const { root } = await postcss([tailwindcss(config), autoprefixer]).process(source, {
	from: undefined
});

function declarations(selector) {
	const result = {};
	root.walkRules((rule) => {
		const normalized = rule.selector
			.replace(/\s+/g, ' ')
			.replace(/\(\s+/g, '(')
			.replace(/\s+\)/g, ')');
		if (normalized === selector) {
			rule.walkDecls((declaration) => (result[declaration.prop] = declaration.value));
		}
	});
	return result;
}

function luminance(hex) {
	const channels = hex.match(/[a-f\d]{2}/gi).map((channel) => {
		const value = parseInt(channel, 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(first, second) {
	const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
	return (values[0] + 0.05) / (values[1] + 0.05);
}

test('button-only palettes use light fills and readable semantic text in every enabled state', () => {
	for (const semantic of [
		'neutral',
		'primary',
		'secondary',
		'accent',
		'info',
		'success',
		'warning',
		'error'
	]) {
		const styles = {
			...declarations(control),
			...declarations(`:is(.btn, .button-tint).btn-${semantic}`)
		};
		for (const state of ['bg', 'hover', 'active']) {
			const background = styles[`--button-${state}`];
			assert.match(background, /^#[a-f\d]{6}$/i, `${semantic} ${state} has a legacy-safe fill`);
			assert.ok(luminance(background) > 0.65, `${semantic} ${state} remains light`);
			assert.ok(
				contrast(styles['--button-text'], background) >= 4.5,
				`${semantic} ${state} meets normal-text AA contrast`
			);
		}
		assert.ok(
			contrast(styles['--button-border'], styles['--button-bg']) >= 3,
			`${semantic} border stays clear`
		);
	}
});

test('late button overrides cover outline, ghost, hover, pressed, focus and disabled without resizing', () => {
	const base = declarations(control);
	assert.equal(base['background-color'], 'var(--button-bg)');
	assert.equal(base.color, 'var(--button-text)');
	assert.equal(base.border, '1px solid var(--button-border)');
	assert.equal(base['background-image'], 'none');
	assert.equal(base['box-shadow'], 'none');
	assert.equal(
		declarations(`${control}:where(:not(.btn-circle))`)['border-radius'],
		'var(--rounded-btn, 0.5rem)'
	);
	assert.equal(
		declarations(`${control}${enabled}:hover`)['background-color'],
		'var(--button-hover)'
	);
	const active = declarations(
		`${control}${enabled}:is(:active, .btn-active, [aria-pressed='true'], [aria-selected='true'], [aria-current], :checked)`
	);
	assert.equal(active['background-color'], 'var(--button-active)');
	assert.equal(active.color, 'var(--button-text)');
	assert.equal(declarations(`${control}:focus-visible`).outline, '2px solid var(--button-text)');
	const disabled = declarations(
		`${control}:is(:disabled, [disabled], .btn-disabled, [aria-disabled='true'])`
	);
	assert.equal(disabled.opacity, '1');
	assert.equal(disabled['pointer-events'], 'none');
	assert.ok(contrast(disabled.color, disabled['background-color']) >= 4.5);
	for (const property of [
		'width',
		'height',
		'min-height',
		'padding',
		'font-size',
		'line-height',
		'display'
	]) {
		assert.equal(base[property], undefined, `${property} remains component-owned`);
	}
	assert.ok(source.indexOf(control) > source.indexOf('@tailwind utilities;'));
	assert.doesNotMatch(source, /!important/);
});

test('custom login, administration and report controls opt in without legacy saturated overrides', () => {
	for (const file of [
		'login/+page.svelte',
		'admin/users/+page.svelte',
		'admin/templates/+page.svelte'
	]) {
		const component = readFileSync(new URL(`../src/routes/${file}`, import.meta.url), 'utf8');
		for (const button of component.matchAll(/<button\b[^>]*>/gs)) {
			assert.match(button[0], /class="(?:btn\b|button-tint\b)/, `${file} button uses the theme`);
			assert.doesNotMatch(button[0], /bg-gray-200|text-white|hover:bg-/);
		}
	}
	const navigation = readFileSync(
		new URL('../src/routes/admin/+layout.svelte', import.meta.url),
		'utf8'
	);
	assert.match(navigation, /class="button-tint rounded-btn/);
	assert.doesNotMatch(navigation, /class:bg-primary|class:text-primary-content/);
	const report = readFileSync(
		new URL('../src/routes/studies/ReportModal.svelte', import.meta.url),
		'utf8'
	);
	assert.equal([...report.matchAll(/class="tab button-tint btn-primary/g)].length, 2);
	const layout = readFileSync(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
	assert.match(layout, /class="btn btn-primary drawer-button"/);
	assert.match(layout, /class="btn btn-primary shrink-0"[^>]*>Logout<\/button>/);
});
