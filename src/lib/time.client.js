import { writable } from 'svelte/store';

function formatDate(d) {
	return new Intl.DateTimeFormat('fa-IR-u-nu-latn', {
		timeZone: 'Asia/Tehran',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		calendar: 'persian'
	})
		.format(d)
		.replace(/\//g, '-');
}

function formatTime(d) {
	return new Intl.DateTimeFormat('fa-IR-u-nu-latn', {
		timeZone: 'Asia/Tehran',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23'
	}).format(d);
}

function formatYear(d) {
	return Number(
		new Intl.DateTimeFormat('fa-IR-u-nu-latn', {
			timeZone: 'Asia/Tehran',
			year: 'numeric',
			calendar: 'persian'
		}).format(d)
	);
}

// Stores
export const date = writable(formatDate(new Date()));
export const time = writable(formatTime(new Date()));
export const year = writable(formatYear(new Date()));
export const datetime = writable(`${formatDate(new Date())} ${formatTime(new Date())}`);

// Auto update every second
setInterval(() => {
	const d = new Date();
	const dateStr = formatDate(d);
	const timeStr = formatTime(d);
	const yearNum = formatYear(d);

	date.set(dateStr);
	time.set(timeStr);
	year.set(yearNum);
	datetime.set(`${dateStr} ${timeStr}`);
}, 1000);
