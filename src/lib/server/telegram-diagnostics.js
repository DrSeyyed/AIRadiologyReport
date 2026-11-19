const EVENTS = new Set([
	'webhook_received', 'webhook_completed', 'webhook_failed', 'webhook_ignored',
	'voice_ignored', 'voice_rejected', 'voice_queued', 'voice_duplicate',
	'voice_processing', 'voice_download_started', 'voice_downloaded', 'voice_attached',
	'voice_retry', 'voice_stopped', 'voice_worker_failed', 'voice_notification_failed'
]);
const VALUES = {
	reason: new Set(['invalid_json', 'unsupported_update', 'maintenance', 'missing_token',
		'wrong_group', 'service_message', 'study_post', 'invalid_reply', 'invalid_metadata',
		'sender_not_allowed', 'not_approved', 'typist', 'deleted', 'unknown_reply',
		'policy_rejected', 'sender_no_longer_approved', 'already_attached', 'waiting_for_parent',
		'removed_during_download', 'already_completed', 'retryable_failure', 'attached']),
	stage: new Set(['authenticate', 'parse', 'maintenance', 'private', 'group', 'queue',
		'validate', 'download', 'attach', 'refresh', 'worker']),
	kind: new Set(['message', 'edited_message', 'callback_query', 'other']),
	media: new Set(['voice', 'audio', 'other']),
	errorCode: new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
		'ENOSPC', 'EACCES', 'ENOENT', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_FULL',
		'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
		'UND_ERR_SOCKET', 'AbortError', 'TimeoutError', 'unexpected'])
};
const IDS = ['updateId', 'messageId', 'replyMessageId', 'studyId', 'jobId', 'recordingId', 'retryAt'];

export function telegramErrorDetails(error) {
	const result = { errorCode: 'unexpected' };
	if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) result.httpStatus = error.status;
	const telegramStatus = error?.telegram_error_code ?? error?.telegram_http_status;
	if (Number.isInteger(telegramStatus) && telegramStatus >= 400 && telegramStatus <= 599) result.telegramStatus = telegramStatus;
	for (const code of [error?.code, error?.cause?.code, error?.name]) {
		if (VALUES.errorCode.has(code)) {
			result.errorCode = code;
			break;
		}
	}
	return result;
}

export function telegramDiagnostic(event, details = {}) {
	if (!EVENTS.has(event)) return;
	try {
		const entry = { timestamp: new Date().toISOString(), event };
		for (const key of IDS) if (Number.isSafeInteger(details[key]) && details[key] >= 0) entry[key] = details[key];
		for (const key of ['httpStatus', 'telegramStatus']) {
			if (Number.isInteger(details[key]) && details[key] >= 100 && details[key] <= 599) entry[key] = details[key];
		}
		for (const [key, values] of Object.entries(VALUES)) if (values.has(details[key])) entry[key] = details[key];
		console.info('[telegram]', JSON.stringify(entry));
	} catch {
		// Diagnostic output must never change webhook acknowledgement or queue processing.
	}
}
