import test from 'node:test';
import assert from 'node:assert/strict';
import { reportFonts, reportTypography, validReportSize, copyFormattedReport } from '../src/lib/report-copy.js';

const report = { html: '<div style="font-family:Times New Roman;font-size:12pt">Report</div>', text: 'Report' };

function legacyEnvironment({ commandResult = true, dispatch = true } = {}) {
	const data = new Map();
	const original = { cloneRange: () => original };
	const ranges = [original];
	let listener;
	let removed = false;
	let focused = false;
	let selection;
	const field = { selectionStart: 2, selectionEnd: 5, selectionDirection: 'forward', focus: () => { focused = true; }, setSelectionRange: (...values) => { selection = values; } };
	const target = { style: {}, focus() {}, remove: () => { removed = true; } };
	const document = {
		activeElement: field,
		body: { appendChild: (node) => assert.equal(node, target) },
		createElement: () => target,
		createRange: () => ({ selectNodeContents: (node) => assert.equal(node, target) }),
		getSelection: () => ({ rangeCount: 1, getRangeAt: () => original, removeAllRanges: () => { ranges.length = 0; }, addRange: (range) => ranges.push(range) }),
		addEventListener: (event, callback) => { assert.equal(event, 'copy'); listener = callback; },
		removeEventListener: (event, callback) => { assert.equal(callback, listener); listener = null; },
		execCommand: (command) => {
			assert.equal(command, 'copy');
			if (dispatch) listener({ clipboardData: { setData: (type, value) => data.set(type, value) }, preventDefault() {} });
			return commandResult;
		}
	};
	return { environment: { document }, data, assertRestored() {
		assert.ok(removed);
		assert.ok(focused);
		assert.equal(listener, null);
		assert.deepEqual(selection, [2, 5, 'forward']);
		assert.deepEqual(ranges, [original]);
	} };
}

test('report typography defaults to Arial 12.0 pt and uses selected values', () => {
	assert.deepEqual(reportTypography(), { fontFamily: 'Arial, sans-serif', fontSize: '12pt' });
	assert.deepEqual(reportTypography('Arial', '14.5'), { fontFamily: 'Arial, sans-serif', fontSize: '14.5pt' });
	assert.deepEqual(reportTypography('Times New Roman', '12.0'), { fontFamily: '"Times New Roman", Times, serif', fontSize: '12pt' });
	assert.equal(new Set(reportFonts.map(({ name }) => name)).size, reportFonts.length);
});

test('invalid font and size cannot inject CSS and fall back safely', () => {
	for (const size of ['', ' ', 'abc', 'NaN', Infinity, -1, 0, 5.9, 72.1, '12;display:none']) {
		assert.equal(validReportSize(size), false);
		assert.equal(reportTypography('Arial', size).fontSize, '12pt');
	}
	for (const size of [6, '12.0', 14.5, 72]) assert.equal(validReportSize(size), true);
	assert.equal(reportTypography('Arial; background:url(example.invalid)').fontFamily, reportFonts[0].family);
});

test('modern clipboard receives HTML formatting and plain text in the same item', async () => {
	let items;
	class ClipboardItem { constructor(data) { this.data = data; } }
	await copyFormattedReport(report, { navigator: { clipboard: { write: async (value) => { items = value; } } }, ClipboardItem, Blob });
	assert.equal(items.length, 1);
	assert.equal(items[0].data['text/html'].type, 'text/html');
	assert.equal(await items[0].data['text/html'].text(), report.html);
	assert.equal(await items[0].data['text/plain'].text(), report.text);
});

test('legacy copy event supplies both formats and restores focus and selection', async () => {
	const legacy = legacyEnvironment();
	await copyFormattedReport(report, legacy.environment);
	assert.equal(legacy.data.get('text/html'), report.html);
	assert.equal(legacy.data.get('text/plain'), report.text);
	legacy.assertRestored();
});

test('denied modern clipboard falls back to a rich-text copy event', async () => {
	const legacy = legacyEnvironment();
	legacy.environment.navigator = { clipboard: { write: async () => { throw new Error('Permission denied'); } } };
	legacy.environment.ClipboardItem = class {};
	legacy.environment.Blob = Blob;
	await copyFormattedReport(report, legacy.environment);
	assert.equal(legacy.data.get('text/html'), report.html);
	legacy.assertRestored();
});

test('copy does not claim success when command fails or no clipboard event fires', async () => {
	for (const options of [{ commandResult: false }, { dispatch: false }]) {
		const legacy = legacyEnvironment(options);
		await assert.rejects(copyFormattedReport(report, legacy.environment), /Copy failed/);
		legacy.assertRestored();
	}
});

test('unsupported clipboard reports the limitation rather than silently dropping formatting', async () => {
	await assert.rejects(copyFormattedReport(report, {}), /HTTPS and allow clipboard access/);
});
