import { describe, it, expect } from 'vitest';
import { trendTable } from './trends';

const months = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];

describe('trendTable (P3 §3.1)', () => {
	it('baselines exclude the current month and months before the first ledger row, and rows sort by delta', () => {
		const monthly = [
			...['2026-06', '2026-07', '2026-08'].map((month) => ({ month, categoryId: 1, categoryName: 'Groceries', amount: 40000 })),
			{ month: '2026-09', categoryId: 1, categoryName: 'Groceries', amount: 90000 },
			{ month: '2026-07', categoryId: 2, categoryName: 'Dining', amount: 20000 }, { month: '2026-08', categoryId: 2, categoryName: 'Dining', amount: 10000 }
		];
		const t = trendTable({ months, monthly, current: [{ categoryId: 1, categoryName: 'Groceries', amount: 90000 }, { categoryId: 2, categoryName: 'Dining', amount: 5000 }], rangeDays: 30, scaleToMonth: false, firstLedgerMonth: '2026-06' });
		expect(t.rows.map((r) => [r.name, r.baseline, r.delta, r.deltaPct])).toEqual([['Groceries', 40000, 50000, 1.25], ['Dining', 10000, -5000, -0.5]]);
		expect(t.rows[0].series).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 40000, 40000, 40000, 90000]);
		expect(t.totals.slice(-4)).toEqual([40000, 60000, 50000, 90000]);
		expect(t.total).toMatchObject({ name: 'All spending', current: 95000, baseline: 50000, delta: 45000 });
	});
	it('scales a short range to a month and withholds a percentage on a tiny baseline', () => {
		const t = trendTable({ months, monthly: [{ month: '2026-08', categoryId: 1, categoryName: 'Fees', amount: 500 }], current: [{ categoryId: 1, categoryName: 'Fees', amount: 1500 }], rangeDays: 15, scaleToMonth: true, firstLedgerMonth: '2026-08' });
		expect(t.rows[0]).toMatchObject({ current: 1500, currentPerMonth: 3000, baseline: 500, delta: 2500, deltaPct: null });
	});
	it('has no baseline when no history month is inside the ledger', () => {
		const t = trendTable({ months, monthly: [], current: [{ categoryId: 1, categoryName: 'A', amount: 100 }], rangeDays: 30, scaleToMonth: false, firstLedgerMonth: '2026-09' });
		expect(t.rows[0]).toMatchObject({ baseline: null, delta: null, deltaPct: null });
	});
});
