export function canManageTemplates(user) {
	return ['admin', 'attending', 'resident'].includes(user?.role);
}
