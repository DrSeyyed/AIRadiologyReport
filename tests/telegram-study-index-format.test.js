import test from 'node:test';
import assert from 'node:assert/strict';
import {
	clinicalDayForStudy,
	clinicalDayTopicName,
	buildTelegramStudyIndexes
} from '../src/lib/server/telegram-study-index-format.js';

const chatId = '-1001234567890';
const study = (overrides = {}) => ({
	id: 1,
	telegram_message_id: '42',
	exam_date_jalali: '1405-07-28',
	exam_time: '10:00',
	corresponding_attending_id: 2,
	attending_fullname: 'Attending One',
	patient_code: 'CODE-1',
	patient_fullname: 'Patient One',
	modality_code: 'CT',
	description: 'Chest',
	disabled: 0,
	...overrides
});
const build = (rows) => buildTelegramStudyIndexes(rows, chatId);

function assertValidHtml(text) {
	assert.ok(text.length <= 4096, `Message has ${text.length} raw characters`);
	const stack = [];
	const plain = text.replace(/<\/?b>|<a href="https:\/\/t\.me\/c\/\d+\/\d+">|<\/a>/g, (tag) => {
		if (tag.startsWith('</')) assert.equal(stack.pop(), tag.slice(2, -1));
		else stack.push(tag.startsWith('<a ') ? 'a' : 'b');
		return '';
	});
	assert.deepEqual(stack, []);
	assert.doesNotMatch(plain.replace(/&(?:amp|lt|gt|quot|#39);/g, ''), /[<>&]/);
}

test('clinical days use local 08:00 inclusive through next-day 08:00 exclusive', () => {
	for (const [time, expected] of [
		['00:00', '1405-07-27'], ['00:00:00', '1405-07-27'],
		['07:59', '1405-07-27'], ['07:59:59', '1405-07-27'],
		['08:00', '1405-07-28'], ['08:00:00', '1405-07-28'],
		['23:59:59', '1405-07-28']
	]) assert.equal(clinicalDayForStudy(study({ exam_time: time })), expected, time);
	assert.equal(clinicalDayForStudy(study({ exam_date_jalali: ' 1405/7/8 ', exam_time: ' 08:00 ' })), '1405-07-08');
});

test('month, year and leap boundaries use the Jalali calendar', () => {
	for (const [date, expected] of [
		['1405-07-01', '1405-06-31'], ['1405-08-01', '1405-07-30'],
		['1405-01-01', '1404-12-29'], ['1404-01-01', '1403-12-30'],
		['1403-12-30', '1403-12-29'], ['1400-01-01', '1399-12-30']
	]) assert.equal(clinicalDayForStudy(study({ exam_date_jalali: date, exam_time: '00:00' })), expected, date);
	for (const [date, next] of [
		['1405-06-31', '1405/07/01'], ['1405-07-30', '1405/08/01'],
		['1404-12-29', '1405/01/01'], ['1403-12-29', '1403/12/30'],
		['1403-12-30', '1404/01/01'], ['1399-12-30', '1400/01/01']
	]) assert.equal(clinicalDayTopicName(date), `${date.replaceAll('-', '/')} 08:00 → ${next} 08:00`);
	assert.equal(clinicalDayTopicName('1405-07-28'), '1405/07/28 08:00 → 1405/07/29 08:00');
});

test('invalid stored dates and times are rejected, not repaired or timezone-converted', () => {
	for (const date of [null, undefined, '', '1405-13-01', '1405-00-01',
		'1405-07-31', '1405-12-30', '1403-12-31', '1405-01-00', '1405/07-28',
		'1405-07-28T08:00:00Z', '3178-01-01', '9999-12-31', '0000-01-01', 14050728]) {
		assert.equal(clinicalDayForStudy(study({ exam_date_jalali: date })), null, String(date));
		assert.equal(clinicalDayTopicName(date), null, String(date));
	}
	for (const time of [null, undefined, '', '8:00', '08:0', '24:00', '23:60', '08:00:60',
		'-1:00', '08:00Z', '08:00+03:30', '08:00:00.000', '08:00:00 extra', 800]) {
		assert.equal(clinicalDayForStudy(study({ exam_time: time })), null, String(time));
	}
	assert.equal(clinicalDayForStudy(null), null);
	assert.equal(clinicalDayForStudy(study({ exam_date_jalali: '2026-10-20' })), '2026-10-20');
	assert.equal(clinicalDayTopicName('3177-12-29'), null);
});

test('wall-clock results are independent of the process timezone', () => {
	const original = process.env.TZ;
	try {
		for (const timezone of ['UTC', 'Asia/Tehran', 'America/Los_Angeles']) {
			process.env.TZ = timezone;
			assert.equal(clinicalDayForStudy(study({ exam_time: '07:59:59' })), '1405-07-27');
			assert.equal(clinicalDayForStudy(study({ exam_time: '08:00' })), '1405-07-28');
		}
	} finally {
		if (original === undefined) delete process.env.TZ;
		else process.env.TZ = original;
	}
});

test('groups are keyed by attending ID even with duplicate names and sorted by day then ID', () => {
	const rows = [
		study({ id: 4, corresponding_attending_id: 10, attending_fullname: 'Same name' }),
		study({ id: 3, corresponding_attending_id: 2, attending_fullname: 'Same name' }),
		study({ id: 2, corresponding_attending_id: '2', attending_fullname: 'Same name' }),
		study({ id: 1, exam_time: '07:59', corresponding_attending_id: 99 })
	];
	const { groups, skipped } = build(rows);
	assert.equal(skipped, 0);
	assert.deepEqual(groups.map(({ day, attendingId }) => [day, attendingId]), [
		['1405-07-27', 99], ['1405-07-28', 2], ['1405-07-28', 10]
	]);
	assert.equal(groups[1].texts.join('').match(/<a href=/g).length, 2);
	assert.equal(groups[2].attendingName, 'Same name');
	assert.deepEqual(build([...rows].reverse()), build(rows));
});

test('entries sort by original calendar date and seconds with numeric ID tie-breaks', () => {
	const rows = [
		study({ id: 10, patient_code: 'ID10', exam_time: '08:00:01' }),
		study({ id: 4, patient_code: 'NEXT', exam_date_jalali: '1405-07-29', exam_time: '00:00' }),
		study({ id: 3, patient_code: 'LATE', exam_time: '23:59' }),
		study({ id: '2', patient_code: 'ID2', exam_time: '08:00:01' }),
		study({ id: 99, patient_code: 'FIRST', exam_time: '08:00' })
	];
	const result = build(rows);
	assert.equal(result.groups.length, 1);
	assert.deepEqual([...result.groups[0].texts[0].matchAll(/<a href="[^"]+">([^<]+)<\/a>/g)].map((m) => m[1]),
		['FIRST', 'ID2', 'ID10', 'LATE', 'NEXT']);
	assert.deepEqual(build([...rows].reverse()), result);
});

test('equal chronology and equal IDs retain input order without mutating rows', () => {
	const rows = Object.freeze([
		Object.freeze(study({ patient_code: 'FIRST' })),
		Object.freeze(study({ patient_code: 'SECOND' }))
	]);
	const text = build(rows).groups[0].texts[0];
	assert.ok(text.indexOf('FIRST') < text.indexOf('SECOND'));
});

test('headings and fields are escaped, with source fields and normalized patient names', () => {
	const { groups } = build([study({
		attending_fullname: '<Attending & "One">', patient_code: '<CODE & "1">',
		patient_fullname: '  Patient   <One> & Two ', source_modality: 'MR & CT',
		source_description: 'Source <description> "quoted" \'single\'',
		description: 'Not selected', modality_code: 'Not selected'
	})]);
	const text = groups[0].texts[0];
	assert.match(text, /<b>&lt;Attending &amp; &quot;One&quot;&gt;<\/b>/);
	assert.match(text, /<a href="https:\/\/t.me\/c\/1234567890\/42">&lt;CODE &amp; &quot;1&quot;&gt;<\/a>/);
	assert.match(text, /Patient &lt;One&gt; &amp; Two/);
	assert.match(text, /MR &amp; CT/);
	assert.match(text, /Source &lt;description&gt; &quot;quoted&quot; &#39;single&#39;/);
	assert.doesNotMatch(text, /Not selected/);
	assertValidHtml(text);
});

test('fallback patient names, modalities and descriptions are used for blank source fields', () => {
	const text = build([study({ patient_fullname: ' ', patient_firstname: ' First ', patient_lastname: ' Last ',
		source_modality: ' ', source_description: '' })]).groups[0].texts[0];
	assert.match(text, /First Last · CT · Chest/);
	const fallback = build([study({ patient_fullname: null, patient_code: '', attending_fullname: ' ' })]).groups[0];
	assert.equal(fallback.attendingName, 'Attending 2');
	assert.match(fallback.texts[0], />Study 1<\/a> · Unknown patient/);
});

test('legacy integer-like message IDs are normalized safely', () => {
	const valid = [42, '42', '42.0', ' 42.000 ', '00042.0', Number.MAX_SAFE_INTEGER];
	const { groups, skipped } = build(valid.map((id, index) => study({ id: index, telegram_message_id: id })));
	assert.equal(skipped, 0);
	assert.equal(groups[0].texts[0].match(/1234567890\/42"/g).length, 5);
	assert.match(groups[0].texts[0], /1234567890\/9007199254740991"/);
});

test('missing message IDs are ignored; invalid dates/times and unlinkable IDs count once each', () => {
	const missing = [null, undefined, '', '  ', '\n\t'];
	const invalid = ['0', '-1', '42.1', '1e2', '0x2a', '+42', 'NaN', 'Infinity', '9007199254740992',
		'42" onclick="bad', 'https://example.com', {}, true];
	const { groups, skipped } = build([
		...missing.map((id) => study({ telegram_message_id: id, exam_time: 'invalid' })),
		...invalid.map((id) => study({ telegram_message_id: id })),
		study({ exam_date_jalali: '1405-12-30' }), study({ exam_time: '24:00' }),
		study({ telegram_message_id: '-1', exam_time: 'bad' }), study()
	]);
	assert.equal(skipped, invalid.length + 3);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].texts[0].match(/<a href=/g).length, 1);
	assert.deepEqual(build([]), { groups: [], skipped: 0 });
});

test('links require a valid General supergroup chat ID, never arbitrary URLs', () => {
	for (const chat of ['@public', '12345', '-12345', '-1000', '-1000123', '-100123" bad', null, undefined]) {
		assert.deepEqual(buildTelegramStudyIndexes([study(), study({ telegram_message_id: '' })], chat),
			{ groups: [], skipped: 1 }, String(chat));
	}
	assert.match(buildTelegramStudyIndexes([study()], -1001234567890).groups[0].texts[0],
		/href="https:\/\/t.me\/c\/1234567890\/42"/);
});

test('unassigned studies and disabled studies remain included and explicitly labelled', () => {
	for (const disabled of [1, true, '1']) {
		const { groups, skipped } = build([study({ corresponding_attending_id: null,
			attending_fullname: 'Ignored name', disabled })]);
		assert.equal(skipped, 0);
		assert.equal(groups[0].attendingId, 0);
		assert.equal(groups[0].attendingName, 'Unassigned attending');
		assert.match(groups[0].texts[0], /<b>Unassigned attending<\/b>/);
		assert.match(groups[0].texts[0], /<b>Disabled<\/b>/);
	}
	assert.doesNotMatch(build([study({ disabled: '0' })]).groups[0].texts[0], /Disabled/);
});

test('multipage messages repeat headings and part numbers and split only between complete entries', () => {
	const rows = Array.from({ length: 140 }, (_, index) => study({
		id: index + 1, telegram_message_id: index + 1, patient_code: `CODE-${index + 1}`,
		description: 'A moderately long examination description. '.repeat(6)
	}));
	const { groups, skipped } = build(rows);
	assert.equal(skipped, 0);
	assert.equal(groups.length, 1);
	const { texts } = groups[0];
	assert.ok(texts.length > 1);
	const codes = [];
	for (const [index, text] of texts.entries()) {
		assert.ok(text.startsWith(`<b>Attending One</b>\n${clinicalDayTopicName('1405-07-28')}\nPart ${index + 1}/${texts.length}\n`));
		assertValidHtml(text);
		for (const line of text.split('\n').slice(3)) {
			assert.equal((line.match(/<a href=/g) || []).length, 1);
			assert.match(line, /<\/a> · Patient One · CT · /);
		}
		codes.push(...[...text.matchAll(/>CODE-(\d+)<\/a>/g)].map((match) => Number(match[1])));
	}
	assert.deepEqual(codes, rows.map((row) => row.id));
	assert.doesNotMatch(build([study()]).groups[0].texts[0], /Part /);
});

test('huge escaped fields remain bounded and never break HTML, links or Unicode characters', () => {
	const huge = '<>&"\'😀'.repeat(20000);
	const rows = Array.from({ length: 15 }, (_, index) => study({ id: index, telegram_message_id: index + 1,
		attending_fullname: huge, patient_code: huge, patient_fullname: huge,
		source_modality: huge, source_description: huge, disabled: 1 }));
	const { groups, skipped } = build(rows);
	assert.equal(skipped, 0);
	assert.ok(groups[0].texts.length > 1);
	let count = 0;
	for (const text of groups[0].texts) {
		assertValidHtml(text);
		assert.equal(text.isWellFormed(), true);
		assert.match(text, /…/);
		assert.match(text, /Disabled/);
		count += (text.match(/<a href=/g) || []).length;
	}
	assert.equal(count, rows.length);
});
