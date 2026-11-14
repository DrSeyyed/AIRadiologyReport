const titles = new Map([
	['/account', 'Account'],
	['/statistics', 'Study statistics'],
	['/pathology-search', 'Pathology search'],
	['/favorites', 'My study favorites'],
	['/admin/statistics', 'Study statistics'],
	['/studies/import', 'Import studies from Excel'],
	['/admin/pacs', 'PACS viewer settings'],
	['/admin/transcription', 'Transcription settings'],
	['/admin/reporting', 'Reporting settings'],
	['/admin/storage', 'Storage & Backups'],
	['/admin/body-parts', 'Manage body parts'],
	['/admin/telegram-registrations', 'Telegram registrations'],
	['/admin', 'Administration'],
	['/admin/account', 'Account settings'],
	['/admin/templates', 'Report templates'],
	['/admin/users', 'Users'],
	['/admin/integrations', 'Integrations'],
	['/admin/maintenance', 'Site maintenance'],
	['/admin/telegram-study-refresh', 'Telegram study message refresh']
]);

export function pageTitle(routeId) {
	return titles.get(routeId) || 'Personal Taleghani PACS';
}
