import path from 'node:path';
import { INTEGRATION_FIELDS } from './integration-settings.js';
import { integrationRestoreFields, pendingIntegrationRestoreStatus } from './integration-backup.js';
import { isStorageRestoreId } from './storage-restore.js';

const KEYS = new Set(INTEGRATION_FIELDS.map(({ key }) => key));
const ERROR = 'Select each available integration setting once and type RESTORE CREDENTIALS to confirm. Unchecked settings stay unchanged.';

export function validateIntegrationRestoreSelection(fields) {
	if (!Array.isArray(fields) || fields.length > KEYS.size || new Set(fields).size !== fields.length ||
		fields.some(key => typeof key !== 'string' || !KEYS.has(key))) throw new Error(ERROR);
	return [...fields];
}

export function integrationRestoreSelection(form) {
	const allowed = ['confirmation', 'acknowledgement', 'jobId', 'integrationField', 'integrationConfirmation'];
	if ([...form.keys()].some(key => !allowed.includes(key))) throw new Error(ERROR);
	const fields = validateIntegrationRestoreSelection(form.getAll('integrationField'));
	const confirmations = form.getAll('integrationConfirmation');
	if (confirmations.length > 1 || confirmations.some(value => typeof value !== 'string') ||
		(fields.length && confirmations[0] !== 'RESTORE CREDENTIALS') ||
		(confirmations.length && !['', 'RESTORE CREDENTIALS'].includes(confirmations[0]))) throw new Error(ERROR);
	return fields;
}

export function pendingRestoreMetadata(options = {}, read = pendingIntegrationRestoreStatus) {
	try { return read(options); }
	catch { return { pending: true, fields: [], error: 'Pending integration restoration needs attention. Keep maintenance enabled and check the retained original encryption key and private pending file.' }; }
}

export function withRestoreIntegrationMetadata(db, status, {
	cwd = process.cwd(), read = integrationRestoreFields
} = {}) {
	return {
		...status,
		preparedRestores: status.preparedRestores.map(restore => {
			try {
				const prefix = 'restore-staging/';
				if (typeof restore.directory !== 'string' || !restore.directory.startsWith(prefix)) throw new Error();
				const restoreId = restore.directory.slice(prefix.length);
				if (!isStorageRestoreId(restoreId) || !Number.isSafeInteger(restore.id) || restore.id < 1) throw new Error();
				const row = db.prepare("SELECT result FROM storage_jobs WHERE id=? AND kind='restore' AND status='succeeded'").get(restore.id);
				const saved = JSON.parse(row.result);
				if (saved.restoreId !== restoreId || typeof saved.id !== 'string') throw new Error();
				const fields = read(path.join(cwd, 'restore-staging', restoreId), { backupId: saved.id });
				return { ...restore, integrationFields: fields };
			} catch { return { ...restore, integrationFields: [], integrationUnavailable: true }; }
		})
	};
}
