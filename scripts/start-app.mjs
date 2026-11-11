import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeIntegrationSettings } from '../src/lib/server/integration-settings.js';

const RESTORE_DATA_ROOTS = ['db', 'uploads', 'voice', 'restore-staging'];
// Unknown and memory/pseudo filesystems cannot establish durable activation support.
const PERSISTENT_FILESYSTEMS = new Set([
	'ext2',
	'ext3',
	'ext4',
	'xfs',
	'btrfs',
	'zfs',
	'nfs',
	'nfs4',
	'cifs',
	'smb3',
	'f2fs',
	'jfs',
	'reiserfs',
	'bcachefs',
	'fuseblk',
	'fuse.sshfs',
	'fuse.ceph',
	'ceph',
	'9p',
	'virtiofs'
]);

function mountPath(encoded) {
	if (encoded.replace(/\\[0-7]{3}/g, '').includes('\\')) throw new Error('Invalid mount path');
	const decoded = encoded.replace(/\\([0-7]{3})/g, (_, octal) =>
		String.fromCharCode(parseInt(octal, 8))
	);
	if (!posix.isAbsolute(decoded) || decoded.includes('\0')) throw new Error('Invalid mount path');
	return posix.resolve(decoded);
}

/** Conservatively establishes storage capability from Linux mountinfo, without Docker access. */
export async function detectRestoreDataPersistence({
	cwd = process.cwd(),
	platform = process.platform,
	readMountInfo = () => readFile('/proc/self/mountinfo', 'utf8'),
	roots = RESTORE_DATA_ROOTS
} = {}) {
	if (platform !== 'linux' || !posix.isAbsolute(cwd)) return false;
	try {
		const contents = await readMountInfo();
		if (typeof contents !== 'string' || !contents.trim()) return false;
		const mounts = contents
			.trim()
			.split('\n')
			.map((line) => {
				const fields = line.trim().split(/ +/);
				const separator = fields.indexOf('-');
				if (separator < 6 || fields.length < separator + 4 || !/^\d+$/.test(fields[0])) {
					throw new Error('Unsupported mountinfo');
				}
				mountPath(fields[3]);
				return {
					path: mountPath(fields[4]),
					persistent:
						PERSISTENT_FILESYSTEMS.has(fields[separator + 1]) &&
						fields[5].split(',').includes('rw') &&
						fields[separator + 3].split(',').includes('rw')
				};
			});
		if (!mounts.some((mount) => mount.path === '/')) return false;
		if (new Set(mounts.map((mount) => mount.path)).size !== mounts.length) return false;
		mounts.sort((a, b) => b.path.length - a.path.length);
		const covers = (ancestor, target) =>
			ancestor === target || target.startsWith(`${ancestor === '/' ? '' : ancestor}/`);
		return roots.every((name) => {
			const root = posix.resolve(cwd, name);
			const covering = mounts.find((mount) => covers(mount.path, root));
			return (
				covering?.path !== '/' &&
				covering?.persistent === true &&
				!mounts.some((mount) => covers(root, mount.path) && !mount.persistent)
			);
		});
	} catch {
		return false;
	}
}

function observeChild(child) {
	const state = { child, exited: false, error: null };
	state.done = new Promise((resolveExit) => {
		child.once('exit', (code, signal) => {
			state.exited = true;
			resolveExit({ code, signal });
		});
		child.on('error', (error) => {
			state.error = error;
			// A failed spawn has no process to wait for or terminate.
			if (!child.pid) {
				state.exited = true;
				resolveExit({ code: 1 });
			}
		});
	});
	return state;
}

async function within(promise, milliseconds, message, signal) {
	let timer;
	let onAbort;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), milliseconds);
				onAbort = () => reject(new Error('Operation interrupted'));
				signal?.addEventListener('abort', onAbort, { once: true });
				if (signal?.aborted) onAbort();
			})
		]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	}
}

async function stopChild(state, signal, shutdownTimeoutMs, killTimeoutMs) {
	if (!state || state.exited) return;
	try {
		state.child.kill(signal);
		await within(state.done, shutdownTimeoutMs, 'Shutdown timed out');
	} catch {
		state.child.kill('SIGKILL');
		await within(state.done, killTimeoutMs, 'Child did not stop after SIGKILL');
	}
}

