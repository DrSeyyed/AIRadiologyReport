export async function verifyRecoveryArchives(deps, connection, coordinator, archives, assertOwned) {
	const rows = [...archives];
	if (!rows.length) return;
	await assertOwned();
	const clients = new WeakMap();
	let cursor = 0;
	let failure;
	const fail = (error) => {
		failure ||= error instanceof Error ? error : new Error('Recovery archive verification failed.');
	};
	async function worker(client) {
		const previous = clients.get(client) || Promise.resolve();
		let release;
		clients.set(
			client,
			new Promise((resolve) => {
				release = resolve;
			})
		);
		await previous;
		try {
			while (!failure && cursor < rows.length) {
				await assertOwned();
				if (failure || cursor >= rows.length) break;
				const archive = rows[cursor++];
				if (
					(await deps.hashRemote(
						client,
						deps.storagePath(connection, 'audio', archive.object_key),
						connection
					)) !== archive.remote_sha256
				)
					throw new Error('Recovery archive changed.');
				await assertOwned();
			}
		} catch (error) {
			fail(error);
		} finally {
			release();
		}
	}
	async function session(connect) {
		let running;
		try {
			await connect((client) => {
				// A transport deadline may settle before a delayed callback starts.
				if (failure) return Promise.reject(failure);
				running = worker(client);
				return running;
			});
		} catch (error) {
			fail(error);
		} finally {
			// Never publish or release backup resources while a timed-out callback is still active.
			await running?.catch(fail);
		}
	}
	await Promise.all([
		session((callback) => callback(coordinator)),
		...Array.from({ length: Math.min(4, rows.length) - 1 }, () =>
			session((callback) => deps.withStorage(connection, callback))
		)
	]);
	if (failure) throw failure;
}
