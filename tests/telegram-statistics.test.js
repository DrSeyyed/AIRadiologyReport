import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { initializeSchema } from '../scripts/initialize-schema.mjs';
import {
	handleTelegramStatistics,
	isTelegramStatisticsCommand
} from '../src/lib/server/telegram-statistics.js';
import { getApprovedTelegramUser } from '../src/lib/server/telegram-registration.js';
import { getStudyStatistics } from '../src/lib/server/study-statistics.js';
import { statisticsMetrics } from '../src/lib/study-statistics-options.js';

const now = new Date('2026-11-13T12:00:00Z');
function fixture(t) {
	const db = new Database(':memory:');
	initializeSchema(db, readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
	t.after(() => db.close());
	db.exec(`INSERT INTO users(id, full_name, role, telegram_user_id) VALUES
		(1,'Private admin','admin','101'),(2,'Private resident','resident','102'),
		(3,'Private attending','attending','103'),(4,'Private typist','typist','104'),
		(5,'Other resident','resident','105');
		INSERT INTO telegram_registrations(telegram_user_id,user_id,role,step) VALUES
		('101',1,'resident','approved'),('102',2,'resident','approved'),
		('103',3,'attending','approved'),('104',4,'typist','approved'),('105',5,'resident','pending');`);
	const sent = [];
	const options = { now, send: async (...args) => sent.push(args) };
	const update = (text = '/stats', id = 102) => ({
		update_id: 11,
		message: {
			message_id: 11,
			chat: { id, type: 'private' },
			from: { id, is_bot: false, username: 'untrusted' },
			text
		}
	});
	const run = (text, id, extra = {}) =>
		handleTelegramStatistics(db, update(text, id), { ...options, ...extra });
	return { db, sent, options, update, run };
}

test('only recognized statistics commands are consumed, including optional bot suffix and alias', async (t) => {
	const { db, options, update } = fixture(t);
	for (const text of ['/stats', '/stats today', '/statistics help', '/STATS@Synthetic_bot week'])
		assert.equal(isTelegramStatisticsCommand(text), true);
	for (const text of ['/statsx', 'stats', '/start', '/register', '/stats@bad-bot', null]) {
		assert.equal(isTelegramStatisticsCommand(text), false);
		assert.equal(await handleTelegramStatistics(db, update(text), options), false);
	}
});

test('rejects groups, edited updates, forged identities, unsafe IDs and bots before database or send', async (t) => {
	const { update, options, sent } = fixture(t);
	const message = update().message;
	const invalid = [
		{ edited_message: message },
		{ message, edited_message: message },
		...[null, 'group', 'supergroup', 'channel'].map((type) => ({
			message: { ...message, chat: { id: 102, type } }
		})),
		{ message: { ...message, edit_date: 12 } },
		{ message: { ...message, sender_chat: { id: 102 } } },
		{ message: { ...message, from: { id: 102, is_bot: true } } },
		{ message: { ...message, from: { id: 102 } } },
		...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '102', 103].map((id) => ({
			message: { ...message, chat: { id, type: 'private' } }
		})),
		...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '102'].map((id) => ({
			message: { ...message, from: { id, is_bot: false } }
		})),
		{ message: { ...message, message_id: 0 } }
	];
	const noDb = { prepare: () => assert.fail('Invalid identity reached database') };
	for (const value of invalid)
		assert.equal(await handleTelegramStatistics(noDb, value, options), false);
	assert.deepEqual(sent, []);
});

test('approved linked current website identities alone choose scope, including promoted administrators', async (t) => {
	const { db, run, sent } = fixture(t);
	assert.equal(getApprovedTelegramUser(db, 101), undefined, 'voice permissions must not expand');
	for (const [id, role] of [
		[101, 'admin'],
		[102, 'resident'],
		[103, 'attending'],
		[104, 'typist']
	]) {
		await run('/stats', id, {
			service: (database, user, params, clock) => {
				assert.equal(database, db);
				assert.deepEqual(user, { id: id - 100, role });
				assert.equal(clock.now, now);
				return getStudyStatistics(database, user, params, clock);
			}
		});
		assert.equal(sent.at(-1)[0], String(id));
	}
	assert.doesNotMatch(JSON.stringify(sent), /Private admin|Private resident|untrusted/);
	db.exec("UPDATE users SET role='admin' WHERE id=2");
	await run('/stats', 102);
	assert.match(sent.at(-1)[1], /Scope: All studies/);
	const forbiddenService = () => assert.fail('Unapproved user reached statistics service');
	for (const id of [105, 999]) {
		await run('/stats', id, { service: forbiddenService });
		assert.match(sent.at(-1)[1], /approved Telegram registration/);
	}
	db.exec("UPDATE users SET telegram_user_id='202' WHERE id=2");
	for (const id of [102, 202]) {
		await run('/stats', id, { service: forbiddenService });
		assert.match(sent.at(-1)[1], /approved Telegram registration/);
	}
	db.exec("UPDATE telegram_registrations SET step='rejected' WHERE user_id=3");
	await run('/stats help', 103, { service: forbiddenService });
	assert.match(sent.at(-1)[1], /approved Telegram registration/);
});

