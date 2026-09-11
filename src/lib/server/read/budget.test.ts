import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { createTransaction } from '../ledger/transactions';
import { assign } from '../ledger/assignments';
import { appendBalance } from '../sync/connections';
import { periodIdForDate } from '../budget/periods';
import { budgetView } from './budget';
import { setTarget } from '../budget/targets';
import { setSetting, BUDGET_START_KEY } from '../settings';

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

describe('budgetView targets (P4)', () => {
	it('carries each category\'s target status and the total need this period', () => {
		const f = fixture(); const p = periodIdForDate(f.db, '2026-09-08');
		setTarget(f.db, f.groceries, { kind: 'monthly', amount: 40000, targetDate: null });
		setTarget(f.db, f.rent, { kind: 'by_date', amount: 100000, targetDate: '2026-10-31' });
		assign(f.db, p, f.groceries, 5000);
		const v = budgetView(f.db, { periodId: p, todayIso: '2026-09-08', cadence: 'semi_monthly' });
		const cats = v.groups.flatMap((g) => g.categories);
		expect(cats.find((c) => c.id === f.groceries)!.target).toMatchObject({ kind: 'monthly', perPeriod: 20000, needed: 15000, progress: 0.25 });
		expect(cats.find((c) => c.id === f.rent)!.target).toMatchObject({ kind: 'by_date', periodsLeft: 4, needed: 25000 });
		expect(cats.find((c) => c.id === f.cardPay)!.target).toBeNull();
		expect(v.targetsNeeded).toBe(40000);
	});
});

describe('budgetView budget start (P5)', () => {
	it('marks a period before budget_start as history only', () => {
		const f = fixture(); setSetting(f.db, BUDGET_START_KEY, '2026-08-01');
		setTarget(f.db, f.groceries, { kind: 'monthly', amount: 40000, targetDate: null });
		const v = budgetView(f.db, { periodId: periodIdForDate(f.db, '2026-07-05'), todayIso: f.today, cadence: 'semi_monthly' });
		expect(v.historyOnly).toBe(true); expect(v.budgetStart).toBe('2026-08-01'); expect(v.groups.every((g) => g.categories.every((c) => c.available === 0 && c.assigned === 0))).toBe(true);
		expect(v.groups.every((g) => g.categories.every((c) => c.target === null))).toBe(true); expect(v.targetsNeeded).toBe(0);
		expect(budgetView(f.db, { periodId: null, todayIso: f.today, cadence: 'semi_monthly' }).historyOnly).toBe(false);
	});
});
