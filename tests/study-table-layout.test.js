import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import postcss from 'postcss';

const read = (name) => readFileSync(new URL(`../src/routes/studies/${name}`, import.meta.url), 'utf8');
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const stub = moduleUrl('export default function Component() {}');

async function component(name) {
	const source = read(name);
	for (const generate of ['client', 'server']) {
		assert.deepEqual(compile(source, { filename: name, generate }).warnings, []);
	}
	const children = {};
	if (name === 'StudyTable.svelte') {
		for (const child of ['StudyDescription.svelte', 'StudyFavorite.svelte', 'StudyAttention.svelte', 'PacsViewer.svelte']) children[`./${child}`] = await component(child);
	}
	const code = compile(source, { filename: name, generate: 'server' }).js.code.replace(/from (['"])([^'"]+)\1/g, (_statement, _quote, specifier) => {
		let target;
		if (children[specifier]) target = children[specifier].url;
		else if (specifier.endsWith('.svelte')) target = stub;
		else if (specifier === '$app/navigation') target = moduleUrl('export async function invalidateAll() {}');
		else if (specifier === '$app/paths') target = moduleUrl('export const resolve = (path) => path;');
		else if (specifier === '$app/state') target = moduleUrl("export const page = { url: new URL('http://localhost/studies') };");
		else if (specifier.startsWith('$lib/')) target = new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url).href;
		else target = import.meta.resolve(specifier);
		return `from ${JSON.stringify(target)}`;
	});
	const url = moduleUrl(code);
	return { Component: (await import(url)).default, url };
}

test('short and empty study descriptions stay compact without disclosure controls', async () => {
	const { Component } = await component('StudyDescription.svelte');
	for (const text of ['Synthetic reference', 'شرح آزمایشی', '-']) {
		const { body } = render(Component, { props: { text } });
		assert.ok(body.includes(text));
		assert.doesNotMatch(body, /<details|<summary/);
		assert.match(body, /dir="auto"/);
	}
	assert.ok(render(Component).body.includes('-'));
});

