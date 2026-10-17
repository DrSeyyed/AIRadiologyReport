export const DEFAULT_PACS_VIEWER_URL = 'https://taleghanisms.pacs.sbmu.ac.ir:5010/adminpanel/LoadViewer?studyKey={studyKey}';

export function normalizePacsViewerUrl(value) {
	if (typeof value !== 'string') throw new Error('Viewer URL must be text.');
	const template = value.trim();
	if (!template) return '';
	if (template.length > 2048) throw new Error('Viewer URL exceeds 2048 characters.');
	if (!template.includes('{studyKey}')) throw new Error('Viewer URL must contain {studyKey}.');
	let url;
	try {
		url = new URL(template.replaceAll('{studyKey}', 'PACS_STUDY_KEY'));
	} catch {
		throw new Error('Enter a valid HTTP or HTTPS viewer URL.');
	}
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
		throw new Error('Use HTTP or HTTPS without embedded credentials.');
	if (url.origin !== new URL(template.replaceAll('{studyKey}', 'OTHER_KEY')).origin)
		throw new Error('Place {studyKey} in the URL path or query, not the hostname.');
	return template;
}

export function pacsViewerLink(template, studyKey) {
	const normalized = normalizePacsViewerUrl(template);
	const key = typeof studyKey === 'string' ? studyKey.trim() : '';
	if (!normalized || !key || key.length > 128) return '';
	return normalized.replaceAll('{studyKey}', encodeURIComponent(key));
}
