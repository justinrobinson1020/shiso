import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, connections } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, uncategorizedId, systemCategoryId } from '../ledger/categories';
import { ensurePeriods } from '../budget/periods';
import { createTransaction, getTransaction } from '../ledger/transactions';
import { createPayeeRule } from './payees';
import { createBill } from '../bills/bills';
import { generateOccurrences } from '../bills/schedule';
import { processUnprocessed, setProviderCategoryMap } from './postprocess';

let db: Db; let chk: number; let card: number; let groceries: number; let dining: number; let rentCat: number;
const TODAY = '2026-09-08';
const mk = (accountId: number, ext: string, amount: number, postedDate: string, payeeRaw: string, providerCategory: string | null = null) =>
	createTransaction(db, { accountId, externalId: ext, postedDate, amount, payeeRaw, providerCategory, source: 'sync' });

beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-12-31');
	const c = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get().id;
	chk = db.insert(accounts).values({ connectionId: c, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
	card = db.insert(accounts).values({ connectionId: c, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
	const g = createGroup(db, 'Spending');
	groceries = createCategory(db, { groupId: g, name: 'Groceries', kind: 'spending' });
	dining = createCategory(db, { groupId: g, name: 'Dining', kind: 'spending' });
	rentCat = createCategory(db, { groupId: createGroup(db, 'Bills'), name: 'Rent', kind: 'bill' });
});

describe('processUnprocessed', () => {
	it('runs rules, transfers, matching, and the provider map in order and stamps processed_at', () => {
		createPayeeRule(db, { pattern: 'grocer', payee: 'Grocer', categoryId: groceries });
		setProviderCategoryMap(db, { FOOD_AND_DRINK: dining });
		createBill(db, { name: 'Rent', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 225000, cadence: 'monthly', dueDay: 1, matchPattern: 'landlord' });
		generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });

		const a = mk(card, 'a', -4200, '2026-09-03', 'THE GROCER', 'FOOD_AND_DRINK');       // rule wins over provider map
		const b = mk(card, 'b', -1800, '2026-09-03', 'TACO SPOT', 'FOOD_AND_DRINK');        // provider map
		const c = mk(chk, 'c', -25000, '2026-09-04', 'CHASE PAYMENT');                      // transfer pair
		const d = mk(card, 'd', 25000, '2026-09-04', 'PAYMENT THANK YOU');
		const e = mk(chk, 'e', -225000, '2026-09-01', 'LANDLORD LLC');                      // bill
		const f = mk(chk, 'f', -999, '2026-09-05', 'MYSTERY', 'UNKNOWN_CAT');                // stays uncategorized

		const r = processUnprocessed(db, { todayIso: TODAY, graceDays: 3, transferWindowDays: 4 });
		expect(r.processed).toBe(6);
		expect(getTransaction(db, a).payee).toBe('Grocer');
		expect(getTransaction(db, a).splits[0].categoryId).toBe(groceries);
		expect(getTransaction(db, b).splits[0].categoryId).toBe(dining);
		expect(getTransaction(db, c).transferPeerId).toBe(d);
		expect(getTransaction(db, c).splits[0].categoryId).toBe(systemCategoryId(db, 'transfer'));
		expect(getTransaction(db, e).splits[0].categoryId).toBe(rentCat);
		expect(getTransaction(db, f).splits[0].categoryId).toBe(uncategorizedId(db));
		for (const id of [a, b, c, d, e, f]) expect(getTransaction(db, id).processedAt).not.toBeNull();
		expect(processUnprocessed(db, { todayIso: TODAY, graceDays: 3, transferWindowDays: 4 }).processed).toBe(0);
	});
});