export function probeRestoreHealth({ port, token, signal, timeoutMs = 1000 }) {
	return new Promise((resolveProbe) => {
		const request = http.get(
			{
				hostname: '127.0.0.1',
				port,
				path: '/__restore-health',
				headers: { 'x-restore-startup-token': token },
				signal
			},
			(response) => {
				const ready = response.statusCode === 204;
				response.resume();
				resolveProbe(ready);
			}
		);
		const timer = setTimeout(() => request.destroy(), timeoutMs);
		request.once('close', () => clearTimeout(timer));
		request.once('error', () => resolveProbe(false));
	});
}

async function waitForReadiness(state, options) {
	const deadline = Date.now() + options.readinessTimeoutMs;
	while (Date.now() < deadline) {
		if (state.exited || state.error) throw new Error('Server exited before readiness');
		const ready = await within(
			options.checkHealth(options),
			Math.max(1, deadline - Date.now()),
			'Server readiness timed out',
			options.signal
		);
		if (state.exited || state.error) throw new Error('Server exited before readiness');
		if (ready) return;
		await new Promise((resolvePoll) => {
			const timer = setTimeout(
				done,
				Math.min(options.pollIntervalMs, Math.max(1, deadline - Date.now()))
			);
			function done() {
				clearTimeout(timer);
				options.signal.removeEventListener('abort', done);
				resolvePoll();
			}
			options.signal.addEventListener('abort', done, { once: true });
			if (options.signal.aborted) done();
		});
		if (options.signal.aborted) throw new Error('Readiness interrupted');
	}
	throw new Error('Server readiness timed out');
}

