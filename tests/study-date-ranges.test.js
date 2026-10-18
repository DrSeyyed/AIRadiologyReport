import test from 'node:test';
import assert from 'node:assert/strict';
import { examinationDateRange, studyDatePresets } from '../src/lib/study-date-ranges.js';
import { normalizeStudySort, studySortHref, studySortOptions } from '../src/lib/study-sorting.js';

const now = new Date('2026-10-18T12:00:00Z');

test('quick examination ranges include today and exactly the requested number of civil days', () => {
	const expected = [
		['1405-07-26', '1405-07-26'], ['1405-07-25', '1405-07-25'],
		['1405-07-24', '1405-07-26'], ['1405-07-20', '1405-07-26'],
		['1405-06-28', '1405-07-26'], ['1404-07-27', '1405-07-26']
	];
	for (const [index, preset] of studyDatePresets.entries())
		assert.deepEqual(examinationDateRange(preset.value, now), { date_from: expected[index][0], date_to: expected[index][1] }, preset.value);
	assert.equal(examinationDateRange('', now), null);
	assert.throws(() => examinationDateRange('invalid', now), /Invalid examination date range/);
});

test('today follows Tehran midnight regardless of the server or browser timezone', () => {
	assert.equal(examinationDateRange('today', new Date('2026-10-17T20:29:59Z')).date_from, '1405-07-25');
	assert.equal(examinationDateRange('today', new Date('2026-10-17T20:30:00Z')).date_from, '1405-07-26');
});

test('ranges cross Jalali year and leap-day boundaries without losing days', () => {
	assert.deepEqual(examinationDateRange('yesterday', new Date('2025-03-21T12:00:00Z')), { date_from: '1403-12-30', date_to: '1403-12-30' });
	assert.deepEqual(examinationDateRange('3-days', new Date('2026-03-21T12:00:00Z')), { date_from: '1404-12-28', date_to: '1405-01-01' });
});

test('header sort links toggle direction, reset pagination and preserve all filters', () => {
	const search = '?date_range=7-days&date_from=1405-07-20&date_to=1405-07-26&favorites=4&patient_fullname=Ali+Ahmadi&corresponding_resident_id=2&resident_checked=0&rowcount=10&page=3';
	const first = new URL(studySortHref(search, 's.patient_fullname', 's.exam_date_jalali', 'DESC'), 'http://localhost');
	assert.equal(first.searchParams.get('orderedby'), 's.patient_fullname');
	assert.equal(first.searchParams.get('orderdir'), 'ASC');
	assert.equal(first.searchParams.get('page'), '1');
	for (const [key, value] of new URLSearchParams(search))
		if (key !== 'page') assert.equal(first.searchParams.get(key), value);
	const next = new URL(studySortHref(first.search, 's.patient_fullname', 's.patient_fullname', 'ASC'), 'http://localhost');
	assert.equal(next.searchParams.get('orderdir'), 'DESC');
	for (const { value } of studySortOptions) assert.equal(normalizeStudySort(value), value);
	assert.equal(normalizeStudySort('p.firstname'), 's.patient_fullname');
	assert.equal(normalizeStudySort('s.patient_firstname'), 's.patient_fullname');
	assert.equal(normalizeStudySort('s.id; DROP TABLE studies'), 's.exam_date_jalali');
});
