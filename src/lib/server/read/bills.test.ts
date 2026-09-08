import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { createBill, createIncomeSource } from '../bills/bills';
import { generateOccurrences } from '../bills/schedule';
import { markOccurrencePaid } from '../bills/matching';
import { billOccurrences } from '../db/schema';
import { billsView } from './bills';
describe('billsView', () => {
	it('lists definitions with the next occurrence and recent history', () => {
		const f = fixture();
		createBill(f.db, { name: 'Rent', categoryId: f.rent, payFromAccountId: f.checking, expectedAmount: 227445, cadence: 'monthly', dueDay: 1 });
		createIncomeSource(f.db, { name: 'Salary', categoryId: f.income, depositAccountId: f.checking, expectedAmount: 275000, cadence: 'semi_monthly', dueDay: 15, dueDay2: 30 });
		generateOccurrences(f.db, { todayIso: '2026-09-08', cadence: 'semi_monthly', graceDays: 3 });
		const sep1 = f.db.select().from(billOccurrences).all().find((o) => o.dueDate === '2026-09-01')!;
		markOccurrencePaid(f.db, sep1.id);
		const v = billsView(f.db, { todayIso: '2026-09-08' });
		const rent = v.bills[0];
		expect(rent).toMatchObject({ name: 'Rent', categoryName: 'Rent', payFromAccountName: 'Checking', active: true });
		// generateOccurrences({ todayIso: '2026-09-08', cadence: 'semi_monthly' }) horizons through 2026-09-30 (the
		// current half-month plus the next), so a monthly bill due on the 1st has no occurrence past 2026-09-01 yet;
		// its only occurrence is now paid and in the past, so there is correctly no upcoming one.
		expect(rent.next).toBeNull();
		expect(rent.history.map((o) => [o.dueDate, o.status])).toContainEqual(['2026-09-01', 'paid']);
		expect(rent.history[0].periodLabel).toMatch(/2026/);
		expect(v.income[0].next?.dueDate).toBe('2026-09-15');
		expect(v.accounts.map((a) => a.name)).toEqual(['Checking', 'Savings', 'Sapphire']);
		expect(v.cadences).toContain('every_n_weeks');
	});
});
