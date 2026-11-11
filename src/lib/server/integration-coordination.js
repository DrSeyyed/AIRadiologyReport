let serial = Promise.resolve();
let active = false;

export function isIntegrationConfigurationBusy() {
	return active;
}

export function withIntegrationConfigurationLock(operation) {
	const pending = serial.then(async () => {
		active = true;
		try {
			return await operation();
		} finally {
			active = false;
		}
	});
	serial = pending.catch(() => {});
	return pending;
}
