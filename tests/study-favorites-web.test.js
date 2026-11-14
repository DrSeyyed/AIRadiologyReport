import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { filterSearchOptions } from '../src/lib/search-options.js';

const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const root = new URL('../src/', import.meta.url);
const cache = new Map();
function component(relativePath) {
	if (cache.has(relativePath)) return cache.get(relativePath);
	const file = new URL(relativePath, root);
	const source = readFileSync(file, 'utf8');
	for (const generate of ['client', 'server']) {
		assert.deepEqual(compile(source, { filename: file.pathname, generate }).warnings, []);
	}
	const code = compile(source, { filename: file.pathname, generate: 'server' }).js.code.replace(/from (['"])([^'"]+)\1/g, (_statement, _quote, specifier) => {
		let target;
		if (specifier === '$app/paths') target = moduleUrl('export const resolve = (path) => path;');
		else if (specifier === '$app/navigation') target = moduleUrl('export async function invalidateAll() {}');
		else if (specifier.endsWith('.svelte')) {
			const path = specifier.startsWith('$lib/') ? `lib/${specifier.slice(5)}` : new URL(specifier, file).href.slice(root.href.length);
			target = component(path);
		} else if (specifier.startsWith('$lib/')) target = new URL(`lib/${specifier.slice(5)}`, root).href;
		else target = import.meta.resolve(specifier);
		return `from ${JSON.stringify(target)}`;
	});
	const result = moduleUrl(code);
	cache.set(relativePath, result);
	return result;
}

async function markup(path, props) {
	const Component = (await import(component(path))).default;
	return render(Component, { props }).body;
}

test('dedicated favorites page renders expanded management and navigation without worklist filter data', async () => {
	const body = await markup('routes/favorites/+page.svelte', { data: { favorites: {
		total: 2, categories: [{ id: 7, name: '<Synthetic category>', total: 1 }, { id: 8, name: '', total: 0 }]
	} } });
	assert.match(body, /My study favorites/);
	assert.match(body, /Back to studies/);
	assert.match(body, /href="\/studies"/);
	assert.match(body, /\/studies\?favorites=all/);
	assert.match(body, /\/studies\?favorites=7/);
	assert.match(body, /Rename/);
	assert.match(body, /Delete category/);
	assert.match(body, /Add category/);
	assert.match(body, /Unnamed category #8/);
	assert.match(body, /&lt;Synthetic category(?:>|&gt;)/);
	assert.doesNotMatch(body, /<details|<Synthetic category>/);
});

test('modal retains the study/categories contract and exposes searchable additive selection and creation', async () => {
	const body = await markup('routes/studies/FavoriteStudyModal.svelte', {
		study: { id: 1, patient_code: 'SYNTHETIC', favorite_category_ids: [7, 8] },
		categories: [{ id: 7, name: 'Teaching' }, { id: 8, name: '' }, { id: 9, name: 'Rare cases' }],
		onClose() {}, onSaved() {}
	});
	assert.match(body, /<dialog[^>]+aria-modal="true"[^>]+aria-labelledby="favorite-study-title"/);
	assert.match(body, /role="combobox"/);
	assert.match(body, /Find a saved category/);
	assert.match(body, /Type to search categories/);
	assert.match(body, /aria-label="Selected categories"/);
	assert.match(body, /Remove Teaching from this study/);
	assert.match(body, /Remove Unnamed category #8 from this study/);
	assert.match(body, /Create and select category/);
	assert.match(body, /Save favorite/);
	assert.match(body, /href="\/favorites"/);
	assert.doesNotMatch(body, /This study will be saved|Type a few letters|Selected categories stay visible|New categories are created immediately|Save favorite to apply/);
	assert.match(body, /role="status"/);
});

test('empty favorites states allow saving without categories and creating the first optional-name category', async () => {
	const body = await markup('routes/studies/FavoriteStudyModal.svelte', {
		study: { id: 1 }, categories: [], onClose() {}, onSaved() {}
	});
	assert.match(body, /No categories selected\./);
	assert.doesNotMatch(body, /No categories yet|The study will still be saved/);
	assert.match(body, /New category name \(optional\)/);
	assert.match(body, /Save favorite/);
	const management = await markup('routes/studies/FavoriteCategories.svelte', { data: { favorites: { total: 0, categories: [] } } });
	assert.match(management, /No categories yet/);
});

test('saved category search supports partial, case-insensitive, and Unicode names', () => {
	const options = [{ id: 1, name: 'Teaching' }, { id: 2, name: 'Rare cases' }, { id: 3, name: 'آموزش' }, { id: 4, name: 'Unnamed category #4' }];
	assert.deepEqual(filterSearchOptions(options, ' tea '), [options[0]]);
	assert.deepEqual(filterSearchOptions(options, 'CASE'), [options[1]]);
	assert.deepEqual(filterSearchOptions(options, 'آمو'), [options[2]]);
	assert.deepEqual(filterSearchOptions(options, '#4'), [options[3]]);
	assert.deepEqual(filterSearchOptions(options, 'no match'), []);
});
