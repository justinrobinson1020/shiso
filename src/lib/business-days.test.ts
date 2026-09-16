import { describe, it, expect } from 'vitest';
import { usFederalHolidays, isBusinessDay, landOnBusinessDays } from './business-days';

describe('usFederalHolidays', () => {
	it('lists the fixed and floating holidays for a year', () => {
		const h = usFederalHolidays(2026);
		for (const d of ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25']) expect(h.has(d), d).toBe(true);
		expect(h.size).toBe(11);
	});
	it('observes a Saturday holiday on the Friday before and a Sunday holiday on the Monday after', () => {
		expect(usFederalHolidays(2027).has('2027-06-18')).toBe(true);   // Juneteenth 2027 is a Saturday
		expect(usFederalHolidays(2027).has('2027-12-24')).toBe(true);   // Christmas 2027 is a Saturday
		expect(usFederalHolidays(2028).has('2028-11-10')).toBe(true);   // Veterans Day 2028 is a Saturday
		expect(usFederalHolidays(2022).has('2022-12-26')).toBe(true);   // Christmas 2022 is a Sunday
		expect(usFederalHolidays(2021).has('2021-12-31')).toBe(true);   // New Year's Day 2022 is a Saturday, observed the year before
	});
});

describe('isBusinessDay', () => {
	it('is false on weekends and federal holidays', () => {
		expect(isBusinessDay('2026-09-12')).toBe(false);
		expect(isBusinessDay('2026-09-13')).toBe(false);
		expect(isBusinessDay('2026-09-07')).toBe(false);
		expect(isBusinessDay('2026-09-16')).toBe(true);
	});
});

describe('landOnBusinessDays', () => {
	it('adds business days from a weekday', () => {
		expect(landOnBusinessDays('2026-09-15', 2)).toBe('2026-09-17');
		expect(landOnBusinessDays('2026-10-15', 2)).toBe('2026-10-19');   // Thursday, crosses a weekend
	});
	it('rolls a weekend date to Monday before counting', () => {
		expect(landOnBusinessDays('2026-08-15', 2)).toBe('2026-08-19');   // Saturday → Mon 17 → Wed 19
		expect(landOnBusinessDays('2026-11-15', 2)).toBe('2026-11-18');   // Sunday → Mon 16 → Wed 18
	});
	it('skips a holiday inside the count but not one on the roll day', () => {
		expect(landOnBusinessDays('2026-01-15', 2)).toBe('2026-01-20');   // MLK Day inside the count
		expect(landOnBusinessDays('2025-12-31', 2)).toBe('2026-01-05');   // New Year's inside the count
		expect(landOnBusinessDays('2026-02-15', 2)).toBe('2026-02-18');   // Sunday → Presidents Day (roll target, not skipped) → Wed 18
		expect(landOnBusinessDays('2025-08-31', 2)).toBe('2025-09-03');   // Sunday → Labor Day (roll target) → Wed 3
	});
	it('with zero days only rolls the weekend', () => {
		expect(landOnBusinessDays('2026-09-12', 0)).toBe('2026-09-14');
		expect(landOnBusinessDays('2026-09-16', 0)).toBe('2026-09-16');
	});
	it('reproduces every Accenture deposit since September 2025 from its period close', () => {
		const pairs: [string, string][] = [
			['2025-08-31', '2025-09-03'], ['2025-09-15', '2025-09-17'], ['2025-09-30', '2025-10-02'], ['2025-10-15', '2025-10-17'],
			['2025-10-31', '2025-11-04'], ['2025-11-15', '2025-11-19'], ['2025-11-30', '2025-12-03'], ['2025-12-15', '2025-12-17'],
			['2025-12-31', '2026-01-05'], ['2026-01-15', '2026-01-20'], ['2026-01-31', '2026-02-04'], ['2026-02-15', '2026-02-18'],
			['2026-02-28', '2026-03-04'], ['2026-03-15', '2026-03-18'], ['2026-03-31', '2026-04-02'], ['2026-04-15', '2026-04-17'],
			['2026-04-30', '2026-05-04'], ['2026-05-15', '2026-05-19'], ['2026-05-31', '2026-06-03'], ['2026-06-15', '2026-06-17'],
			['2026-06-30', '2026-07-02'], ['2026-07-15', '2026-07-17'], ['2026-07-31', '2026-08-04'], ['2026-08-15', '2026-08-19'],
			['2026-08-31', '2026-09-02']
		];
		for (const [close, deposit] of pairs) expect(landOnBusinessDays(close, 2), close).toBe(deposit);
	});
});
