import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withIntegrationConfigurationLock, isIntegrationConfigurationBusy } from '../src/lib/server/integration-coordination.js';
import { createActivationRuntime } from '../src/lib/server/restore-activation-runtime.js';

test('configuration and maintenance operations serialize and pause newly starting background work', async () => {
	let release;
	let started;
	const ready = new Promise(resolve => { started = resolve; });
	const order = [];
	const first = withIntegrationConfigurationLock(async () => {
		assert.equal(isIntegrationConfigurationBusy(), true);
		started();
		await new Promise(resolve => { release = resolve; });
		order.push('first');
	});
	await ready;
	const second = withIntegrationConfigurationLock(() => { order.push('second'); });
	const runtime = createActivationRuntime({ maintenanceEnabled: () => false });
	await runtime.background(() => assert.fail('background must wait for configuration'), { allowDuringMaintenance: true });
	release();
	await Promise.all([first, second]);
	assert.deepEqual(order, ['first', 'second']);
	assert.equal(isIntegrationConfigurationBusy(), false);
	let resumed = false;
	await runtime.background(() => { resumed = true; });
	assert.equal(resumed, true);
	await assert.rejects(withIntegrationConfigurationLock(() => { throw new Error('failure'); }));
	await withIntegrationConfigurationLock(() => { resumed = false; });
	assert.equal(resumed, false);
});

test('Telegram timers start without credentials and resume or pause when administrator changes active settings', async (t) => {
	const oldInterval = globalThis.setInterval;
	const oldToken = process.env.TELEGRAM_BOT_TOKEN;
	const oldGroup = process.env.TELEGRAM_CHAT_ID;
	const callbacks = [];
	globalThis.setInterval = (callback) => { callbacks.push(callback); return { unref() {} }; };
	delete process.env.TELEGRAM_BOT_TOKEN;
	delete process.env.TELEGRAM_CHAT_ID;
	t.after(() => {
		globalThis.setInterval = oldInterval;
		if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
		else process.env.TELEGRAM_BOT_TOKEN = oldToken;
		if (oldGroup === undefined) delete process.env.TELEGRAM_CHAT_ID;
		else process.env.TELEGRAM_CHAT_ID = oldGroup;
	});
	for (const [filename, start] of [['voice-worker.js', 'startVoiceWorker'], ['study-notifications.js', 'startStudyNotificationWorker'],
		['telegram-invitations.js', 'startGroupInvitationWorker'], ['telegram-study-refresh.js', 'startTelegramStudyRefreshWorker']]) {
		const location = new URL(`../src/lib/server/${filename}`, import.meta.url);
		const source = readFileSync(location, 'utf8').replace(/from (['"])([^'"]+)\1/g, (match, quote, specifier) => {
			if (!specifier.startsWith('.')) return match;
			return `from ${JSON.stringify(new URL(specifier, location).href)}`;
		});
		const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
		let opened = 0;
		module[start](() => { opened++; throw new Error('synthetic database marker before remote work'); });
		const tick = callbacks.at(-1);
		assert.equal(typeof tick, 'function');
		await tick();
		assert.equal(opened, 0);
		process.env.TELEGRAM_BOT_TOKEN = '12345:synthetic_bot';
		process.env.TELEGRAM_CHAT_ID = '-100123';
		await tick();
		assert.equal(opened, 1);
		delete process.env.TELEGRAM_BOT_TOKEN;
		delete process.env.TELEGRAM_CHAT_ID;
		await tick();
		assert.equal(opened, 1);
	}
	assert.equal(callbacks.length, 4);
});
