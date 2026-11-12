import { activatePreparedRestore } from './restore-activation.js';
import { restoreActivationStatus } from './restore-activation-runtime.js';
import { validateIntegrationRestoreSelection } from './integration-restore-admin.js';

export function automaticRestoreApproval({ activate = false, requestedBy = null, integrationFields = [] } = {}) {
	if (typeof activate !== 'boolean') throw new Error('Invalid restore approval.');
	const fields = validateIntegrationRestoreSelection(integrationFields).sort();
	if (!activate) {
		if (requestedBy !== null || fields.length) throw new Error('Confirm live replacement first.');
		return null;
	}
	if (!Number.isSafeInteger(requestedBy) || requestedBy < 1) throw new Error('Invalid restore administrator.');
	return { requestedBy, fields: JSON.stringify(fields) };
}

export function retryAutomaticRestore(db, jobId) {
	if (!Number.isSafeInteger(jobId) || jobId < 1) throw new Error('Select a restore to retry.');
	const result = db.prepare(`UPDATE storage_restore_activations SET state='pending',error=NULL
		WHERE job_id=? AND state='blocked' AND EXISTS(
			SELECT 1 FROM storage_jobs j WHERE j.id=job_id AND j.status='succeeded')`).run(jobId);
	if (!result.changes) throw new Error('Only a paused verified restore can be retried.');
}

function failureMessage(error) {
	if (error?.code === 'TELEGRAM_MAINTENANCE_INVALID_PERMISSIONS')
		return 'Telegram group permissions could not be locked. Check Maintenance before retrying.';
	if (error?.code === 'INTEGRATION_RESTORE_PRIVATE_PLAN_REQUIRED')
		return 'Selected credentials need private database file permissions. Fix permissions, or cancel and restore without credentials.';
	if (error?.code === 'RESTORE_PREPARED_DATABASE_HAS_JOURNALS')
		return 'The verified database has journal files. Cancel this restore and start a fresh restore; do not delete SQLite journals.';
	return 'Restore paused before live replacement. Check Maintenance, the original encryption key, selected backup credentials and free disk space, then retry.';
}

export async function processAutomaticRestore(db, {
	activate = activatePreparedRestore,
	status = restoreActivationStatus
} = {}) {
	const current = status();
	if (current.maintenance) return true;
	if (!current.supported) return false;
	for (const receipt of db.prepare("SELECT job_id FROM storage_restore_activations WHERE state='queued'").all()) {
		const row = db.prepare('SELECT result FROM storage_jobs WHERE id=?').get(receipt.job_id);
		let restoreId;
		try { restoreId = JSON.parse(row?.result).restoreId; } catch { /* Invalid receipts stay closed. */ }
		if (restoreId && current.restoreId === restoreId && current.state === 'completed') {
			db.prepare("UPDATE storage_restore_activations SET state='completed',error=NULL WHERE job_id=?").run(receipt.job_id);
		} else if (restoreId && current.restoreId === restoreId && !['idle', 'error', 'rolled_back'].includes(current.state)) {
			return true;
		} else {
			db.prepare("UPDATE storage_restore_activations SET state='blocked',error=? WHERE job_id=?")
				.run('The restore did not complete or was rolled back. Check the server before retrying.', receipt.job_id);
		}
	}
	const request = db.prepare(`SELECT a.*,j.result FROM storage_restore_activations a
		JOIN storage_jobs j ON j.id=a.job_id WHERE a.state IN ('pending','activating')
		AND j.status='succeeded' ORDER BY a.job_id LIMIT 1`).get();
	if (!request) return false;
	try {
		const saved = JSON.parse(request.result);
		if (current.restoreId === saved.restoreId && current.state !== 'idle' &&
			(current.state !== 'rolled_back' || request.state === 'activating')) {
			const state = current.state === 'rolled_back' || current.state === 'error' ? 'blocked' : 'queued';
			db.prepare('UPDATE storage_restore_activations SET state=?,error=? WHERE job_id=?')
				.run(state, state === 'blocked' ? 'The restore was rolled back. Check the server before retrying.' : null, request.job_id);
			return state === 'queued';
		}
		if (current.state === 'error') throw new Error('Activation journal unavailable.');
		const fields = validateIntegrationRestoreSelection(JSON.parse(request.integration_fields));
		// A rollback snapshot must never contain an approval that can replay automatically.
		db.prepare("UPDATE storage_restore_activations SET state='activating',error=NULL WHERE job_id=?")
			.run(request.job_id);
		await activate(db, { jobId: request.job_id, userId: request.requested_by, integrationFields: fields }, { requestAllowance: 0 });
		db.prepare("UPDATE storage_restore_activations SET state='queued',error=NULL WHERE job_id=?").run(request.job_id);
		return true;
	} catch (error) {
		// Queue publication may succeed even if the caller dies before recording its receipt.
		const queued = status();
		let restoreId;
		try { restoreId = JSON.parse(request.result).restoreId; } catch { /* Invalid results fail closed. */ }
		if (restoreId && queued.restoreId === restoreId && !['idle', 'error', 'rolled_back'].includes(queued.state)) {
			db.prepare("UPDATE storage_restore_activations SET state='queued',error=NULL WHERE job_id=?").run(request.job_id);
			return true;
		}
		const transient = ['RESTORE_ACTIVATION_BUSY', 'RESTORE_STORAGE_BUSY'].includes(error?.code);
		db.prepare('UPDATE storage_restore_activations SET state=?,error=? WHERE job_id=?')
			.run(transient ? 'pending' : 'blocked', transient ? null : failureMessage(error), request.job_id);
		return false;
	}
}