test('maps every preset and inclusive Jalali custom dates, with no user-supplied scope', async (t) => {
	const { db, run, sent } = fixture(t);
	for (const [command, expected] of [
		['/stats', { date_range: '7-days' }],
		['/stats today', { date_range: 'today' }],
		['/stats 3d', { date_range: '3-days' }],
		['/stats week', { date_range: '7-days' }],
		['/stats month', { date_range: '30-days' }],
		['/statistics YEAR', { date_range: '365-days' }],
		[
			'/stats 1405-08-01 1405-08-22',
			{ date_range: 'custom', date_from: '1405-08-01', date_to: '1405-08-22' }
		]
	]) {
		await run(command, 102, {
			service: (database, user, params, clock) => {
				assert.deepEqual(Object.fromEntries(params), expected);
				return getStudyStatistics(database, user, params, clock);
			}
		});
		assert.match(sent.at(-1)[1], /Asia\/Tehran/);
	}
	for (const command of [
		'/stats admin',
		'/stats week 101',
		'/stats user_id=1',
		'/stats 1405-13-01 1405-13-02',
		'/stats 1405-08-22 1405-08-01',
		'/stats 1405-8-01 1405-08-22',
		'/stats 1405-12-30 1405-12-30'
	]) {
		await run(command, 102);
		assert.match(sent.at(-1)[1], /Invalid statistics date range or command/);
	}
	await run('/stats help', 102, { service: () => assert.fail('Help should not aggregate') });
	assert.match(sent.at(-1)[1], /last 7 days/);
	assert.match(sent.at(-1)[1], /inclusive Jalali/);
	assert.match(sent.at(-1)[1], /Private summaries only/);
	assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_registrations').get().n, 5);
});

test('real statistics remain role-scoped and contain aggregate counts without patient data', async (t) => {
	const { db, run, sent } = fixture(t);
	db.exec(`INSERT INTO studies(id,patient_code,patient_fullname,exam_date_jalali,exam_time,corresponding_resident_id,corresponding_attending_id,disabled,needs_attention) VALUES
		(1,'SECRET-PATIENT-1','Sensitive Name','1405-08-22','10:00:00',2,3,0,1),
		(2,'SECRET-PATIENT-2','Sensitive Name','1405-08-22','10:00:00',5,NULL,0,0),
		(3,'SECRET-PATIENT-3','Sensitive Name','1405-08-22','10:00:00',5,NULL,0,0),
		(4,'SECRET-PATIENT-4','Sensitive Name','1405-08-22','10:00:00',NULL,NULL,1,1),
		(5,'SECRET-PATIENT-5','Sensitive Name','1404-01-01','10:00:00',2,3,0,0);
		INSERT INTO study_recordings(study_id,corresponding_resident_id,typist_checked,typist_signed_by_user_id,text_report_path) VALUES
		(2,2,1,4,'secret-report-path'),(2,2,1,4,NULL),(3,5,0,4,NULL);`);
	for (const [id, expected, scope] of [
		[101, 4, 'All studies'],
		[102, 2, 'Your assigned studies'],
		[103, 1, 'Your assigned studies'],
		[104, 1, 'Studies with your current personal signature']
	]) {
		await run('/stats 1405-08-22 1405-08-22', id);
		const text = sent.at(-1)[1];
		assert.match(text, new RegExp(`Total studies: ${expected}\\n`));
		assert.ok(text.includes(`Scope: ${scope}`));
		for (const { label } of statisticsMetrics) assert.ok(text.includes(`${label}: `));
		assert.doesNotMatch(text, /SECRET|Sensitive|secret-report-path/);
	}
	db.exec('UPDATE study_recordings SET typist_checked=0 WHERE study_id=2');
	await run('/stats 1405-08-22 1405-08-22', 104);
	assert.match(sent.at(-1)[1], /Total studies: 0\n/);
});

test('service errors are sanitized and sending failures remain retryable', async (t) => {
	const { run, sent } = fixture(t);
	for (const status of [400, 401, 403, 500, undefined]) {
		await run('/stats', 102, {
			service: () => {
				throw Object.assign(new Error('SELECT secret password token FROM patients'), { status });
			}
		});
		assert.doesNotMatch(sent.at(-1)[1], /SELECT|password|token|patients/);
		assert.match(
			sent.at(-1)[1],
			status === 400
				? /Invalid statistics/
				: [401, 403].includes(status)
					? /access is unavailable/
					: /temporarily unavailable/
		);
	}
	await assert.rejects(
		run('/stats', 102, {
			send: async () => {
				throw new Error('Send failed');
			}
		}),
		/Send failed/
	);
});
