export const pathologyContexts = [
	{ value: '', label: 'All mentions' },
	{ value: 'present', label: 'Positive wording' },
	{ value: 'suspected', label: 'Uncertain wording' },
	{ value: 'absent', label: 'Negated wording' },
	{ value: 'historical', label: 'Historical / background wording' },
	{ value: 'unclassified', label: 'Unclassified context' }
];

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

function context(text, hit) {
	const before = text.slice(Math.max(0, hit.start - 180), hit.start);
	const after = text.slice(hit.end, hit.end + 100);
	const nearby = `${before} ${after}`;
	if (/\b(?:cannot exclude|cannot rule out|can not exclude|can not rule out|could represent|may represent|possible|possibly|probable|probably|suspected|no definite evidence of|suspicious for|suggestive of|rule out|evaluate for|versus|vs)\b/.test(before)
		|| /^\s+(?:(?:is|are)\s+)?(?:not excluded|cannot be excluded|possible|suspected)\b/.test(after)
		|| /\b(?:versus|vs)\b/.test(nearby)) return 'suspected';
	if (/\b(?:no|without)\b.*\b(?:change|progression|growth|new|additional|other|and)\b/.test(before)) return 'unclassified';
	if (/\b(?:no|without|negative for|absence of|free of)\s+(?:\w+\s+){0,6}$/.test(before)
		|| /^\s+(?:(?:is|are|was|were)\s+)?(?:not (?:seen|identified|demonstrated|present|detected)|absent|excluded)\b/.test(after)) return 'absent';
	if (/\b(?:history of|hx of|previously diagnosed|previously treated|prior|previous|treated|resected)\b/.test(before)
		|| /^\s+(?:(?:is|was)\s+)?(?:resected|previously treated)\b/.test(after)) return 'historical';
	// Other nearby negations or qualifications are ambiguous, not proof of a positive finding.
	if (/\b(?:no|not|without|unlikely|question|differential|history|indication)\b/.test(nearby)) return 'unclassified';
	if (/\b(?:there is|there are|shows|showing|demonstrates|demonstrating|reveals|consistent with)\b/.test(before)
		|| /^\s+(?:(?:is|are)\s+)?(?:seen|identified|demonstrated|present|noted)\b/.test(after)) return 'present';
	return 'unclassified';
}

export function matchPathologyReport(report, query) {
	const matches = [];
	let section = '';
	for (const line of report.split(/\r?\n/)) {
		const heading = normalize(line.replace(/[#*_]/g, ''));
		if (/^(?:clinical history|history|clinical indication|indication|findings|impression|conclusion|comparison)(?: |$)/.test(heading) && (line.includes(':') || /^\s*#/.test(line) || heading.split(' ').length <= 2)) {
			section = /^(?:clinical history|history|clinical indication|indication|comparison)(?: |$)/.test(heading) ? 'background' : 'findings';
		}
		for (const clause of line.split(/(?<!\d)\.|\.(?!\d)|[!;,]|\b(?:but|however|whereas|although)\b/i)) {
			const text = normalize(clause);
			const hits = query.groups.map((group) => occurrences(text, group.aliases));
			if (hits.some((group) => !group.length)) continue;
			const diagnosticHits = hits.flatMap((group, index) => query.groups[index].organ ? [] : group);
			if (!diagnosticHits.length) diagnosticHits.push(...hits.flat());
			// Do not attach a lesion to a requested organ when another explicitly named organ is closer.
			const requestedOrgans = query.groups.filter((group) => group.organ);
			const otherOrgans = organs.filter((aliases) => !requestedOrgans.some((group) => group.aliases === aliases)).flatMap((aliases) => occurrences(text, aliases)).sort((a, b) => a.start - b.start);
			const requestedHits = requestedOrgans.flatMap((group) => occurrences(text, group.aliases)).sort((a, b) => a.start - b.start);
			const eligible = diagnosticHits.filter((hit) => !requestedHits.length || nearestDistance(otherOrgans, hit) >= nearestDistance(requestedHits, hit));
			if (!eligible.length) continue;
			const labels = new Set(eligible.map((hit) => context(text, hit)));
			let status = labels.size === 1 ? [...labels][0] : 'unclassified';
			if (clause.includes('?') && status !== 'absent') status = 'suspected';
			if (section === 'background' && status !== 'absent') status = 'historical';
			const excerpt = clause.trim().replace(/\s+/g, ' ');
			// Bound by characters as well as preserving the hit, including reports with unbroken tokens.
			const approximateWord = text.slice(0, eligible[0].start).split(' ').length - 1;
			const tokens = /[\p{L}\p{N}]+/gu;
			let anchor = 0;
			for (let i = 0; i <= approximateWord; i++) {
				const token = tokens.exec(excerpt);
				if (!token) break;
				anchor = token.index;
			}
			const start = Math.max(0, anchor - 220);
			const end = Math.min(excerpt.length, start + 700);
			matches.push({ context: status, excerpt: `${start ? '… ' : ''}${excerpt.slice(start, end)}${end < excerpt.length ? ' …' : ''}` });
		}
	}
	return matches;
}
