import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
		declarations('.bg-slate-50', 'background-color').some((value) => value.startsWith('rgb(248 250 252'))
	);
	assert.ok(declarations('html', 'background-color').some((value) => value.startsWith('rgb(')));
	assert.ok(
		declarations("html[data-theme='light']", 'background-color').some((value) =>
			value.startsWith('rgb(')
		)
	);
	assert.ok(declarations('body', 'background-color').some((value) => value.startsWith('rgb(')));
	for (const selector of ['html', "html[data-theme='light']", 'body']) {
		assert.ok(declarations(selector, 'background-color').some((value) => value.startsWith('rgb(248 250 252')));
	}
	const layout = readFileSync(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
	assert.match(layout, /class="drawer [^"]*bg-slate-50"/);
	assert.doesNotMatch(layout + source, /bg-green-100/);
	assert.doesNotMatch(layout, /bg-blue-100/);
	assert.match(layout, /<header class="[^"]*border-slate-200 bg-white[^"]*shadow-sm"/);
	assert.match(layout, /<ul class="menu [^"]*bg-white/);
	assert.deepEqual(declarations('body', 'font-size'), ['var(--app-font-size)']);
	assert.equal(declarations('body', 'line-height').at(-1), '1.5');
	assert.ok(declarations('body', 'font-family').some((value) => value.includes('system-ui') && value.includes('Tahoma')));
	assert.deepEqual(declarations('.page-title.page-title', 'font-size'), ['var(--page-title-size)']);
	assert.deepEqual(declarations('.page-title.page-title', 'font-weight'), ['600']);
	assert.deepEqual(declarations('.section-title.section-title', 'font-size'), ['var(--section-title-size)']);
	assert.deepEqual(declarations('.section-title.section-title', 'font-weight'), ['600']);
	assert.ok(declarations('.min-w-0', 'min-width').includes('0px'));
	assert.ok(declarations('.overflow-x-auto', 'overflow-x').includes('auto'));
	assert.ok(declarations('main', 'overflow-wrap').includes('anywhere'));
	assert.ok(declarations('.sticky', 'position').includes('sticky'));
	assert.ok(declarations('.top-0', 'top').includes('0px'));
	assert.ok(declarations('.z-30', 'z-index').includes('30'));
	assert.ok(declarations('.z-40', 'z-index').includes('40'));
	assert.deepEqual(declarations('select.select', 'line-height'), ['1.5']);
	assert.deepEqual(declarations('select.select', 'padding-top'), ['0']);
	assert.deepEqual(declarations('select.select', 'padding-bottom'), ['0']);
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

test('favorites and statistics align to the shared content edge without extra page padding', () => {
	for (const path of ['../src/routes/favorites/+page.svelte', '../src/lib/components/StudyStatistics.svelte']) {
		const source = readFileSync(new URL(path, import.meta.url), 'utf8');
		const section = source.match(/<section class="([^"]+)"/)?.[1];
		assert.ok(section);
		assert.match(section, /\bw-full\b/);
		assert.match(section, /\bmin-w-0\b/);
		assert.doesNotMatch(section, /\bmx-auto\b|\bp-\d+\b/);
	}
});

test('route page headings use the shared title style and admin containers stay left aligned', () => {
	function checkPages(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
			if (entry.isDirectory()) checkPages(path);
			else if (entry.name === '+page.svelte') {
				const source = readFileSync(path, 'utf8');
				for (const heading of source.matchAll(/<h1\b[^>]*>/g)) {
					assert.match(heading[0], /class="[^"]*\bpage-title\b/, path.pathname);
				}
			}
		}
	}
	checkPages(new URL('../src/routes/', import.meta.url));
	for (const path of ['../src/routes/admin/+layout.svelte', '../src/routes/admin/storage/+page.svelte']) {
		assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), 'utf8'), /\bmx-auto\b/);
	}
});

test('patient names match compact study text without clipping or shrinking the worklist', () => {
	const styles = componentDeclarations('StudyTable.svelte', '.patient-name');
	assert.equal(styles.get('font-size'), '0.8125rem');
	assert.equal(styles.get('font-weight'), '600');
	assert.equal(styles.get('line-height'), '1.5');
	assert.notEqual(styles.get('white-space'), 'nowrap');
	assert.notEqual(styles.get('overflow'), 'hidden');
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

test('recording configuration aligns control bottoms when selector labels wrap', () => {
	const styles = componentDeclarations('RecordingCard.svelte', '.configuration-fields');
	assert.equal(styles.get('align-items'), 'end');
});

test('study favorite buttons keep complete labels on one line inside the scrolling table', () => {
	const styles = componentDeclarations('StudyFavorite.svelte', 'button');
	assert.equal(styles.get('white-space'), 'nowrap');
	assert.equal(styles.get('width'), 'max-content');
});

test('disabled study badges stay intact instead of wrapping into mobile table columns', () => {
	const styles = componentDeclarations('StudyTable.svelte', '.disabled-badge');
	assert.equal(styles.get('white-space'), 'nowrap');
	assert.equal(styles.get('overflow-wrap'), 'normal');
	assert.equal(styles.get('width'), 'max-content');
	assert.equal(styles.get('flex-shrink'), '0');
});

test('favorite category containers and fields can shrink within narrow mobile boxes', () => {
	for (const element of ['section', 'form', 'label', 'input']) {
		const styles = componentDeclarations('FavoriteCategories.svelte', element);
		assert.equal(styles.get('min-width'), '0');
		assert.equal(styles.get('max-width'), '100%');
	}
	assert.equal(componentDeclarations('FavoriteCategories.svelte', 'input').get('width'), '100%');
});
