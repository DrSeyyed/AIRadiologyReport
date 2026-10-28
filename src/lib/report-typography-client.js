import { normalizeReportTypography } from './report-copy.js';

export function createReportTypographyStorage(request = (...args) => globalThis.fetch(...args)) {
	const pending = new Map();

	function enqueue(userId, operation) {
		const task = (pending.get(userId) || Promise.resolve()).catch(() => {}).then(operation);
		pending.set(userId, task);
		const cleanup = () => {
			if (pending.get(userId) === task) pending.delete(userId);
		};
		void task.then(cleanup, cleanup);
		return task;
	}

	async function send(options) {
		const response = await request('/api/account/report-typography', {
			credentials: 'same-origin',
			cache: 'no-store',
			...options
		});
		if (!response.ok) throw new Error('Unable to save or load report font settings.');
		return normalizeReportTypography(await response.json());
	}

	return {
		load(userId) {
			return enqueue(userId, () => send({ method: 'GET' }));
		},
		save(userId, value) {
			const preferences = normalizeReportTypography(value);
			return enqueue(userId, () => send({
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(preferences)
			}));
		}
	};
}

export const reportTypographyStorage = createReportTypographyStorage();
