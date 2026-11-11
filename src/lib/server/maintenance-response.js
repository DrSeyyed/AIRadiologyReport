export function maintenanceResponse(request, { activating = false } = {}) {
	const message = activating
		? 'An update or restore is in progress. Please try again shortly.'
		: 'The website is updating. Please try again later.';
	const headers = { 'cache-control': 'no-store', 'retry-after': '30' };
	if (new URL(request.url).pathname.startsWith('/api/') || request.headers.get('accept')?.includes('application/json'))
		return Response.json({ error: message, maintenance: true }, { status: 503, headers });
	return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>Updating — Personal Taleghani PACS</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f0fdf4;color:#173b2b;font:18px system-ui,sans-serif}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:2rem}a{color:#166534}p{line-height:1.6}</style></head><body><main><h1>Updating…</h1><p>${message}</p><p>This page will refresh automatically.</p><p><a href="/login">Administrator sign in</a></p></main></body></html>`, {
		status: 503, headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" }
	});
}
