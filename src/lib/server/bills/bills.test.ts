import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, billOccurrences, connections, incomeOccurrences } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, systemCategoryId } from '../ledger/categories';
import { ensurePeriods } from '../budget/periods';
import { appendTermsIfChanged } from '../sync/connections';
import { createBill, createIncomeSource, listBills } from './bills';
import { generateOccurrences } from './schedule';

let db: Db; let chk: number; let card: number; let rentCat: number; let cardEnv: number;
const TODAY = '2026-09-08';
const gen = () => generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });

beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-12-31');
	const c = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get().id;
	chk = db.insert(accounts).values({ connectionId: c, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
	card = db.insert(accounts).values({ connectionId: c, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
	rentCat = createCategory(db, { groupId: createGroup(db, 'Bills'), name: 'Rent', kind: 'bill' });
	cardEnv = createCategory(db, { groupId: createGroup(db, 'Debt'), name: 'Card', kind: 'debt_payment', accountId: card });
});

describe('generateOccurrences', () => {
	it('creates monthly occurrences through the next period, idempotently, with bill windows', () => {
		createBill(db, { name: 'Rent', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 225000, cadence: 'monthly', dueDay: 1, matchPattern: 'landlord' });
		// today Sep 8 → current period Sep 1-15, horizon = end of Sep 16-30; floor = Aug 8. Only Sep 1 qualifies.
		expect(gen()).toEqual({ billsCreated: 1, incomeCreated: 0 });
		expect(gen()).toEqual({ billsCreated: 0, incomeCreated: 0 });
		const rows = db.select().from(billOccurrences).all().sort((a, b) => a.dueDate.localeCompare(b.dueDate));
		expect(rows.map((r) => r.dueDate)).toEqual(['2026-09-01']);
		expect(rows[0].windowStart).toBe('2026-08-22');
		expect(rows[0].windowEnd).toBe('2026-09-04');
		expect(rows[0].expectedAmount).toBe(225000);
		expect(rows[0].status).toBe('pending');
	});
	it('a debt bill follows account terms: due date, minimum, statement balance, statement window', () => {
		createBill(db, { name: 'Card', categoryId: cardEnv, payFromAccountId: chk, expectedAmount: 5000, cadence: 'monthly', dueDay: 20, linkedDebtAccountId: card });
		appendTermsIfChanged(db, card, { asOf: TODAY, minPayment: 3560, nextDueDate: '2026-09-26', lastStatementBalance: 1177095, lastStatementDate: '2026-09-01', source: 'provider' });
		expect(gen().billsCreated).toBe(1);
		const o = db.select().from(billOccurrences).get()!;
		expect(o.dueDate).toBe('2026-09-26');
		expect(o.expectedAmount).toBe(3560);
		expect(o.statementBalance).toBe(1177095);
		expect(o.windowStart).toBe('2026-09-01');
		expect(o.windowEnd).toBe('2026-09-29');
	});
	it('falls back to the cadence when the terms due date is stale', () => {
		createBill(db, { name: 'Card', categoryId: cardEnv, payFromAccountId: chk, expectedAmount: 5000, cadence: 'monthly', dueDay: 20, linkedDebtAccountId: card });
		appendTermsIfChanged(db, card, { asOf: '2026-07-01', minPayment: 3560, nextDueDate: '2026-07-26', source: 'provider' });
		expect(gen().billsCreated).toBe(2); // Aug 20 and Sep 20 inside [Aug 8, Sep 30]
		const rows = db.select().from(billOccurrences).all().sort((a, b) => a.dueDate.localeCompare(b.dueDate));
		expect(rows.map((r) => r.dueDate)).toEqual(['2026-08-20', '2026-09-20']);
		expect(rows[1].expectedAmount).toBe(5000);
		expect(rows[1].statementBalance).toBeNull();
		expect(rows[1].windowStart).toBe('2026-08-26');
	});
	it('back-fills at most 31 days for a new definition', () => {
		createBill(db, { name: 'New', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 100, cadence: 'semi_monthly', dueDay: 5, dueDay2: 20 });
		gen();
		// floor Aug 8, horizon Sep 30: Aug 5 is out, Aug 20 / Sep 5 / Sep 20 are in
		expect(db.select().from(billOccurrences).all().map((r) => r.dueDate).sort()).toEqual(['2026-08-20', '2026-09-05', '2026-09-20']);
	});
	it('generates income occurrences with the income window', () => {
		createIncomeSource(db, { name: 'Salary', categoryId: systemCategoryId(db, 'income'), depositAccountId: chk, expectedAmount: 319200, cadence: 'semi_monthly', dueDay: 15, dueDay2: 30, matchPattern: 'employer' });
		expect(gen().incomeCreated).toBe(4); // floor Aug 8 .. horizon Sep 30
		const rows = db.select().from(incomeOccurrences).all().map((r) => r.dueDate).sort();
		expect(rows).toEqual(['2026-08-15', '2026-08-30', '2026-09-15', '2026-09-30']);
	});
	it('lists bills with their category and account', () => {
		createBill(db, { name: 'Rent', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 1, cadence: 'monthly', dueDay: 1 });
		expect(listBills(db)[0]).toMatchObject({ name: 'Rent', payFromAccountId: chk });
	});
});
