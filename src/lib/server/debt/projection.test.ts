import { describe, it, expect } from 'vitest';
import { project, type DebtInput } from './projection';

const debt = (o: Partial<DebtInput> & { id: number }): DebtInput => ({ owed: 0, aprBps: 0, promos: [], minimum: 0, extra: 0, ...o });
const START = '2026-09';

describe('project (P2 §4.3)', () => {
	it('pays a zero-interest card off in owed ÷ minimum months', () => {
		const r = project([debt({ id: 1, owed: 100000, minimum: 10000 })], 'plan', { startMonth: START });
		expect(r.debts[0].payoffMonth).toBe('2027-06'); expect(r.totalInterest).toBe(0); expect(r.debtFreeMonth).toBe('2027-06'); expect(r.capped).toBe(false);
		expect(r.series[0]).toEqual({ month: START, owed: 100000 }); expect(r.series.at(-1)).toEqual({ month: '2027-06', owed: 0 });
	});
	it('accrues monthly interest on the accruing balance before the payment', () => {
		const r = project([debt({ id: 1, owed: 100000, aprBps: 1200, minimum: 100000 })], 'plan', { startMonth: START });
		expect(r.debts[0]).toMatchObject({ payoffMonth: '2026-10', interest: 1010 });
	});
	it('avalanche targets the highest APR and snowball the smallest balance', () => {
		const debts = [debt({ id: 1, owed: 500000, aprBps: 3000, minimum: 20000 }), debt({ id: 2, owed: 100000, aprBps: 1000, minimum: 10000 })];
		const a = project(debts, 'avalanche', { startMonth: START, pool: 50000 });
		const s = project(debts, 'snowball', { startMonth: START, pool: 50000 });
		expect(a.firstTarget).toBe(1); expect(s.firstTarget).toBe(2);
		expect(s.debts[1].payoffMonth! < s.debts[0].payoffMonth!).toBe(true);
		expect(a.totalInterest).toBeLessThanOrEqual(s.totalInterest);
		const m = project(debts, 'minimums', { startMonth: START });
		expect(m.totalInterest).toBeGreaterThan(a.totalInterest);
		expect(m.debtFreeMonth! > a.debtFreeMonth!).toBe(true);
	});
	it('rolls a paid-off minimum into the target, finishing sooner than the same extra without rollover', () => {
		const debts = [debt({ id: 1, owed: 300000, aprBps: 2000, minimum: 10000, extra: 40000 }), debt({ id: 2, owed: 100000, aprBps: 2000, minimum: 10000 })];
		const plan = project(debts, 'plan', { startMonth: START });
		const snow = project(debts, 'snowball', { startMonth: START, pool: 40000 });
		expect(snow.debtFreeMonth! < plan.debtFreeMonth!).toBe(true);
	});
	it('folds an expired promo into the accruing balance', () => {
		const d = debt({ id: 1, owed: 100000, aprBps: 2400, minimum: 1000, promos: [{ remaining: 100000, aprBps: 0, expiresOn: '2026-10-15' }] });
		const r = project([d], 'plan', { startMonth: START, maxMonths: 3 });
		// Sep: no interest (all promo), pay 1000 → 99000. Oct: same → 98000. Nov: fold; interest 98000×0.24/12 = 1960.
		expect(r.series.map((s) => s.owed)).toEqual([100000, 99000, 98000, 98960]);
		expect(r.debts[0].interest).toBe(1960); expect(r.capped).toBe(true);
	});
	it('applies the minimum to promo first and the extra to accruing first', () => {
		const d = debt({ id: 1, owed: 100000, aprBps: 0, minimum: 1000, extra: 5000, promos: [{ remaining: 40000, aprBps: 0, expiresOn: '2030-01-01' }] });
		const r = project([d], 'plan', { startMonth: START, maxMonths: 1 });
		expect(r.series[1].owed).toBe(94000); expect(r.debts[0].promoRemainingAfterFirstMonth).toBe(39000);
	});
	it('never pays off a debt with no minimum and no extra, and stops at the cap', () => {
		const r = project([debt({ id: 1, owed: 100000, aprBps: 2400, minimum: null })], 'plan', { startMonth: START, maxMonths: 12 });
		expect(r.debts[0].payoffMonth).toBeNull(); expect(r.debtFreeMonth).toBeNull(); expect(r.capped).toBe(true); expect(r.series).toHaveLength(13);
		expect(r.debts[0].interest).toBeGreaterThan(0);
	});
	it('reports a debt whose payment is below its interest as never paid off', () => {
		const r = project([debt({ id: 1, owed: 1000000, aprBps: 3000, minimum: 1000 })], 'minimums', { startMonth: START });
		expect(r.capped).toBe(true); expect(r.debts[0].payoffMonth).toBeNull(); expect(r.series).toHaveLength(601);
	});
	it('ignores debts with nothing owed', () => {
		const r = project([debt({ id: 1, owed: 0, minimum: 1000 }), debt({ id: 2, owed: 5000, minimum: 5000 })], 'plan', { startMonth: START });
		expect(r.debts.map((d) => d.id)).toEqual([2]); expect(r.debtFreeMonth).toBe(START);
	});
});
