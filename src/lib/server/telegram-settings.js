export function validateWebsiteUrl(value) {
	try {
		if (typeof value !== 'string' || value.trim().length > 2000) throw new Error();
		const url = new URL(value.trim());
		if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
		return url.href;
	} catch {
		throw Object.assign(new Error('Enter a valid HTTP or HTTPS website link without embedded credentials (up to 2000 characters).'), { status: 400 });
	}
}

export function getTelegramWebsiteUrl(db) {
	return db.prepare("SELECT value FROM application_settings WHERE key = 'telegram_website_url'").get()?.value ?? '';
}

export function setTelegramWebsiteUrl(db, value) {
	const url = value === '' ? '' : validateWebsiteUrl(value);
	db.prepare(`INSERT INTO application_settings(key, value) VALUES ('telegram_website_url', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(url);
	return url;
}
