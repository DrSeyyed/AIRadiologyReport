import { storageParallelConnections } from './storage-settings.js';

export async function storageTaskPool(items, concurrency, operation, assertActive = () => {}) {
	const limit = storageParallelConnections({ parallelConnections: concurrency });
	let cursor = 0;
	let failure;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			try {
				while (!failure && cursor < items.length) {
					await assertActive();
					if (failure || cursor >= items.length) break;
					const index = cursor++;
					await operation(items[index], index);
					await assertActive();
				}
			} catch (error) {
				failure ||= error instanceof Error ? error : new Error('Storage operation failed.');
			}
		})
	);
	if (failure) throw failure;
}

export async function storageFilePool(
	deps,
	connection,
	items,
	operation,
	assertActive,
	coordinator
) {
	const concurrency = storageParallelConnections(connection);
	if (!items.length) return;
	await assertActive();
	let cursor = 0;
	let failure;
	const locks = new WeakMap();
	const fail = (error) => {
		failure ||= error instanceof Error ? error : new Error('Storage operation failed.');
	};
	async function work(client) {
		const previous = locks.get(client) || Promise.resolve();
		let release;
		locks.set(
			client,
			new Promise((resolve) => {
				release = resolve;
			})
		);
		await previous;
		try {
			while (!failure && cursor < items.length) {
				await assertActive();
				if (failure || cursor >= items.length) break;
				await operation(client, items[cursor++]);
				await assertActive();
			}
		} catch (error) {
			fail(error);
		} finally {
			release();
		}
	}
	async function session(existing) {
		let running;
		const callback = (client) => {
			if (failure) return Promise.reject(failure);
			running = work(client);
			return running;
		};
		try {
			if (existing) await callback(existing);
			else await deps.withStorage(connection, callback);
		} catch (error) {
			fail(error);
		} finally {
			await running?.catch(fail);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, (_, index) =>
			session(index === 0 ? coordinator : null)
		)
	);
	if (failure) throw failure;
}
