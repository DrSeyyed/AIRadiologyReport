import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';

const read = (name) => readFileSync(new URL(`../src/routes/studies/${name}`, import.meta.url), 'utf8');
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const stub = moduleUrl('export default function Component() {}');

async function component(name) {
	const source = read(name);
	for (const generate of ['client', 'server']) {
		assert.deepEqual(compile(source, { filename: name, generate }).warnings, []);
	}
	const description = name === 'StudyTable.svelte' ? await component('StudyDescription.svelte') : null;
	const code = compile(source, { filename: name, generate: 'server' }).js.code.replace(/from (['"])([^'"]+)\1/g, (_statement, _quote, specifier) => {
		let target;
		if (specifier === './StudyDescription.svelte') target = description.url;
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

test('study text columns wrap long tokens within bounded widths and the table retains local scrolling', () => {
	const source = read('StudyTable.svelte');
	assert.match(source, /w-full min-w-0 max-w-full overflow-x-auto rounded-box border/);
	assert.match(source, /\.study-table td\s*\{[^}]*vertical-align: top;[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
	for (const name of ['study-code-cell', 'study-text-cell', 'study-description-cell']) {
		assert.match(source, new RegExp(`\\.${name}\\s*\\{[^}]*min-width:[^}]*width:[^}]*max-width:`));
	}
	const description = read('StudyDescription.svelte');
	assert.match(description, /-webkit-line-clamp: 3/);
	assert.match(description, /overflow-wrap: anywhere/);
	assert.match(description, /summary:focus-visible/);
	assert.match(description, /\.study-description\[open\] \.description-preview/);
});

test('table preserves study information, sorting, workflow buttons, and role restrictions', async () => {
	const { Component } = await component('StudyTable.svelte');
	const study = {
		id: 1, patient_code: 'SYNTHETIC-CODE-'.repeat(40), patient_fullname: 'Synthetic patient '.repeat(20),
		patient_age: 42, patient_age_unit: 'Y', source_modality: 'SYNTHETIC-MODALITY'.repeat(30),
		source_description: 'Synthetic long reference '.repeat(60), description: 'Fallback reference',
		exam_date_jalali: '1405-08-22', exam_time: '14:00', attending_fullname: 'Synthetic attending '.repeat(20),
		residents: [{ id: 2, full_name: 'Synthetic resident '.repeat(20) }],
		recording_count: 2, report_count: 1, resident_checked_count: 2, attending_checked_count: 0, typist_checked_count: 0
	};
	for (const role of ['admin', 'resident', 'attending', 'typist']) {
		const { body } = render(Component, { props: { data: {
			user: { id: 3, role }, studies: [study], filters: {},
			paging: { orderedby: 's.patient_code', orderdir: 'ASC' }
		} } });
		for (const value of [study.patient_code, study.patient_fullname, study.source_modality, study.source_description, study.attending_fullname, study.residents[0].full_name]) assert.ok(body.includes(value.trim()));
		assert.match(body, /Recordings &amp; reports/);
		assert.match(body, /2 recordings · 1 reports/);
		assert.match(body, /aria-sort="ascending"/);
		assert.match(body, /Sort by Code, descending/);
		assert.equal(body.includes('Edit study'), role !== 'typist');
		assert.equal(body.includes('>Delete<'), role !== 'typist');
		assert.doesNotMatch(body, /Fallback reference/);
	}
});
