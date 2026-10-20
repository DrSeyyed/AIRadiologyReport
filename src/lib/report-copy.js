export const reportFonts = [
	{ name: 'Arial', family: 'Arial, sans-serif' },
	{ name: 'Times New Roman', family: '"Times New Roman", Times, serif' },
	{ name: 'Calibri', family: 'Calibri, Arial, sans-serif' },
	{ name: 'Cambria', family: 'Cambria, Georgia, serif' },
	{ name: 'Georgia', family: 'Georgia, serif' },
	{ name: 'Tahoma', family: 'Tahoma, sans-serif' },
	{ name: 'Verdana', family: 'Verdana, sans-serif' }
];

export function validReportSize(size) {
	return String(size).trim() !== '' && Number.isFinite(Number(size)) && Number(size) >= 6 && Number(size) <= 72;
}

export function reportTypography(font = 'Arial', size = 12) {
	return {
		fontFamily: (reportFonts.find((option) => option.name === font) || reportFonts[0]).family,
		fontSize: `${validReportSize(size) ? Number(size) : 12}pt`
	};
}

export function formattedReport({ title, sanitizedBodyHtml, resident, attending, signatures, font, size }, document = globalThis.document) {
	const root = document.createElement('div');
	root.innerHTML = sanitizedBodyHtml;
	const heading = document.createElement('h1');
	heading.textContent = title;
	root.prepend(heading);
	const names = document.createElement('p');
	names.append(`Resident: ${resident}`, document.createElement('br'), `Attending: ${attending}`);
	root.append(names);
	const signing = document.createElement('p');
	for (const [index, signature] of signatures.entries()) {
		if (index) signing.append(document.createElement('br'));
		signing.append(signature);
	}
	root.append(signing);
	const typography = reportTypography(font, size);
	for (const node of [root, ...root.querySelectorAll('*')]) {
		node.style.fontFamily = typography.fontFamily;
		node.style.fontSize = typography.fontSize;
	}
	root.style.color = '#000000';
	root.style.backgroundColor = '#ffffff';
	root.style.lineHeight = '1.5';
	for (const node of root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,pre,blockquote,ul,ol')) node.style.margin = '0 0 0.75em';
	for (const node of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) node.style.fontWeight = 'bold';
	for (const node of root.querySelectorAll('ul,ol')) {
		node.style.listStyleType = node.tagName === 'OL' ? 'decimal' : 'disc';
		node.style.paddingLeft = '1.5em';
	}
	for (const node of root.querySelectorAll('blockquote')) {
		node.style.borderLeft = '3px solid #cccccc';
		node.style.paddingLeft = '0.75em';
	}
	for (const node of root.querySelectorAll('pre')) node.style.whiteSpace = 'pre-wrap';
	for (const node of root.querySelectorAll('table')) node.style.borderCollapse = 'collapse';
	for (const node of root.querySelectorAll('td,th')) {
		node.style.border = '1px solid #000000';
		node.style.padding = '4px';
	}
	names.style.marginTop = '1.5em';
	const html = root.outerHTML;
	const plain = root.cloneNode(true);
	for (const node of plain.querySelectorAll('br')) node.replaceWith('\n');
	for (const table of plain.querySelectorAll('table')) {
		const rows = [...table.querySelectorAll('tr')].map((row) => [...row.querySelectorAll('td,th')]
			.map((cell) => cell.textContent.replace(/\s+/g, ' ').trim()).join('\t'));
		table.replaceWith(`${rows.join('\n')}\n\n`);
	}
	for (const node of plain.querySelectorAll('h1,h2,h3,h4,h5,h6,p,pre,blockquote,li')) node.append('\n\n');
	return { html, text: plain.textContent.replace(/\n(?:[ \t]*\n){2,}/g, '\n\n').trim() };
}

export async function copyFormattedReport({ html, text }, environment = globalThis) {
	if (environment.navigator?.clipboard?.write && environment.ClipboardItem) {
		try {
			await environment.navigator.clipboard.write([new environment.ClipboardItem({
				'text/html': new environment.Blob([html], { type: 'text/html' }),
				'text/plain': new environment.Blob([text], { type: 'text/plain' })
			})]);
			return;
		} catch {
			// Older browsers and clipboard permissions may require a user-initiated copy event.
		}
	}
	const document = environment.document;
	const selection = document?.getSelection();
	if (!selection || !document.execCommand) throw new Error('Formatted copy is unavailable. Use HTTPS and allow clipboard access, then try again.');
	const focused = document.activeElement;
	const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
	const fieldSelection = typeof focused?.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
	const target = document.createElement('div');
	target.contentEditable = 'true';
	target.style.cssText = 'position:fixed;left:-10000px;top:0;';
	target.innerHTML = html;
	let copied = false;
	function onCopy(event) {
		if (!event.clipboardData) return;
		event.clipboardData.setData('text/html', html);
		event.clipboardData.setData('text/plain', text);
		event.preventDefault();
		copied = true;
	}
	try {
		document.body.appendChild(target);
		target.focus({ preventScroll: true });
		const range = document.createRange();
		range.selectNodeContents(target);
		selection.removeAllRanges();
		selection.addRange(range);
		document.addEventListener('copy', onCopy);
		if (!document.execCommand('copy') || !copied) throw new Error('Copy failed. Allow clipboard access or use another browser.');
	} finally {
		document.removeEventListener('copy', onCopy);
		target.remove();
		selection.removeAllRanges();
		for (const range of ranges) selection.addRange(range);
		focused?.focus({ preventScroll: true });
		if (fieldSelection) focused.setSelectionRange(...fieldSelection);
	}
}
