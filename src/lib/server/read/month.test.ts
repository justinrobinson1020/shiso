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
		appendBalance(f.db, f.checking, { asOf: '2026-09-07', current: 240000, source: 'sync' });   // a second snapshot the same day: the trend takes the latest, never the sum
		appendBalance(f.db, f.savings, { asOf: '2026-09-07', current: 100000, source: 'manual' });
		appendBalance(f.db, f.card, { asOf: '2026-09-07', current: -80000, source: 'manual' });
		createBill(f.db, { name: 'Rent', categoryId: f.rent, payFromAccountId: f.checking, expectedAmount: 227445, cadence: 'monthly', dueDay: 1 });
		createBill(f.db, { name: 'Sapphire', categoryId: f.cardPay, payFromAccountId: f.checking, expectedAmount: 3500, cadence: 'monthly', dueDay: 25, linkedDebtAccountId: f.card });
		createIncomeSource(f.db, { name: 'Salary', categoryId: f.income, depositAccountId: f.checking, expectedAmount: 275000, cadence: 'semi_monthly', dueDay: 15, dueDay2: 30 });
		generateOccurrences(f.db, { todayIso: '2026-09-08', cadence: 'semi_monthly', graceDays: 3 });
		const rent = f.db.select().from(billOccurrences).all().find((o) => o.expectedAmount === 227445 && o.dueDate === '2026-09-01')!;
		markOccurrencePaid(f.db, rent.id);

		const v = monthView(f.db, { month: '2026-09', todayIso: '2026-09-08', cadence: 'semi_monthly' });
		expect(v.label).toBe('September 2026'); expect(v.prev).toBe('2026-08'); expect(v.next).toBe('2026-10'); expect(v.prevLabel).toBe('August'); expect(v.nextLabel).toBe('October');
		expect(v.cash.total).toBe(340000);
		expect(v.cash.accounts.map((a) => a.name)).toEqual(['Checking', 'Savings']);
		expect(v.income.expected).toBe(550000); expect(v.income.received).toBe(0); expect(v.income.remaining).toBe(550000);
		expect(v.bills.paid).toBe(227445); expect(v.bills.pending).toBe(0);
		expect(v.bills.occurrences.map((o) => o.name)).toEqual(['Rent']);
		expect(v.cards.occurrences.map((o) => o.name)).toEqual(['Sapphire']);
		expect(v.cards.occurrences[0].extra).toBe(0);
		expect(v.cards).toMatchObject({ minimum: 3500, extra: 0, paid: 0, pending: 3500 });
		expect(v.expensesPending).toBe(3500);
		expect(v.cashLeft).toBe(340000 + 550000 - 3500);
		expect(v.trend).toEqual([{ asOf: '2026-09-01', current: 300000 }, { asOf: '2026-09-07', current: 240000 }]);
	});
	it('does not count expected income due on or before the cash balance date', () => {
		const f = fixture();
		appendBalance(f.db, f.checking, { asOf: '2026-09-17', current: 319468, source: 'sync' });   // payday balance, deposit already in it
		createIncomeSource(f.db, { name: 'Salary', categoryId: f.income, depositAccountId: f.checking, expectedAmount: 319623, cadence: 'semi_monthly', dueDay: 2, dueDay2: 17 });
		generateOccurrences(f.db, { todayIso: '2026-09-17', cadence: 'semi_monthly', graceDays: 3 });
		const v = monthView(f.db, { month: '2026-09', todayIso: '2026-09-17', cadence: 'semi_monthly' });
		expect(v.income.occurrences.map((o) => o.dueDate)).toEqual(['2026-09-02', '2026-09-17']);
		expect(v.income.remaining).toBe(0);            // Sep 2 is late, Sep 17 is in the balance: neither is still to come
		expect(v.cashLeft).toBe(319468);
		const later = monthView(f.db, { month: '2026-10', todayIso: '2026-09-17', cadence: 'semi_monthly' });
		expect(later.income.remaining).toBe(319623);   // Oct 2 is after the balance date
	});
	it('flags open rows due on or before the next unreceived paycheck as due now', () => {
		const f = fixture();
		createBill(f.db, { name: 'Water', categoryId: f.rent, payFromAccountId: f.checking, expectedAmount: 10000, cadence: 'monthly', dueDay: 12 });
		createBill(f.db, { name: 'Phone', categoryId: f.rent, payFromAccountId: f.checking, expectedAmount: 9000, cadence: 'monthly', dueDay: 17 });
		createBill(f.db, { name: 'Rent', categoryId: f.rent, payFromAccountId: f.checking, expectedAmount: 200000, cadence: 'monthly', dueDay: 30 });
		createIncomeSource(f.db, { name: 'Salary', categoryId: f.income, depositAccountId: f.checking, expectedAmount: 275000, cadence: 'semi_monthly', dueDay: 2, dueDay2: 17 });
		generateOccurrences(f.db, { todayIso: '2026-09-10', cadence: 'semi_monthly', graceDays: 3 });
		const water = f.db.select().from(billOccurrences).all().find((o) => o.dueDate === '2026-09-12')!;
		markOccurrencePaid(f.db, water.id);

		const v = monthView(f.db, { month: '2026-09', todayIso: '2026-09-10', cadence: 'semi_monthly' });
		expect(v.nextPaycheck).toBe('2026-09-17');
		const byName = Object.fromEntries(v.bills.occurrences.map((o) => [o.name, o]));
		expect(byName.Water.dueNow).toBe(false);   // paid, even though it is before the paycheck
		expect(byName.Water.markedBy).toBe('manual');
		expect(byName.Phone.dueNow).toBe(true);    // due on the paycheck day itself: the money is not there yet
		expect(byName.Rent.dueNow).toBe(false);    // paid from the Sep 17 paycheck
	});
});
