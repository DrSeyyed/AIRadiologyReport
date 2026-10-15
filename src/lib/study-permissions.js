export function canImportStudies(user) {
	return ['admin', 'attending', 'resident'].includes(user?.role);
}