/** Offline activation must finish before either database script or the web runtime is imported. */
export async function superviseApp({
	cwd = process.cwd(),
	env = process.env,
	spawnProcess = spawn,
	signalSource = process,
	activationApi,
	initializeConfiguration = initializeIntegrationSettings,
	detectConfigurationPersistence = (options) =>
		detectRestoreDataPersistence({ ...options, roots: ['config'] }),
	detectPersistence = detectRestoreDataPersistence,
	checkHealth = probeRestoreHealth,
	readinessTimeoutMs = 120_000,
	pollIntervalMs = 250,
	shutdownTimeoutMs = 35_000,
	killTimeoutMs = 5000,
	logger = console
} = {}) {
	let active;
	let activation;
	let finalized = false;
	let failed = false;
	let interruption;
	let resolveInterrupt;
	const interrupted = new Promise((resolveSignal) => {
		resolveInterrupt = resolveSignal;
	});
	const controller = new AbortController();
	const interrupt = (reason) => {
		if (interruption) return;
		interruption = reason;
		controller.abort();
		resolveInterrupt();
	};
	const onTerm = () => interrupt({ signal: 'SIGTERM', code: 143 });
	const onInt = () => interrupt({ signal: 'SIGINT', code: 130 });
	signalSource.on('SIGTERM', onTerm);
	signalSource.on('SIGINT', onInt);
	const checkInterrupted = () => {
		if (interruption) throw new Error('Startup interrupted');
	};
	const interruptible = (promise) =>
		Promise.race([
			promise,
			interrupted.then(() => {
				throw new Error('Startup interrupted');
			})
		]);
	const launch = (args, childEnv, ipc = false) => {
		checkInterrupted();
		active = observeChild(
			spawnProcess(process.execPath, args, {
				cwd,
				env: childEnv,
				// The supervisor owns stdin; sharing its active pipe can stall Node's Windows ESM loader.
				stdio: ipc ? ['ignore', 'inherit', 'inherit', 'ipc'] : 'inherit'
			})
		);
		return active;
	};
	let exitCode = 1;
	try {
		if (
			env.REQUIRE_PRIVATE_CONFIG_VOLUME === '1' &&
			(await interruptible(detectConfigurationPersistence({ cwd }))) !== true
		) {
			throw Object.assign(new Error('Private configuration persistence is required.'), {
				code: 'INTEGRATION_CONFIGURATION_INIT_FAILED'
			});
		}
		await interruptible(Promise.resolve().then(() => initializeConfiguration({ cwd })));
		checkInterrupted();
		let dataPersisted = false;
		try {
			dataPersisted = (await detectPersistence({ cwd })) === true;
		} catch {
			// Unavailable inspection disables activation, not ordinary startup.
		}
		checkInterrupted();
		activationApi ??= await import('../src/lib/server/restore-activation-files.js');
		if (dataPersisted) {
			activation = await activationApi.applyPendingActivation({ cwd });
		} else {
			// Read-only inspection must precede even crash recovery on changed/ephemeral mounts.
			const status = await activationApi.activationStatus({ cwd });
			if (status && !['idle', 'completed', 'rolled_back'].includes(status.state)) {
				throw new Error('Pending activation requires persistent data mounts');
			}
		}
		checkInterrupted();
		for (const script of ['scripts/init-db.mjs', 'scripts/seed.mjs']) {
			const stage = launch([script], env);
			const result = await interruptible(stage.done);
			if (stage.error || result.code !== 0) throw new Error('Database initialization failed');
		}
		const token = randomBytes(32).toString('hex');
		const port = env.PORT || '5173';
		const server = launch(
			['build', '--host', '0.0.0.0', '--port', port],
			{
				...env,
				PORT: port,
				RESTORE_ACTIVATION_SUPERVISED: '1',
				RESTORE_ACTIVATION_DATA_PERSISTED: dataPersisted ? '1' : '0',
				RESTORE_ACTIVATION_PENDING: activation?.id || '',
				RESTORE_STARTUP_TOKEN: token
			},
			true
		);
		server.child.on('message', (message) => {
			if (
				message?.type === 'restore-activation-requested' &&
				typeof message.id === 'string' &&
				message.id
			) {
				// The runtime sends this only after persisting the request and draining its work.
				interrupt({ signal: 'SIGTERM', code: 1 });
			}
		});
		await interruptible(
			Promise.race([
				waitForReadiness(server, {
					port,
					token,
					signal: controller.signal,
					checkHealth,
					readinessTimeoutMs,
					pollIntervalMs
				}),
				server.done.then(() => {
					throw new Error('Server exited before readiness');
				})
			])
		);
		checkInterrupted();
		if (server.exited || server.error)
			throw new Error('Server exited before activation confirmation');
		if (activation) {
			await interruptible(activationApi.finalizeActivation({ cwd, id: activation.id }));
			finalized = true;
			checkInterrupted();
			if (server.exited || server.error)
				throw new Error('Server exited during activation finalization');
			await interruptible(
				new Promise((resolveSend, rejectSend) => {
					server.child.send(
						{ type: 'restore-activation-confirmed', id: activation.id },
						(error) => {
							if (error) rejectSend(error);
							else resolveSend();
						}
					);
				})
			);
		}
		const result = await interruptible(server.done);
		exitCode = result.code > 0 ? result.code : 1;
	} catch (cause) {
		failed = true;
		if (!interruption)
			logger.error(
				cause?.code === 'INTEGRATION_CONFIGURATION_INIT_FAILED'
					? 'Private integration configuration initialization failed. Check the /app/config persistent volume mount and permissions, the retained server encryption key and legacy settings. No credentials were reset.'
					: 'Application startup or supervision failed.'
			);
	} finally {
		controller.abort();
		let stopped = false;
		try {
			await stopChild(active, interruption?.signal || 'SIGTERM', shutdownTimeoutMs, killTimeoutMs);
			stopped = true;
		} catch {
			logger.error('Child termination could not be confirmed; activation journal retained.');
			exitCode = 1;
		}
		if (failed && !interruption && activation && !finalized && stopped) {
			try {
				await activationApi.rollbackActivation({ cwd, id: activation.id });
			} catch {
				logger.error('Activation rollback failed; manual recovery may be required.');
			}
		}
		signalSource.removeListener('SIGTERM', onTerm);
		signalSource.removeListener('SIGINT', onInt);
	}
	return interruption?.code || exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = await superviseApp();
}