test('long and multiline descriptions have a collapsed preview and retain escaped full text', async () => {
	const { Component } = await component('StudyDescription.svelte');
	for (const text of ['Synthetic'.repeat(100), 'First line\nSecond line', '<b>Synthetic</b>'.repeat(30)]) {
		const { body } = render(Component, { props: { text } });
		assert.match(body, /<details[^>]*>/);
		assert.doesNotMatch(body, /<details[^>]*\bopen\b/);
		assert.match(body, /<summary\b[^>]*>/);
		assert.match(body, /Show full description/);
		assert.match(body, /Hide full description/);
		assert.match(body, /class="description-full/);
		assert.doesNotMatch(body, /<b>Synthetic<\/b>/);
		if (!text.includes('<')) assert.ok(body.includes(text));
	}
});

test('five grouped columns have fixed proportions, wrapped content and keyboard-accessible local scrolling', () => {
	const source = read('StudyTable.svelte');
	assert.match(source, /study-table-scroll w-full min-w-0 max-w-full overflow-x-auto/);
	assert.match(source, /role="region"[^>]*tabindex="0"/);
	assert.match(source, /\.study-table\s*\{[^}]*min-width: 66rem;[^}]*table-layout: fixed;/);
	assert.match(source, /\.study-table td\s*\{[^}]*vertical-align: top;[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
	for (const name of ['patient', 'examination', 'team', 'reporting', 'actions']) assert.match(source, new RegExp(`\\.${name}-column\\s*\\{ width: \\d+%;`));
	for (const name of ['StudyAttention.svelte', 'PacsViewer.svelte']) {
		assert.match(read(name), /w-full min-w-0/);
		assert.doesNotMatch(read(name), /min-w-48|min-w-\[13rem\]/);
	}
	const description = read('StudyDescription.svelte');
	assert.match(description, /-webkit-line-clamp: 3/);
	assert.match(description, /overflow-wrap: anywhere/);
	assert.match(description, /summary:focus-visible/);
	assert.match(description, /\.study-description\[open\] \.description-preview/);
});

test('overflow controls follow actual table size instead of a mobile-only breakpoint', () => {
	const source = read('StudyTable.svelte');
	assert.match(source, /new ResizeObserver\(updateTableScroll\)/);
	assert.match(source, /observer\.observe\(tableScroll\)/);
	assert.match(source, /observer\.observe\(tableElement\)/);
	assert.match(source, /observer\.disconnect\(\)/);
	assert.match(source, /tableScroll\.scrollWidth - tableScroll\.clientWidth/);
	assert.match(source, /\{#if tableOverflows\}/);
	for (const direction of ['left', 'right']) assert.match(source, new RegExp(`aria-label="Scroll table ${direction}" aria-controls="study-worklist-table" disabled=\\{!canScroll${direction === 'left' ? 'Left' : 'Right'}\\}`));
	assert.match(source, /onscroll=\{updateTableScroll\}/);
	assert.match(source, /scrollBy\(/);
	assert.doesNotMatch(source, /max-width: 1150px|table-scroll-hint/);
	assert.match(source, /\.examination-column\s*\{ width: 19%;/);
	assert.match(source, /\.actions-column\s*\{ width: 23%;/);
	assert.match(source, /\.row-actions\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
	assert.match(source, /\.report-button\s*\{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*white-space: normal;/);
});

test('row actions share compact button sizing and the reports button fits its label instead of filling the column', () => {
	const source = read('StudyTable.svelte');
	const { css } = compile(source, { filename: 'StudyTable.svelte', generate: 'server' });
	const rules = [];
	postcss.parse(css.code).walkRules(rule => rules.push(rule));
	const styles = (selector) => new Map(rules.find(rule => rule.selector.startsWith(selector)).nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]));
	const report = styles('.report-button.');
	assert.equal(report.get('width'), 'fit-content');
	assert.equal(report.get('min-width'), '0');
	assert.equal(report.get('max-width'), '100%');
	const shared = new Map(rules.find(rule => rule.selector.startsWith('.row-actions.') && rule.selector.endsWith(' .btn')).nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]));
	assert.equal(shared.get('min-height'), '2rem');
	assert.equal(shared.get('border-radius'), '0.375rem');
	assert.equal(shared.get('font-size'), '0.6875rem');
	assert.match(source, /class="btn btn-xs btn-primary report-button"/);
	assert.match(source, /<summary class="btn btn-xs btn-ghost"[^>]*>More actions<\/summary>/);
	assert.match(source, /class="btn btn-xs btn-ghost action-button"/);
	assert.match(source, /class="btn btn-xs btn-error action-button"/);
	assert.doesNotMatch(source, /\.delete-action|\.action-button:hover|\.action-button:disabled/);
});

test('filter fields have visible borders including searchable selectors, with favorites managed outside the filter disclosure', async () => {
	await component('Filters.svelte');
	const filters = read('Filters.svelte');
	assert.match(filters, /class="study-filters flex flex-wrap items-end gap-3"/);
	assert.match(filters, /\.study-filters :global\(\.input\),\s*\.study-filters :global\(\.select\)\s*\{\s*border: 1px solid #cbd5e1;/);
	assert.match(filters, /\.study-filters :global\(\.input:focus\),\s*\.study-filters :global\(\.select:focus\)\s*\{\s*border-color: #6366f1;/);
	assert.match(read('StudyTable.svelte'), /class="worklist-section-content filter-content"><Filters \{data\} \/><\/div>\s*<\/details>\s*<div class="worklist-favorites"><FavoriteCategories \{data\} \/><\/div>/);
});

test('filters and favorite management use the same disclosure typography, borders and spacing', () => {
	const table = read('StudyTable.svelte');
	const favorites = read('FavoriteCategories.svelte');
	assert.match(table, /<details class="worklist-section worklist-filters">/);
	assert.match(favorites, /<details class="worklist-section">\s*<summary>/);
	for (const source of [table, favorites]) assert.match(source, /class="worklist-section-content\b/);
	assert.match(table, /:global\(\.worklist-section\)\s*\{ border-top: 1px solid #e2e8f0;/);
	assert.match(table, /:global\(\.worklist-section > summary\)\s*\{ padding: 0\.875rem 1\.5rem; font-size: 0\.8125rem; font-weight: 600;/);
	assert.doesNotMatch(favorites, /rounded-box border p-3|cursor-pointer font-semibold/);
	for (const generate of ['client', 'server']) assert.deepEqual(compile(favorites, { filename: 'FavoriteCategories.svelte', generate }).warnings, []);
});

test('table preserves study information, sorting, workflow buttons, and role restrictions', async () => {
	const { Component } = await component('StudyTable.svelte');
	const study = {
		id: 1, study_key: 'synthetic key', patient_code: 'SYNTHETIC-CODE-'.repeat(40), patient_fullname: 'Synthetic patient '.repeat(20),
		patient_age: 42, patient_age_unit: 'Y', source_modality: 'SYNTHETIC-MODALITY'.repeat(30),
		source_description: 'Synthetic long reference '.repeat(60), description: 'Fallback reference',
		exam_date_jalali: '1405-08-22', exam_time: '14:00', attending_fullname: 'Synthetic attending '.repeat(20),
		residents: [{ id: 2, full_name: 'Synthetic resident '.repeat(20) }],
		recording_count: 2, report_count: 1, resident_checked_count: 2, attending_checked_count: 0, typist_checked_count: 0
	};
	for (const role of ['admin', 'resident', 'attending', 'typist']) {
		const { body } = render(Component, { props: { data: {
			user: { id: 3, role }, studies: [study], filters: {},
			paging: { orderedby: 's.patient_code', orderdir: 'ASC' },
			pacsViewerUrl: 'https://pacs.example/view?key={studyKey}'
		} } });
		for (const value of [study.patient_code, study.patient_fullname, study.source_modality, study.source_description, study.attending_fullname, study.residents[0].full_name]) assert.ok(body.includes(value.trim()));
		assert.match(body, /Recordings &amp; reports/);
		assert.equal((body.match(/<th\b/g) || []).length, 5);
		assert.equal((body.match(/<td\b/g) || []).length, 5);
		for (const label of ['Patient', 'Examination', 'Review team', 'Reporting', 'Actions']) assert.ok(body.includes(label));
		assert.match(body, /Resident signatures: 2 of 2/);
		assert.match(body, /Attending signatures: 0 of 2/);
		assert.match(body, /Typist signatures: 0 of 2/);
		assert.match(body, /href="https:\/\/pacs.example\/view\?key=synthetic%20key"/);
		assert.match(body, /More actions/);
		assert.match(body, /Favorite categories/);
		assert.match(body, /Filters &amp; sorting/);
		assert.match(body, /aria-sort="ascending"/);
		assert.match(body, /Sort by Code, descending/);
		assert.equal(body.includes('Edit study'), role !== 'typist');
		assert.equal(body.includes('>Delete<'), role !== 'typist');
		assert.doesNotMatch(body, /Fallback reference/);
	}
});

test('grouped header sorting retains all fourteen fields and only the active group has aria-sort', async () => {
	const { Component } = await component('StudyTable.svelte');
	const keys = ['s.patient_code', 's.patient_fullname', 's.patient_age', 's.exam_date_jalali', 'source_modality', 'source_description', 'attending_fullname', 'residents', 'recording_count', 'report_count', 'resident_checked_count', 'attending_checked_count', 'typist_checked_count', 'is_favorite'];
	for (const orderedby of keys) {
		const { body } = render(Component, { props: { data: { user: { id: 1, role: 'admin' }, studies: [], filters: {}, paging: { orderedby, orderdir: 'DESC', total: 0 } } } });
		assert.equal((body.match(/aria-sort="descending"/g) || []).length, 1);
		for (const key of keys) assert.ok(body.includes(`orderedby=${encodeURIComponent(key)}`));
		assert.match(body, /colspan="5"/);
		assert.match(body, /No studies found/);
	}
});

test('zero-recording and disabled states retain accurate badges, signatures and protected controls', async () => {
	const { Component } = await component('StudyTable.svelte');
	for (const disabled of [0, 1]) {
		const { body } = render(Component, { props: { data: {
			user: { id: 2, role: 'resident' }, studies: [{ id: 1, disabled, patient_code: 'SYNTHETIC', residents: [], attention_note: 'Synthetic retained note' }], filters: {},
			paging: { orderedby: 's.exam_date_jalali', orderdir: 'DESC' }
		} } });
		assert.match(body, new RegExp(`data-study-status="${disabled ? 'disabled' : 'no-recording'}"`));
		assert.match(body, /Resident signatures: 0 of 0/);
		assert.doesNotMatch(body, /class="[^"]*signature-complete/);
		assert.match(body, /Synthetic retained note/);
		assert.equal(/<button[^>]*disabled[^>]*>Edit study/.test(body), Boolean(disabled));
		assert.match(body, disabled ? /Retry deletion/ : />Delete</);
		assert.doesNotMatch(body, /<details[^>]*\bopen\b/);
	}
});

test('compact favorite is accessible and category management remains available in the full variant', async () => {
	const { Component } = await component('StudyFavorite.svelte');
	for (const compact of [false, true]) {
		for (const is_favorite of [false, true]) {
			const { body } = render(Component, { props: { study: { patient_code: 'SYNTHETIC', is_favorite, favorite_category_ids: [1] }, compact, onCategories() {} } });
			assert.match(body, new RegExp(`aria-pressed="${is_favorite}"`));
			assert.match(body, new RegExp(`aria-label="${is_favorite ? 'Remove' : 'Add'} SYNTHETIC`));
			assert.equal(body.includes('Categories'), !compact);
		}
	}
});
