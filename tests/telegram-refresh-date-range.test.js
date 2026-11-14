import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramRefreshDateRange, telegramRefreshDatePresets } from '../src/lib/telegram-refresh-date-range.js';

const now = new Date('2026-10-18T12:00:00Z');

test('refresh defaults to all examination dates and offers all, standard presets and custom', () => {
	assert.deepEqual(telegramRefreshDateRange(), { preset: 'all', label: 'All examination dates', date_from: null, date_to: null });
	assert.deepEqual(telegramRefreshDatePresets.map(({ value }) => value), ['all', 'today', 'yesterday', '3-days', '7-days', '30-days', '365-days', 'custom']);
	for (const [preset, from, to] of [
		['today', '1405-07-26', '1405-07-26'], ['3-days', '1405-07-24', '1405-07-26'],
		['7-days', '1405-07-20', '1405-07-26'], ['30-days', '1405-06-28', '1405-07-26'],
		['365-days', '1404-07-27', '1405-07-26']
	]) {
		const range = telegramRefreshDateRange({ date_range: preset, date_from: 'ignored', date_to: 'ignored' }, now);
		assert.equal(range.date_from, from);
		assert.equal(range.date_to, to);
	}
});

test('refresh presets follow Tehran midnight and Jalali year boundaries', () => {
	assert.equal(telegramRefreshDateRange({ date_range: 'today' }, new Date('2026-10-17T20:29:59Z')).date_from, '1405-07-25');
	assert.equal(telegramRefreshDateRange({ date_range: 'today' }, new Date('2026-10-17T20:30:00Z')).date_from, '1405-07-26');
	const range = telegramRefreshDateRange({ date_range: '3-days' }, new Date('2026-03-21T12:00:00Z'));
	assert.equal(range.date_from, '1404-12-28');
	assert.equal(range.date_to, '1405-01-01');
});

test('custom ranges accept valid Jalali dates including single days and leap days', () => {
	for (const [from, to] of [['1403-12-30', '1404-01-01'], ['1405-01-01', '1405-01-01']]) {
		assert.deepEqual(telegramRefreshDateRange({ date_range: 'custom', date_from: from, date_to: to }),
			{ preset: 'custom', label: 'Custom range', date_from: from, date_to: to });
	}
});

test('invalid filters, dates and reversed custom bounds fail with a validation error', () => {
	for (const filters of [null, [], 'today', { date_range: [] }, { date_range: 'bad' }, { date_range: '' },
		{ date_range: 'custom' }, { date_range: 'custom', date_from: '1405-02-02', date_to: '1405-02-01' }])
		assert.throws(() => telegramRefreshDateRange(filters), { status: 400 });
	for (const date of ['1404-12-30', '1405-07-31', '1405-00-01', '1405-01-00', '1405-1-01', '9999-01-01', '1405-01-01 OR 1=1', 14050101, ['1405-01-01']]) {
		for (const key of ['date_from', 'date_to'])
			assert.throws(() => telegramRefreshDateRange({ date_range: 'custom', date_from: '1405-01-01', date_to: '1405-12-29', [key]: date }), { status: 400 });
	}
});
