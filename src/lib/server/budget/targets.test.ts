import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { periodIdForDate } from './periods';
import { assign, assignmentsForPeriod } from '../ledger/assignments';
import { createTransaction } from '../ledger/transactions';
import { targetStatus, periodsThrough, setTarget, clearTarget, listTargets, targetStatuses, fundTargets } from './targets';

describe('targetStatus (P4 §4)', () => {
	it('monthly halves on semi-monthly and needs the rest of the per-period share', () => {
		expect(targetStatus({ kind: 'monthly', amount: 40000, targetDate: null }, { assigned: 5000, available: 12000 }, { periodsPerMonth: 2, periodsThroughDate: 1 }))
			.toMatchObject({ perPeriod: 20000, needed: 15000, progress: 0.25 });
		expect(targetStatus({ kind: 'monthly', amount: 40000, targetDate: null }, { assigned: 40000, available: 0 }, { periodsPerMonth: 1, periodsThroughDate: 1 })).toMatchObject({ needed: 0, progress: 1 });
	});
	it('refill counts what is already available', () => {
		expect(targetStatus({ kind: 'refill', amount: 25000, targetDate: null }, { assigned: 0, available: 10000 }, { periodsPerMonth: 2, periodsThroughDate: 1 })).toMatchObject({ needed: 15000, progress: 0.4 });
		expect(targetStatus({ kind: 'refill', amount: 25000, targetDate: null }, { assigned: 0, available: -3000 }, { periodsPerMonth: 2, periodsThroughDate: 1 })).toMatchObject({ needed: 28000, progress: 0 });
	});
	it('by_date spreads what is missing over the periods left, current included, and collapses to one when the date has passed', () => {
		const t = { kind: 'by_date' as const, amount: 300000, targetDate: '2027-03-15' };
		expect(targetStatus(t, { assigned: 0, available: 60000 }, { periodsPerMonth: 2, periodsThroughDate: 12 })).toMatchObject({ periodsLeft: 12, perPeriod: 20000, needed: 20000, progress: 0.2 });
		expect(targetStatus(t, { assigned: 20000, available: 80000 }, { periodsPerMonth: 2, periodsThroughDate: 12 })).toMatchObject({ needed: 0 });
		expect(targetStatus(t, { assigned: 0, available: 250000 }, { periodsPerMonth: 2, periodsThroughDate: 0 })).toMatchObject({ periodsLeft: 1, needed: 50000 });
	});
});

describe('periodsThrough', () => {
	it('counts the current period through the one containing the date', () => {
		const f = fixture(); const p = periodIdForDate(f.db, '2026-09-08');
		expect(periodsThrough(f.db, p, '2026-09-10')).toBe(1);
		expect(periodsThrough(f.db, p, '2026-09-20')).toBe(2);
		expect(periodsThrough(f.db, p, '2026-10-31')).toBe(4);
		expect(periodsThrough(f.db, p, '2026-01-01')).toBe(1);
	});
});

describe('targets service', () => {
	it('upserts, clears, and enforces envelope, amount, and date invariants', () => {
		const f = fixture();
		setTarget(f.db, f.groceries, { kind: 'monthly', amount: 40000, targetDate: null });
		setTarget(f.db, f.groceries, { kind: 'refill', amount: 25000, targetDate: null });
		expect(listTargets(f.db).get(f.groceries)).toEqual({ kind: 'refill', amount: 25000, targetDate: null });
		expect(() => setTarget(f.db, f.income, { kind: 'monthly', amount: 100, targetDate: null })).toThrow('TARGET_NO_ENVELOPE');
		expect(() => setTarget(f.db, f.groceries, { kind: 'monthly', amount: 0, targetDate: null })).toThrow('TARGET_AMOUNT_NOT_POSITIVE');
		expect(() => setTarget(f.db, f.groceries, { kind: 'by_date', amount: 100, targetDate: null })).toThrow('TARGET_DATE_MISMATCH');
		expect(() => setTarget(f.db, f.groceries, { kind: 'monthly', amount: 100, targetDate: '2027-01-01' })).toThrow('TARGET_DATE_MISMATCH');
		clearTarget(f.db, f.groceries);
		expect(listTargets(f.db).size).toBe(0);
	});
	it('funds one or all needs on top of current assignments, idempotently', () => {
		const f = fixture(); const p = periodIdForDate(f.db, '2026-09-08');
		createTransaction(f.db, { accountId: f.checking, externalId: 'open', postedDate: '2026-09-01', amount: 500000, payeeRaw: 'Opening', source: 'opening', splits: [{ categoryId: f.uncategorized, amount: 500000 }] });
		setTarget(f.db, f.groceries, { kind: 'monthly', amount: 40000, targetDate: null });
		setTarget(f.db, f.rent, { kind: 'refill', amount: 227445, targetDate: null });
		assign(f.db, p, f.groceries, 5000);
		const st = targetStatuses(f.db, p, 'semi_monthly');
		expect(st.get(f.groceries)).toMatchObject({ needed: 15000 }); expect(st.get(f.rent)).toMatchObject({ needed: 227445 });
		expect(fundTargets(f.db, { periodId: p, cadence: 'semi_monthly', categoryId: f.groceries })).toEqual({ funded: [{ categoryId: f.groceries, amount: 15000 }] });
		expect(fundTargets(f.db, { periodId: p, cadence: 'semi_monthly' })).toEqual({ funded: [{ categoryId: f.rent, amount: 227445 }] });
		expect(fundTargets(f.db, { periodId: p, cadence: 'semi_monthly' })).toEqual({ funded: [] });
		expect(Object.fromEntries(assignmentsForPeriod(f.db, p).map((a) => [a.categoryId, a.assigned]))).toEqual({ [f.groceries]: 20000, [f.rent]: 227445 });
		expect(() => fundTargets(f.db, { periodId: p, cadence: 'semi_monthly', categoryId: f.cardPay })).toThrow('NO_TARGET');
	});
});
