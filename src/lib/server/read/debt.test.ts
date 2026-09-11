import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { appendBalance, appendTermsIfChanged, upsertAccount, updateAccount } from '../sync/connections';
import { createCategory } from '../ledger/categories';
import { createBill } from '../bills/bills';
import { periodIdForDate } from '../budget/periods';
import { setPlannedExtra, createPromo } from '../debt/plan';
import { debtView } from './debt';
import { setSetting, BUDGET_START_KEY } from '../settings';

describe('debtView', () => {
	it('assembles debts, plan, strategies, promos and trend for the period', () => {
		const f = fixture(); const p = periodIdForDate(f.db, '2026-09-08');
		const loan = upsertAccount(f.db, f.conn, { externalId: 'loan', name: 'SoFi', type: 'loan' }).id;
		updateAccount(f.db, loan, { onBudget: false, openedOn: '2024-09-01' });
		createCategory(f.db, { groupId: f.groups.debt, name: 'SoFi', kind: 'debt_payment', accountId: loan });
		appendBalance(f.db, f.checking, { asOf: '2026-09-07', current: 250000, source: 'manual' });
		appendBalance(f.db, f.card, { asOf: '2026-09-07', current: -80000, source: 'manual' });
		appendBalance(f.db, loan, { asOf: '2026-09-07', current: -1200000, source: 'manual' });
		appendTermsIfChanged(f.db, f.card, { asOf: '2026-09-01', aprBps: 2749, minPayment: 3500, nextDueDate: '2026-09-25', annualFee: 9500, source: 'manual' });
		appendTermsIfChanged(f.db, f.card, { asOf: '2026-08-01', aprBps: 2699, source: 'manual' });
		createBill(f.db, { name: 'SoFi', categoryId: f.rent, payFromAccountId: f.checking, expectedAmount: 87829, cadence: 'monthly', dueDay: 21, linkedDebtAccountId: loan });
		appendTermsIfChanged(f.db, loan, { asOf: '2026-09-01', aprBps: 1525, source: 'manual' });
		setPlannedExtra(f.db, { periodId: p, accountId: f.card, extraAmount: 10000 });
		createPromo(f.db, { accountId: f.card, description: 'BT', originalAmount: 50000, remainingAmount: 30000, expiresOn: '2027-03-31' });

		const v = debtView(f.db, { periodId: null, todayIso: '2026-09-08', cadence: 'semi_monthly' });
		expect(v.period.id).toBe(p); expect(v.period.isCurrent).toBe(true); expect(v.periodsPerMonth).toBe(2);
		expect(v.debts.map((d) => d.name)).toEqual(['Sapphire', 'SoFi']);
		const card = v.debts[0];
		expect(card).toMatchObject({ owed: 80000, accruing: 50000, aprBps: 2749, minimum: 3500, nextDue: '2026-09-25', annualFee: 9500, extra: 10000, planned: 13500, available: 0, shortfall: 13500 });
		expect(card.interest).toEqual({ yearly: 13745, monthly: 1145, daily: 38 });
		expect(card.terms.map((t) => t.aprBps)).toEqual([2749, 2699]);
		const sofi = v.debts[1];
		expect(sofi).toMatchObject({ owed: 1200000, minimum: 87829, ageMonths: 24, extra: 0, planned: 87829, shortfall: 87829 });
		expect(v.totals).toMatchObject({ owed: 1280000, minimum: 91329, extra: 10000, planned: 101329 });
		expect(v.strategies.map((s) => s.strategy)).toEqual(['plan', 'minimums', 'avalanche', 'snowball']);
		const avalanche = v.strategies[2];
		expect(avalanche.firstTarget).toBe('Sapphire'); expect(v.strategies[3].firstTarget).toBe('Sapphire');
		expect(avalanche.debtFreeMonth).not.toBeNull(); expect(avalanche.interestSaved).toBeGreaterThan(0);
		expect(v.strategies[1].interestSaved).toBe(0);
		expect(avalanche.series[0]).toEqual({ month: '2026-09', owed: 1280000 });
		expect(v.promos).toHaveLength(1);
		expect(v.promos[0]).toMatchObject({ accountName: 'Sapphire', remaining: 30000, monthsLeft: 6, monthlyTarget: 5000, plannedMonthly: 27000, underTarget: false });
		expect(v.trend.at(-1)).toMatchObject({ total: 1280000 });
		expect(v.readyToAssign).toBe(250000);
	});
	it('handles a database with no debt accounts', () => {
		const f = fixture(); updateAccount(f.db, f.card, { closedAt: '2026-09-01' });
		const v = debtView(f.db, { periodId: null, todayIso: '2026-09-08', cadence: 'semi_monthly' });
		expect(v.debts).toEqual([]); expect(v.strategies[0].debtFreeMonth).toBe('2026-09'); expect(v.promos).toEqual([]);
	});
	it('shows a period before budget_start as history only, with envelope numbers from the current period (P5)', () => {
		const f = fixture(); setSetting(f.db, BUDGET_START_KEY, '2026-08-01');
		const current = debtView(f.db, { periodId: null, todayIso: f.today, cadence: 'semi_monthly' });
		expect(current.historyOnly).toBe(false); expect(current.budgetStart).toBe('2026-08-01');
		const v = debtView(f.db, { periodId: periodIdForDate(f.db, '2026-07-05'), todayIso: f.today, cadence: 'semi_monthly' });
		expect(v.historyOnly).toBe(true); expect(v.budgetStart).toBe('2026-08-01');
		expect(v.period.id).toBe(periodIdForDate(f.db, '2026-07-05'));
		expect(v.readyToAssign).toBe(current.readyToAssign);
		expect(v.debts.map((d) => d.available)).toEqual(current.debts.map((d) => d.available));
	});
});
