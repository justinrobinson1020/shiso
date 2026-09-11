import { describe, it, expect } from 'vitest';
import { promoTotal, accruing, interestEstimates, monthsLeft, addMonths } from './interest';

describe('interest estimates (P2 §4.1)', () => {
	it('splits owed into promo and accruing, capping promo at owed', () => {
		const promos = [{ remaining: 60000, aprBps: 0 }, { remaining: 50000, aprBps: 0 }];
		expect(promoTotal(100000, promos)).toBe(100000);
		expect(accruing(100000, promos)).toBe(0);
		expect(accruing(150000, promos)).toBe(40000);
		expect(accruing(150000, [])).toBe(150000);
	});
	it('estimates yearly, monthly and daily interest on the accruing balance plus promo rates', () => {
		expect(interestEstimates({ owed: 120000, aprBps: 2400, promos: [] })).toEqual({ yearly: 28800, monthly: 2400, daily: 79 });
		expect(interestEstimates({ owed: 120000, aprBps: 2400, promos: [{ remaining: 100000, aprBps: 0 }] })).toEqual({ yearly: 4800, monthly: 400, daily: 13 });
		expect(interestEstimates({ owed: 120000, aprBps: 2400, promos: [{ remaining: 100000, aprBps: 600 }] })).toEqual({ yearly: 4800 + 6000, monthly: 900, daily: 30 });
		expect(interestEstimates({ owed: 120000, aprBps: null, promos: [] })).toEqual({ yearly: 0, monthly: 0, daily: 0 });
		expect(interestEstimates({ owed: 0, aprBps: 2400, promos: [] })).toEqual({ yearly: 0, monthly: 0, daily: 0 });
	});
	it('counts whole months left until an expiry, never below one', () => {
		expect(monthsLeft('2026-09-11', '2027-03-15')).toBe(6);
		expect(monthsLeft('2026-09-11', '2027-03-05')).toBe(5);
		expect(monthsLeft('2026-09-11', '2026-09-20')).toBe(1);
		expect(monthsLeft('2026-09-11', '2026-08-01')).toBe(1);
	});
	it('adds months to a YYYY-MM', () => {
		expect(addMonths('2026-09', 0)).toBe('2026-09'); expect(addMonths('2026-09', 4)).toBe('2027-01'); expect(addMonths('2026-01', -1)).toBe('2025-12');
	});
});
