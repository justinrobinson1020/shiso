import { describe, it, expect } from 'vitest';
import { isoDate, addDays, endOfMonth, compareIso, isoDateInZone, todayIso } from './dates';

describe('dates', () => {
	it('formats UTC dates', () => {
		expect(isoDate(new Date(Date.UTC(2026, 8, 4)))).toBe('2026-09-04');
	});
	it('adds days across month and year boundaries', () => {
		expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
	});
	it('finds end of month including leap years', () => {
		expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
		expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
		expect(endOfMonth('2026-09-16')).toBe('2026-09-30');
	});
	it('compares lexically', () => {
		expect(compareIso('2026-01-01', '2026-01-02')).toBeLessThan(0);
		expect(compareIso('2026-01-02', '2026-01-02')).toBe(0);
	});
	it('resolves the calendar date in a zone, not UTC', () => {
		// 01:00 UTC on the 5th is still the 4th in New York.
		const instant = new Date('2026-09-05T01:00:00Z');
		expect(isoDateInZone(instant, 'America/New_York')).toBe('2026-09-04');
		expect(isoDateInZone(instant, 'UTC')).toBe('2026-09-05');
		expect(todayIso('America/New_York')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});
