import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSearchOptions } from '../src/lib/search-options.js';

const options = [
	{ id: 1, code: 'MRCP', name: 'Magnetic resonance cholangiopancreatography' },
	{ id: 2, code: 'BRAIN-WO', name: 'Brain without contrast' },
	{ id: 3, code: 'BRAIN-WC', name: 'Brain with contrast' },
	{ id: 4, code: 'CT', name: 'Computed tomography' }
];

test('search matches partial codes case-insensitively and trims surrounding whitespace', () => {
	assert.deepEqual(filterSearchOptions(options, '  mRc '), [options[0]]);
	assert.deepEqual(filterSearchOptions(options, 'rain-'), options.slice(1, 3));
});

test('search matches any part of the name and preserves source order', () => {
	assert.deepEqual(filterSearchOptions(options, 'contrast'), options.slice(1, 3));
	assert.deepEqual(filterSearchOptions(options, 'TOMOGRAPHY'), [options[3]]);
});

test('empty search restores all options and no matches returns an empty list', () => {
	assert.deepEqual(filterSearchOptions(options, ''), options);
	assert.deepEqual(filterSearchOptions(options, '  '), options);
	assert.deepEqual(filterSearchOptions(options, 'unknown'), []);
	assert.deepEqual(filterSearchOptions([], 'mrc'), []);
});

test('search treats punctuation literally and does not mutate options', () => {
	const snapshot = structuredClone(options);
	assert.deepEqual(filterSearchOptions(options, '.*'), []);
	assert.deepEqual(filterSearchOptions(options, '['), []);
	assert.deepEqual(options, snapshot);
});

test('search tolerates missing labels and supports Unicode names', () => {
	const items = [{ id: 1, name: 'شکم' }, { id: 2, code: 'MR' }, { id: 3 }];
	assert.deepEqual(filterSearchOptions(items, 'شک'), [items[0]]);
	assert.deepEqual(filterSearchOptions(items, 'mr'), [items[1]]);
});
