import { describe, it, expect } from 'vitest';
import { detectRecurring } from './recurring';

const opts = { todayIso: '2026-09-11', isCovered: () => false };
const series = (payee: string, dates: string[], amount: number | number[]) => dates.map((date, i) => ({ date, payee, amount: Array.isArray(amount) ? amount[i] : amount }));

describe('detectRecurring (P3 §3.3)', () => {
	it('finds a monthly subscription even with one skipped month', () => {
		const r = detectRecurring(series('Netflix', ['2026-03-05', '2026-04-05', '2026-05-05', '2026-07-05', '2026-08-05'], 1599), opts);
		expect(r).toHaveLength(1);
		expect(r[0]).toMatchObject({ payee: 'Netflix', cadence: 'monthly', count: 5, typical: 1599, last: '2026-08-05', next: '2026-09-04', overdue: true, covered: false, monthlyCost: 1599, matched: 3, intervals: 4 });
	});
	it('rejects varying amounts and finds a yearly charge from two occurrences', () => {
		const coffee = series('Cafe', ['2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29'], [450, 900, 300, 1200, 650]);
		const domain = series('Namecheap', ['2025-09-10', '2026-09-09'], 1499);
		const r = detectRecurring([...coffee, ...domain], opts);
		expect(r.map((x) => [x.payee, x.cadence, x.monthlyCost, x.overdue])).toEqual([['Namecheap', 'yearly', 125, false]]);
	});
	it('marks covered payees, ignores same-day duplicates, and sorts new first then by monthly cost', () => {
		const charges = [
			...series('Hetzner', ['2026-06-01', '2026-07-01', '2026-07-01', '2026-08-01', '2026-09-01'], 1559),
			...series('Gym', ['2026-06-03', '2026-07-03', '2026-08-03', '2026-09-03'], 4500),
			...series('Water Co', ['2026-06-12', '2026-07-12', '2026-08-12'], [9773, 9315, 9900])
		];
		const r = detectRecurring(charges, { ...opts, isCovered: (p) => p === 'Water Co' });
		expect(r.map((x) => [x.payee, x.count, x.covered])).toEqual([['Gym', 4, false], ['Hetzner', 4, false], ['Water Co', 3, true]]);
	});
	it('needs three charges for anything but yearly and a regular interval', () => {
		expect(detectRecurring(series('X', ['2026-08-01', '2026-09-01'], 1000), opts)).toEqual([]);
		expect(detectRecurring(series('Y', ['2026-05-01', '2026-05-20', '2026-07-09', '2026-09-01'], 1000), opts)).toEqual([]);
	});
});
