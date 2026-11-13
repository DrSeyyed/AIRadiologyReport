// Keep expansions explicit: similarly spelled diagnoses and ambiguous abbreviations are not interchangeable.
export const pathologyConcepts = [
	['hemangioma', 'hemangiomas', 'haemangioma', 'haemangiomas', 'heamangioma', 'heamngioma'],
	['hepatocellular carcinoma', 'hepatocellular carcinomas', 'hcc'],
	['focal nodular hyperplasia', 'fnh'],
	['cholangiocarcinoma', 'cholangiocarcinomas'],
	['metastasis', 'metastases', 'metastatic'],
	['cyst', 'cysts'],
	['adenoma', 'adenomas'],
	['cirrhosis', 'cirrhotic'],
	['tumor', 'tumors', 'tumour', 'tumours'],
	['edema', 'oedema'],
	['hemorrhage', 'hemorrhages', 'haemorrhage', 'haemorrhages'],
	['hematoma', 'hematomas', 'haematoma', 'haematomas'],
	['steatosis', 'fatty liver', 'hepatic steatosis']
];
const organs = [
	['liver', 'hepatic'], ['kidney', 'kidneys', 'renal'], ['lung', 'lungs', 'pulmonary'],
	['pancreas', 'pancreatic'], ['spleen', 'splenic'], ['adrenal', 'adrenals'],
	['prostate', 'prostatic'], ['ovary', 'ovaries', 'ovarian'], ['vertebra', 'vertebrae', 'vertebral']
];

function normalize(text) {
	return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
function escaped(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function expression(aliases) {
	return new RegExp(`(?:^| )(${aliases.map(escaped).sort((a, b) => b.length - a.length).join('|')})(?= |$)`, 'g');
}
function occurrences(text, aliases) {
	return [...text.matchAll(expression(aliases))].map((match) => ({ start: match.index + match[0].length - match[1].length, end: match.index + match[0].length }));
}

export function pathologyQuery(value) {
	if (typeof value !== 'string' || value.trim().length > 160) throw new Error('Enter a search of up to 160 characters.');
	const text = normalize(value);
	if (!text) throw new Error('Enter a pathology, for example hemangioma, HCC or liver hemangioma.');
	const groups = [];
	const words = text.split(' ');
	const vocabulary = [...pathologyConcepts.map((aliases) => ({ aliases, organ: false })), ...organs.map((aliases) => ({ aliases, organ: true }))];
	for (let i = 0; i < words.length;) {
		const rest = words.slice(i).join(' ');
		const options = vocabulary.flatMap((group) => group.aliases.filter((alias) => rest === alias || rest.startsWith(`${alias} `)).map((alias) => ({ ...group, alias })));
		options.sort((a, b) => b.alias.length - a.alias.length);
		const selected = options[0];
		if (selected) {
			if (!groups.some((group) => group.aliases === selected.aliases)) groups.push({ aliases: selected.aliases, organ: selected.organ });
			i += selected.alias.split(' ').length;
		} else {
			if (!['of', 'in', 'the', 'a', 'an', 'and'].includes(words[i])) groups.push({ aliases: [words[i]], organ: false });
			i++;
		}
	}
	if (!groups.length || groups.length > 12) throw new Error('Enter between 1 and 12 meaningful search terms.');
	return { text: value.trim(), groups, expansions: groups.map((group) => group.aliases) };
}

function nearestDistance(hits, target) {
	let low = 0;
	let high = hits.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (hits[middle].start < target.start) low = middle + 1;
		else high = middle;
	}
	return Math.min(...[hits[low - 1], hits[low]].filter(Boolean).map((hit) => Math.max(0, hit.start - target.end, target.start - hit.end)), Infinity);
}

function sentences(line) {
	const result = [];
	let start = 0;
	// Preserve sentence punctuation without splitting decimal measurements.
	for (const boundary of line.matchAll(/(?<!\d)\.|\.(?!\d)|[!?]+/g)) {
		result.push(line.slice(start, boundary.index + boundary[0].length).trim());
		start = boundary.index + boundary[0].length;
	}
	if (line.slice(start).trim()) result.push(line.slice(start).trim());
	return result;
}

function matchesClause(clause, query) {
	const text = normalize(clause);
	const hits = query.groups.map((group) => occurrences(text, group.aliases));
	if (hits.some((group) => !group.length)) return false;
	const diagnosticHits = hits.flatMap((group, index) => query.groups[index].organ ? [] : group);
	if (!diagnosticHits.length) diagnosticHits.push(...hits.flat());
	// Do not attach a lesion to a requested organ when another explicitly named organ is closer.
	const requestedOrgans = query.groups.filter((group) => group.organ);
	const otherOrgans = organs.filter((aliases) => !requestedOrgans.some((group) => group.aliases === aliases)).flatMap((aliases) => occurrences(text, aliases)).sort((a, b) => a.start - b.start);
	const requestedHits = requestedOrgans.flatMap((group) => occurrences(text, group.aliases)).sort((a, b) => a.start - b.start);
	return diagnosticHits.some((hit) => !requestedHits.length || nearestDistance(otherOrgans, hit) >= nearestDistance(requestedHits, hit));
}

export function matchPathologyReport(report, query) {
	const matches = [];
	for (const line of report.split(/\r?\n/)) {
		for (const sentence of sentences(line)) {
			if (sentence.split(/[;,]|\b(?:but|however|whereas|although)\b/i).some((clause) => matchesClause(clause, query))) {
				matches.push({ excerpt: sentence });
			}
		}
	}
	return matches;
}
