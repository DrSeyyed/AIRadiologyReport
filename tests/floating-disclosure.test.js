import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { floatingPosition } from '../src/lib/floating-disclosure.js';

const viewport = { width: 1000, height: 800 };

test('floating panels open below their anchor when there is room', () => {
	assert.deepEqual(floatingPosition({ left: 100, top: 200, bottom: 230 }, { width: 200, height: 150 }, viewport), { left: 100, top: 234, maxHeight: 784 });
});

test('floating panels flip above the anchor near the bottom and stay inside the viewport', () => {
	assert.deepEqual(floatingPosition({ left: 900, top: 700, bottom: 730 }, { width: 200, height: 150 }, viewport), { left: 792, top: 546, maxHeight: 784 });
	assert.deepEqual(floatingPosition({ left: -50, top: 100, bottom: 130 }, { width: 200, height: 150 }, viewport).left, 8);
});

test('floating panels taller than the space on either side are clamped and scroll', () => {
	assert.deepEqual(floatingPosition({ left: 10, top: 300, bottom: 330 }, { width: 200, height: 2000 }, viewport), { left: 10, top: 8, maxHeight: 784 });
});

test('worklist sort, attention and more-actions menus float instead of expanding table rows', () => {
	const source = readFileSync(new URL('../src/routes/studies/StudyTable.svelte', import.meta.url), 'utf8');
	for (const name of ['column-sort', 'attention-disclosure', 'more-actions']) assert.match(source, new RegExp(`<details class="${name}" use:floatingDisclosure>`));
	for (const name of ['sort-options', 'attention-editor', 'action-list']) assert.match(source, new RegExp(`<div class="${name} floating-panel" data-floating-panel>`));
	assert.match(source, /\.floating-panel \{ position: fixed; z-index: 35;/);
});
