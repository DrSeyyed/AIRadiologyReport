import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import config from '../tailwind.config.js';

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
