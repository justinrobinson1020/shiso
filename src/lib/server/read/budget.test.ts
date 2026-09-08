import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { createTransaction } from '../ledger/transactions';
import { assign } from '../ledger/assignments';
import { appendBalance } from '../sync/connections';
import { periodIdForDate } from '../budget/periods';
import { budgetView } from './budget';

describe('budgetView', () => {
	it('lays out groups with envelope numbers, RTA, and the card strip', () => {
		const f = fixture();
		const p = periodIdForDate(f.db, '2026-09-08');
		appendBalance(f.db, f.checking, { asOf: '2026-09-08', current: 100000, source: 'manual' });
		appendBalance(f.db, f.card, { asOf: '2026-09-08', current: -8000, source: 'manual' });
		assign(f.db, p, f.groceries, 5000);
		createTransaction(f.db, { accountId: f.card, externalId: 'c1', postedDate: '2026-09-03', amount: -8000, payeeRaw: 'WF', source: 'sync', splits: [{ categoryId: f.groceries, amount: -8000 }] });
		const v = budgetView(f.db, { periodId: null, todayIso: '2026-09-08', cadence: 'semi_monthly' });
		expect(v.period.id).toBe(p); expect(v.period.isCurrent).toBe(true);
		const spending = v.groups.find((g) => g.name === 'Spending')!;
		const g = spending.categories.find((c) => c.id === f.groceries)!;
		expect(g).toMatchObject({ assigned: 5000, activity: -8000, available: -3000, creditOverspend: 3000 });
		const system = v.groups.find((g) => g.name === 'System')!;
		expect(system.categories.map((c) => c.kind)).toEqual(['interest', 'fee']);
		const card = v.underfunded.find((u) => u.accountId === f.card)!;
		expect(card.owed).toBe(8000); expect(card.available).toBe(5000); expect(card.underfunded).toBe(3000);
		expect(v.readyToAssign).toBe(100000 - 5000);
		expect(v.periods.length).toBeGreaterThan(4);
	});
});
