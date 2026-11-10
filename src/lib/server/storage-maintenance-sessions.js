import { abortStorageSession } from './storage-session.js';

// Some transports reject before their callback finishes. Maintenance must drain it before returning.
export function maintenanceTransport(transport, controller, assertActive) {
	return async (connection, operation) => {
		let running;
		try {
			const result = await transport(connection, (client) => {
				const abort = () => abortStorageSession(client);
				controller.signal.addEventListener('abort', abort, { once: true });
				if (controller.signal.aborted) abort();
				running = (async () => {
					try {
						await assertActive();
						return await operation(client);
					} catch (error) {
						controller.abort();
						throw error;
					} finally {
						controller.signal.removeEventListener('abort', abort);
					}
				})();
				return running;
			});
			await running;
			return result;
		} catch (error) {
			controller.abort();
			await running?.catch(() => {});
			throw error;
		}
	};
}
