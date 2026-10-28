import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { DEFAULT_REPORT_TYPOGRAPHY, validReportSize } from '../src/lib/report-copy.js';

const source = readFileSync(new URL('../src/routes/studies/ReportModal.svelte', import.meta.url), 'utf8');
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;\r?$/gm, '');
const settle = () => new Promise(setImmediate);

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function modal(storage) {
	let mount;
	const run = new Function('dependencies', `
		const { DEFAULT_REPORT_TYPOGRAPHY, validReportSize, reportTypographyStorage, onMount } = dependencies;
		const $state = (value) => value;
		const $derived = (value) => value;
		const $effect = () => {};
		const $props = () => ({ study: {}, recording: {}, user: { id: 7 }, initialText: 'Report' });
		const onDestroy = () => {};
		const reportTitle = () => 'Report';
		const renderReportMarkdown = (value) => value;
		const DOMPurify = { sanitize: (value) => value };
		${script}
		return {
			snapshot: () => ({ font, fontSize, typographyLoading, typographySaving, typographyError }),
			change: (nextFont, nextSize) => { font = nextFont; fontSize = nextSize; return saveTypography(); }
		};
	`);
	const instance = run({ DEFAULT_REPORT_TYPOGRAPHY, validReportSize,
		reportTypographyStorage: storage, onMount: (callback) => { mount = callback; } });
	return { ...instance, mount: () => mount() };
}

test('report modal compiles accessibly and uses shared persisted typography for preview and export', () => {
	const result = compile(source, { filename: 'ReportModal.svelte', generate: 'client' });
	assert.deepEqual(result.warnings.filter(({ code }) => code.startsWith('a11y')), []);
	assert.match(source, /value=\{font\} disabled=\{typographyLoading\}/);
	assert.match(source, /value=\{fontSize\} disabled=\{typographyLoading\}/);
	assert.match(source, /const canExport = \$derived\(!state.loading && !typographyLoading/);
	assert.match(source, /font = event.currentTarget.value; clearCopyStatus\(\); saveTypography\(\);/);
	assert.match(source, /fontSize = event.currentTarget.value; clearCopyStatus\(\); saveTypography\(\);/);
	assert.match(source, /reportTypography\(font, fontSize\)/);
	assert.match(source, /font,\s+size: fontSize/);
});

test('modal starts at Times New Roman 11.0, loads account settings without saving and blocks early changes', async () => {
	const loaded = deferred();
	const saves = [];
	const instance = modal({ load: (id) => { assert.equal(id, 7); return loaded.promise; }, save: (...args) => saves.push(args) });
	assert.deepEqual(instance.snapshot(), { font: 'Times New Roman', fontSize: '11.0', typographyLoading: true, typographySaving: false, typographyError: '' });
	instance.mount();
	await instance.change('Arial', '12.0');
	assert.deepEqual(saves, []);
	loaded.resolve({ font: 'Cambria', size: 14.5 });
	await settle();
	assert.deepEqual(instance.snapshot(), { font: 'Cambria', fontSize: '14.5', typographyLoading: false, typographySaving: false, typographyError: '' });
	assert.deepEqual(saves, []);
	await instance.change('Georgia', '13.0');
	assert.deepEqual(saves, [[7, { font: 'Georgia', size: 13 }]]);
});

test('whole-number preferences retain one displayed decimal and incomplete size edits are not saved', async () => {
	let saves = 0;
	const instance = modal({ load: async () => ({ font: 'Times New Roman', size: 11 }), save: async () => { saves++; } });
	instance.mount();
	await settle();
	assert.equal(instance.snapshot().fontSize, '11.0');
	for (const size of ['', ' ', '5', '73', 'invalid']) await instance.change('Arial', size);
	assert.equal(saves, 0);
});

test('failed preference load keeps defaults visible and permits an intentional valid retry', async () => {
	let saved;
	const instance = modal({ load: async () => { throw new Error('Network unavailable'); }, save: async (_id, value) => { saved = value; } });
	instance.mount();
	await settle();
	assert.equal(instance.snapshot().font, 'Times New Roman');
	assert.equal(instance.snapshot().fontSize, '11.0');
	assert.equal(instance.snapshot().typographyLoading, false);
	assert.match(instance.snapshot().typographyError, /Unable to load/);
	await instance.change('Calibri', '12.5');
	assert.deepEqual(saved, { font: 'Calibri', size: 12.5 });
	assert.equal(instance.snapshot().typographyError, '');
});

test('late preference loads do not update a closed modal', async () => {
	const loaded = deferred();
	const instance = modal({ load: () => loaded.promise });
	const close = instance.mount();
	close();
	loaded.resolve({ font: 'Arial', size: 18 });
	await settle();
	assert.equal(instance.snapshot().font, 'Times New Roman');
	assert.equal(instance.snapshot().fontSize, '11.0');
});

test('only the newest save controls the saving status and visible retry error', async () => {
	const first = deferred();
	const last = deferred();
	let count = 0;
	const instance = modal({ load: async () => DEFAULT_REPORT_TYPOGRAPHY, save: () => ++count === 1 ? first.promise : last.promise });
	instance.mount();
	await settle();
	const initialChange = instance.change('Arial', '12.0');
	const latestChange = instance.change('Georgia', '13.5');
	assert.equal(instance.snapshot().typographySaving, true);
	first.reject(new Error('Old save failed'));
	await initialChange;
	assert.equal(instance.snapshot().typographySaving, true);
	assert.equal(instance.snapshot().typographyError, '');
	last.reject(new Error('Current save failed'));
	await latestChange;
	assert.equal(instance.snapshot().typographySaving, false);
	assert.match(instance.snapshot().typographyError, /Unable to save/);
});
