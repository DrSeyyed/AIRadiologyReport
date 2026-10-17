import { DEFAULT_PACS_VIEWER_URL, normalizePacsViewerUrl } from '../pacs-viewer.js';

export function getPacsViewerUrl(db) {
	return db.prepare("SELECT value FROM application_settings WHERE key = 'pacs_viewer_url'").get()?.value ?? DEFAULT_PACS_VIEWER_URL;
}

export function setPacsViewerUrl(db, value) {
	const url = normalizePacsViewerUrl(value);
	db.prepare(`INSERT INTO application_settings(key, value) VALUES ('pacs_viewer_url', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(url);
	return url;
}
