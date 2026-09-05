import { describe, it, expect } from 'vitest';
import { openMemoryDatabase } from '../db';
import { periodBoundsFor, nextPeriodStart, ensurePeriods, periodIdForDate } from './periods';
import { periods } from '../db/schema';
import { asc } from 'drizzle-orm';

describe('periodBoundsFor', () => {
	it('splits months at the 15th', () => {
		expect(periodBoundsFor('semi_monthly', '2026-09-04')).toEqual({
			startDate: '2026-09-01', endDate: '2026-09-15', label: 'Sep 1–15, 2026'
		});
		expect(periodBoundsFor('semi_monthly', '2026-09-16')).toEqual({
			startDate: '2026-09-16', endDate: '2026-09-30', label: 'Sep 16–30, 2026'
		});
		expect(periodBoundsFor('semi_monthly', '2028-02-29').endDate).toBe('2028-02-29');
	});
	it('handles monthly cadence', () => {
		expect(periodBoundsFor('monthly', '2026-09-20')).toEqual({
			startDate: '2026-09-01', endDate: '2026-09-30', label: 'Sep 2026'
		});
	});
	it('steps to the next period', () => {
		expect(nextPeriodStart('semi_monthly', '2026-09-15')).toBe('2026-09-16');
		expect(nextPeriodStart('semi_monthly', '2026-09-30')).toBe('2026-10-01');
	});
});

describe('ensurePeriods', () => {
	it('back-fills two years of semi-monthly periods and is idempotent', () => {
		const { db } = openMemoryDatabase();
		ensurePeriods(db, 'semi_monthly', '2024-09-04', '2026-09-30');
		const rows = db.select().from(periods).orderBy(asc(periods.startDate)).all();
		expect(rows[0].startDate).toBe('2024-09-01');
		expect(rows[rows.length - 1].endDate).toBe('2026-09-30');
		expect(rows.length).toBe(50); // 25 months × 2
		ensurePeriods(db, 'semi_monthly', '2024-09-04', '2026-09-30');
		expect(db.select().from(periods).all().length).toBe(50);
	});
	it('extends forward without duplicating', () => {
		const { db } = openMemoryDatabase();
		ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-01-31');
		ensurePeriods(db, 'semi_monthly', '2026-01-20', '2026-03-31');
		expect(db.select().from(periods).all().length).toBe(6);
	});
	it('resolves a date to its period id', () => {
		const { db } = openMemoryDatabase();
		ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-02-28');
		const id = periodIdForDate(db, '2026-02-16');
		const row = db.select().from(periods).where(eqId(id)).get();
		expect(row?.startDate).toBe('2026-02-16');
		expect(() => periodIdForDate(db, '2026-03-01')).toThrow(/no period/);
	});
});

import { eq } from 'drizzle-orm';
function eqId(id: number) { return eq(periods.id, id); }
