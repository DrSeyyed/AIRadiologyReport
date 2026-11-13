import { canManageTemplates } from './template-permissions.js';

const groups = [
	{
		id: 'clinical',
		label: 'Clinical workflow',
		description: 'Configure reporting, dictation and study reference data.',
		links: [
			{ href: '/admin/templates', label: 'Report templates', description: 'Create and maintain reusable report templates.', templates: true },
			{ href: '/admin/body-parts', label: 'Body parts', description: 'Manage study body-part reference data.' },
			{ href: '/admin/pacs', label: 'PACS viewer settings', description: 'Choose how studies open in the image viewer.' },
			{ href: '/admin/transcription', label: 'Transcription settings', description: 'Select speech-to-text providers and models.' },
			{ href: '/admin/reporting', label: 'Reporting settings', description: 'Configure report generation and audio-model policy.' }
		]
	},
	{
		id: 'telegram',
		label: 'Telegram',
		description: 'Review registrations and maintain study messages.',
		links: [
			{ href: '/admin/telegram-registrations', label: 'Telegram registrations', description: 'Verify and approve new account requests.' },
			{ href: '/admin/telegram-study-refresh', label: 'Study message refresh', description: 'Refresh existing Telegram study messages and monitor progress.' }
		]
	},
	{
		id: 'system',
		label: 'System',
		description: 'Manage access, integrations and site operations.',
		links: [
			{ href: '/admin/users', label: 'Users', description: 'Manage accounts, roles and onboarding links.' },
			{ href: '/admin/integrations', label: 'Integrations', description: 'Manage provider credentials and Telegram webhooks.' },
			{ href: '/admin/storage', label: 'Storage & Backups', description: 'Configure storage, schedules, backups and restoration.' },
			{ href: '/admin/maintenance', label: 'Maintenance', description: 'Open or close the site and manage the Telegram maintenance lock.' }
		]
	}
];

export function adminNavigation(user) {
	return groups.map((group) => ({
		...group,
		links: group.links.filter((link) => user?.role === 'admin' || (link.templates && canManageTemplates(user)))
	})).filter((group) => group.links.length > 0);
}
