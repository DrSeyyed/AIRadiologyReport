const titles = new Map([
	['/account', 'Account'],
	['/studies/import', 'Import studies from Excel'],
	['/admin/pacs', 'PACS viewer settings'],
	['/admin/transcription', 'Transcription settings'],
	['/admin/reporting', 'Reporting settings'],
	['/admin/body-parts', 'Manage body parts'],
	['/admin/telegram-registrations', 'Telegram registrations']
]);

export function pageTitle(routeId) {
	return titles.get(routeId) || 'Personal Taleghani PACS';
}
