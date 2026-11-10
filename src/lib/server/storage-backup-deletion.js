import { withStorage, storagePath } from './storage-transport.js';
import { storageRequest } from './storage-session.js';
import { storageFilePool } from './storage-file-pool.js';
import { maintenanceTransport } from './storage-maintenance-sessions.js';

const ID = /^\d{1,16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function attributeIs(attrs, name, type) {
	return (
		attrs?.[name] === true ||
		(typeof attrs?.[name] === 'function' && attrs[name]()) ||
		attrs?.type === type
	);
}

export function validateBackupDeletionIds(ids) {
	if (
		!Array.isArray(ids) ||
		!ids.length ||
		ids.length > 100 ||
		ids.some((id) => typeof id !== 'string' || !ID.test(id)) ||
		new Set(ids).size !== ids.length
	)
		throw new Error('Select between 1 and 100 distinct recovery points.');
	return [...ids];
}

export function safeBackupDeletionProgress(value) {
	return value &&
		['deleted', 'total'].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0) &&
		value.deleted <= value.total &&
		value.total >= 1 &&
		value.total <= 100
		? { deleted: value.deleted, total: value.total }
		: null;
}

export async function deleteRecoveryPoints(connection, options = {}, injected = {}) {
	const deps = { withStorage, storagePath, ...injected };
	const owned = options.owned || (() => true);
	const controller = new AbortController();
	let monitoring = false;
	const check = async () => {
		if (controller.signal.aborted || !(await owned()) || controller.signal.aborted) {
			controller.abort();
			throw new Error('Backup deletion stopped.');
		}
	};
	const transport = maintenanceTransport(deps.withStorage, controller, check);
	const sessionConnection = {
		...connection,
		operationTimeoutMs: 6 * 60 * 60 * 1000,
		signal: controller.signal
	};
	const pool = (items, operation, coordinator) =>
		storageFilePool(
			{ ...deps, withStorage: transport },
			sessionConnection,
			items,
			async (client, item) => {
				try {
					return await operation(client, item);
				} catch (error) {
					controller.abort();
					throw error;
				}
			},
			check,
			coordinator
		);
	const inspect = (client) => {
		const request = async (operation) => {
			await check();
			const result = await storageRequest(client, operation);
			await check();
			return result;
		};
		const stat = async (path) => {
			try {
				return await request(() => client.lstat(path));
			} catch (error) {
				await check();
				if (error.code === 2 || error.code === 'ENOENT') return null;
				throw error;
			}
		};
		const directories = async () => {
			for (const directory of ['backups', 'backups/indexes', 'backups/manifests']) {
				const attrs = await stat(deps.storagePath(connection, ...directory.split('/')));
				if (!attributeIs(attrs, 'isDirectory', 'd') || attributeIs(attrs, 'isSymbolicLink', 'l'))
					throw new Error('Unsafe backup directory.');
			}
		};
		const regular = async (path) => {
			const attrs = await stat(path);
			if (
				attrs &&
				(!attributeIs(attrs, 'isFile', '-') || attributeIs(attrs, 'isSymbolicLink', 'l'))
			)
				throw new Error('Unsafe backup metadata.');
			return attrs;
		};
		return { request, directories, regular };
	};
	const monitor = setInterval(async () => {
		if (monitoring) return;
		monitoring = true;
		try {
			await check();
		} catch {
			controller.abort();
		} finally {
			monitoring = false;
		}
	}, 100);
	monitor.unref?.();
	try {
		const ids = validateBackupDeletionIds(options.backupIds);
		return await transport(sessionConnection, async (client) => {
			await check();
			const { request, directories } = inspect(client);
			await directories();
			let plan = options.plan;
			if (plan == null) {
				const entries = await request(() =>
					client.list(deps.storagePath(connection, 'backups', 'indexes'))
				);
				plan = ids.map((id) => {
					const matches = entries.filter((entry) =>
						['full', 'database'].some((kind) => entry.name === `${id}.${kind}.json`)
					);
					if (matches.length !== 1 || matches[0].type !== '-')
						throw new Error('Recovery point unavailable.');
					return { id, kind: matches[0].name === `${id}.full.json` ? 'full' : 'database' };
				});
			}
			if (
				!Array.isArray(plan) ||
				plan.length !== ids.length ||
				plan.some((point, i) => point?.id !== ids[i] || !['full', 'database'].includes(point.kind))
			)
				throw new Error('Invalid backup deletion plan.');
			const paths = plan.map(({ id, kind }) => [
				deps.storagePath(connection, 'backups', 'indexes', `${id}.${kind}.json`),
				deps.storagePath(connection, 'backups', 'manifests', `${id}.enc`)
			]);
			await pool(
				paths.flat(),
				async (session, path) => {
					if (!(await inspect(session).regular(path)) && options.plan == null)
						throw new Error('Incomplete recovery point.');
				},
				client
			);
			// Persist the exact plan before removing any index so interrupted deletion is retryable.
			if (options.plan == null) {
				if (typeof options.onPlan !== 'function')
					throw new Error('A durable deletion plan is required.');
				await options.onPlan(plan);
				await check();
			}
			const progress = { deleted: 0, total: paths.length };
			await options.onProgress?.({ ...progress });
			let reporting = Promise.resolve();
			await pool(
				paths,
				async (session, pair) => {
					const { request, directories, regular } = inspect(session);
					// Each completion index must disappear before its manifest; points are independent.
					for (const path of pair) {
						await directories();
						if (await regular(path)) await request(() => session.delete(path));
					}
					const snapshot = { deleted: ++progress.deleted, total: progress.total };
					reporting = reporting.then(async () => {
						await check();
						await options.onProgress?.(snapshot);
					});
					await reporting;
				},
				client
			);
			await check();
			return { ...progress, objectsRetained: true };
		});
	} catch {
		throw new Error(
			'Backup deletion stopped. Some selected points may already be removed; retry or reload the recovery-point list. Shared file objects were retained.'
		);
	} finally {
		controller.abort();
		clearInterval(monitor);
	}
}
