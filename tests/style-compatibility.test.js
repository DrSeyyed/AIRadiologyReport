import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import config from '../tailwind.config.js';
import { compile } from 'svelte/compiler';

test('stylesheet generates legacy-compatible colors and contained page layout utilities', async () => {
	const source = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
	const { root } = await postcss([tailwindcss(config), autoprefixer]).process(source, {
		from: undefined
	});
	const rules = [];
	root.walkRules((rule) => rules.push(rule));
	const declarations = (selector, property) =>
		rules
			.filter((rule) => rule.selector.split(',').some((part) => part.trim() === selector))
			.flatMap((rule) =>
				rule.nodes
					.filter((node) => node.type === 'decl' && node.prop === property)
					.map((node) => node.value)
			);
	assert.ok(
		declarations('.bg-green-100', 'background-color').some((value) => value.startsWith('rgb('))
	);
	assert.ok(declarations('html', 'background-color').some((value) => value.startsWith('rgb(')));
	assert.ok(
		declarations("html[data-theme='light']", 'background-color').some((value) =>
			value.startsWith('rgb(')
		)
	);
	assert.ok(declarations('body', 'background-color').some((value) => value.startsWith('rgb(')));
	assert.ok(declarations('.min-w-0', 'min-width').includes('0px'));
	assert.ok(declarations('.overflow-x-auto', 'overflow-x').includes('auto'));
	assert.ok(declarations('main', 'overflow-wrap').includes('anywhere'));
	assert.ok(
		declarations('.btn-primary', '--btn-color').some((value) => value.includes('--fallback-p'))
	);
	assert.ok(declarations("html[data-theme='light']", '--fallback-p').includes('#570df8'));
	assert.ok(declarations("html[data-theme='light']", '--fallback-b1').includes('#ffffff'));
	root.walkAtRules((rule) =>
		assert.ok(
			!['layer', 'property', 'theme', 'plugin', 'tailwind'].includes(rule.name),
			`Uncompiled or unsupported CSS rule: @${rule.name}`
		)
	);
});

function componentDeclarations(filename, element) {
	const source = readFileSync(new URL(`../src/routes/studies/${filename}`, import.meta.url), 'utf8');
	const { css } = compile(source, { filename, generate: 'server' });
	const declarations = new Map();
	postcss.parse(css.code).walkRules(rule => {
		if (rule.selector.split(',').some(selector => selector.trim().startsWith(`${element}.`)))
			rule.walkDecls(declaration => declarations.set(declaration.prop, declaration.value));
	});
	return declarations;
}

test('study filter fields share centered text metrics instead of oversized select-sm line heights', () => {
	for (const element of ['input', 'select']) {
		const styles = componentDeclarations('Filters.svelte', element);
		assert.equal(styles.get('height'), '2.25rem');
		assert.equal(styles.get('line-height'), '1.5');
		assert.equal(styles.get('padding-top'), '0');
		assert.equal(styles.get('padding-bottom'), '0');
		assert.equal(styles.get('width'), '100%');
		assert.equal(styles.get('min-width'), '0');
		assert.equal(styles.get('max-width'), '100%');
	}
	assert.equal(componentDeclarations('Filters.svelte', 'label').get('max-width'), '100%');
});

test('favorite category containers and fields can shrink within narrow mobile boxes', () => {
	for (const element of ['details', 'form', 'label', 'input']) {
		const styles = componentDeclarations('FavoriteCategories.svelte', element);
		assert.equal(styles.get('min-width'), '0');
		assert.equal(styles.get('max-width'), '100%');
	}
	assert.equal(componentDeclarations('FavoriteCategories.svelte', 'input').get('width'), '100%');
});
