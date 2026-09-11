import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { createTransaction } from '../ledger/transactions';
import { createBill } from '../bills/bills';
import { ensurePeriods } from '../budget/periods';
import { recurringView } from './recurring';

describe('recurringView (P3 §3.3)', () => {
	it('lists recurring payees over the last twelve months and marks those with a matching bill as covered', () => {
		const f = fixture(); ensurePeriods(f.db, 'semi_monthly', '2026-05-01', '2026-10-31');
		const add = (date: string, amount: number, payee: string, cat = f.groceries, account = f.card) =>
			createTransaction(f.db, { accountId: account, externalId: `${date}-${payee}`, postedDate: date, amount, payeeRaw: payee.toUpperCase(), payee, source: 'sync', splits: [{ categoryId: cat, amount }] });
		for (const d of ['2026-06-05', '2026-07-05', '2026-08-05', '2026-09-05']) add(d, -1599, 'Netflix');
		for (const d of ['2026-07-01', '2026-08-01', '2026-09-01']) add(d, -227445, 'Landlord', f.rent, f.checking);   // bill kind: excluded by default
		for (const d of ['2026-05-12', '2026-06-12', '2026-07-12']) add(d, -9800, 'Water Co');
		createBill(f.db, { name: 'Water', categoryId: f.rent, payFromAccountId: f.checking, expectedAmount: 9800, cadence: 'monthly', dueDay: 12, matchPattern: 'water' });
		const v = recurringView(f.db, { todayIso: '2026-09-11' });
		expect(v.windowStart).toBe('2025-10-01');
		expect(v.rows.map((r) => [r.payee, r.cadence, r.covered, r.overdue])).toEqual([['Netflix', 'monthly', false, false], ['Water Co', 'monthly', true, true]]);
		expect(v.totals).toEqual({ monthly: 1599 + 9800, newMonthly: 1599, count: 2, newCount: 1, overdue: 1 });
		expect(recurringView(f.db, { todayIso: '2026-09-11', includeExcluded: true }).rows.map((r) => r.payee)).toEqual(['Landlord', 'Netflix', 'Water Co']);
	});
});
