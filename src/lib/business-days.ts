import { addDays, isoDate, parseIso } from './dates';

/** ISO date of the nth (1-based; −1 = last) given weekday (0 = Sunday) of a month. */
function nthWeekday(year: number, month0: number, weekday: number, n: number): string {
	if (n > 0) {
		const first = new Date(Date.UTC(year, month0, 1));
		const offset = (weekday - first.getUTCDay() + 7) % 7;
		return isoDate(new Date(Date.UTC(year, month0, 1 + offset + (n - 1) * 7)));
	}
	const last = new Date(Date.UTC(year, month0 + 1, 0));
	const back = (last.getUTCDay() - weekday + 7) % 7;
	return isoDate(new Date(Date.UTC(year, month0 + 1, 0 - back)));
}

/** A fixed-date holiday falling on Saturday is observed the Friday before, on Sunday the Monday after. */
function observed(iso: string): string {
	const dow = parseIso(iso).getUTCDay();
	return dow === 6 ? addDays(iso, -1) : dow === 0 ? addDays(iso, 1) : iso;
}

const cache = new Map<number, Set<string>>();

/** US federal holidays observed inside `year`, including a New Year's Day of `year + 1` observed on Dec 31. */
export function usFederalHolidays(year: number): Set<string> {
	const hit = cache.get(year);
	if (hit) return hit;
	const y = String(year);
	const days = [
		observed(`${y}-01-01`), nthWeekday(year, 0, 1, 3), nthWeekday(year, 1, 1, 3), nthWeekday(year, 4, 1, -1),
		observed(`${y}-06-19`), observed(`${y}-07-04`), nthWeekday(year, 8, 1, 1), nthWeekday(year, 9, 1, 2),
		observed(`${y}-11-11`), nthWeekday(year, 10, 4, 4), observed(`${y}-12-25`), observed(`${year + 1}-01-01`)
	].filter((d) => d.startsWith(y));
	const set = new Set(days);
	cache.set(year, set);
	return set;
}

export function isBusinessDay(iso: string): boolean {
	const dow = parseIso(iso).getUTCDay();
	return dow !== 0 && dow !== 6 && !usFederalHolidays(+iso.slice(0, 4)).has(iso);
}

/**
 * Where a deposit whose nominal date is `iso` lands when it settles `n` business days later. A weekend
 * nominal date rolls to the next weekday first — that day counts as day zero even when it is a holiday —
 * and then `n` business days are added, skipping weekends and US federal holidays. Fitted to two years of
 * semi-monthly payroll deposits; see business-days.test.ts.
 */
export function landOnBusinessDays(iso: string, n: number): string {
	let d = iso;
	while ([0, 6].includes(parseIso(d).getUTCDay())) d = addDays(d, 1);
	for (let k = 0; k < n; ) {
		d = addDays(d, 1);
		if (isBusinessDay(d)) k++;
	}
	return d;
}
