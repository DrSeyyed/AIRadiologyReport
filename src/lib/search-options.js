export function filterSearchOptions(options, query) {
	const search = query.trim().toLowerCase();
	if (!search) return options;
	return options.filter((option) => `${option.code || ''} ${option.name || ''}`.toLowerCase().includes(search));
}
