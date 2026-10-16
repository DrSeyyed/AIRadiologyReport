export function canImportStudies(user) {
	return ['admin', 'attending', 'resident'].includes(user?.role);
}

export function canUpdateStudyAttention(user) {
	return ['admin', 'attending', 'resident'].includes(user?.role);
}
