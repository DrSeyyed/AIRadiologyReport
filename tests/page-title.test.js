import test from 'node:test';
import assert from 'node:assert/strict';
import { pageTitle } from '../src/lib/page-title.js';

test('pages without custom titles and unknown routes use the application title', () => {
	for (const route of ['/', '/login', '/studies', '/unknown', null, undefined]) {
		assert.equal(pageTitle(route), 'Personal Taleghani PACS');
	}
});

test('existing page-specific browser titles are retained', () => {
	const expected = {
		'/account': 'Account',
		'/statistics': 'Study statistics',
		'/admin/statistics': 'Study statistics',
		'/studies/import': 'Import studies from Excel',
		'/admin/pacs': 'PACS viewer settings',
		'/admin/transcription': 'Transcription settings',
		'/admin/reporting': 'Reporting settings',
		'/admin/storage': 'Storage & Backups',
		'/admin/body-parts': 'Manage body parts',
		'/admin/telegram-registrations': 'Telegram registrations',
		'/admin': 'Administration',
		'/admin/account': 'Account settings',
		'/admin/templates': 'Report templates',
		'/admin/users': 'Users',
		'/admin/integrations': 'Integrations',
		'/admin/maintenance': 'Site maintenance',
		'/admin/telegram-study-refresh': 'Telegram study message refresh'
	};
	for (const [route, title] of Object.entries(expected)) assert.equal(pageTitle(route), title);
});

test('returning from a custom-titled route restores the application title', () => {
	assert.equal(pageTitle('/admin/body-parts'), 'Manage body parts');
	assert.equal(pageTitle('/admin/templates'), 'Report templates');
	assert.equal(pageTitle('/account'), 'Account');
	assert.equal(pageTitle('/studies'), 'Personal Taleghani PACS');
});
