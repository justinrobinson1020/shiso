import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { appendBalance } from '../sync/connections';
import { createBill, createIncomeSource } from '../bills/bills';
import { generateOccurrences } from '../bills/schedule';
import { markOccurrencePaid } from '../bills/matching';
import { billOccurrences } from '../db/schema';
import { monthView } from './month';

describe('monthView', () => {
	it('sums cash, income, bills and card payments for the calendar month', () => {
		const f = fixture();
		appendBalance(f.db, f.checking, { asOf: '2026-09-01', current: 300000, source: 'manual' });
		appendBalance(f.db, f.checking, { asOf: '2026-09-07', current: 250000, source: 'manual' });
		appendBalance(f.db, f.savings, { asOf: '2026-09-07', current: 100000, source: 'manual' });
		appendBalance(f.db, f.card, { asOf: '2026-09-07', current: -80000, source: 'manual' });
		createBill(f.db, { name: 'Rent', categoryId: f.rent, payFromAccountId: f.checking, expectedAmount: 227445, cadence: 'monthly', dueDay: 1 });
		createBill(f.db, { name: 'Sapphire', categoryId: f.cardPay, payFromAccountId: f.checking, expectedAmount: 3500, cadence: 'monthly', dueDay: 25, linkedDebtAccountId: f.card });
		createIncomeSource(f.db, { name: 'Salary', categoryId: f.income, depositAccountId: f.checking, expectedAmount: 275000, cadence: 'semi_monthly', dueDay: 15, dueDay2: 30 });
		generateOccurrences(f.db, { todayIso: '2026-09-08', cadence: 'semi_monthly', graceDays: 3 });
		const rent = f.db.select().from(billOccurrences).all().find((o) => o.expectedAmount === 227445 && o.dueDate === '2026-09-01')!;
		markOccurrencePaid(f.db, rent.id);

		const v = monthView(f.db, { month: '2026-09', todayIso: '2026-09-08', cadence: 'semi_monthly' });
		expect(v.label).toBe('September 2026'); expect(v.prev).toBe('2026-08'); expect(v.next).toBe('2026-10');
		expect(v.cash.total).toBe(350000);
		expect(v.cash.accounts.map((a) => a.name)).toEqual(['Checking', 'Savings']);
		expect(v.income.expected).toBe(550000); expect(v.income.received).toBe(0); expect(v.income.remaining).toBe(550000);
		expect(v.bills.paid).toBe(227445); expect(v.bills.pending).toBe(3500);
		expect(v.cardPayments).toEqual({ planned: 3500, paid: 0, extra: 0 });
		expect(v.cashLeft).toBe(350000 + 550000 - 3500);
		expect(v.trend).toEqual([{ asOf: '2026-09-01', current: 300000 }, { asOf: '2026-09-07', current: 250000 }]);
	});
});
