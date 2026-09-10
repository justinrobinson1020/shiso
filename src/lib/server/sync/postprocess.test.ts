import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, connections } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, uncategorizedId, systemCategoryId } from '../ledger/categories';
import { ensurePeriods } from '../budget/periods';
import { createTransaction, getTransaction, linkTransfer } from '../ledger/transactions';
import { createPayeeRule } from './payees';
import { createBill } from '../bills/bills';
import { generateOccurrences } from '../bills/schedule';
import { applyProviderCategoryMap, processUnprocessed, resolveProviderCategory, setProviderCategoryMap } from './postprocess';
import { fixture } from '../test/fixture';

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

describe('resolveProviderCategory', () => {
	it('matches an exact key', () => {
		expect(resolveProviderCategory({ FOOD_AND_DRINK_GROCERIES: 5, FOOD_AND_DRINK: 3 }, 'FOOD_AND_DRINK_GROCERIES')).toBe(5);
	});
	it('falls back to a primary-category prefix when there is no exact entry', () => {
		expect(resolveProviderCategory({ FOOD_AND_DRINK: 3 }, 'FOOD_AND_DRINK_GROCERIES')).toBe(3);
	});
	it('prefers the longest matching prefix', () => {
		expect(resolveProviderCategory({ FOOD: 1, FOOD_AND_DRINK: 2 }, 'FOOD_AND_DRINK_GROCERIES')).toBe(2);
	});
	it('returns undefined when nothing matches', () => {
		expect(resolveProviderCategory({ TRAVEL: 1 }, 'FOOD_AND_DRINK_GROCERIES')).toBeUndefined();
	});
	it('returns undefined for a null provider category', () => {
		expect(resolveProviderCategory({ FOOD_AND_DRINK: 3 }, null)).toBeUndefined();
	});
});

describe('applyProviderCategoryMap', () => {
	it('categorizes uncategorized rows via the map, leaving categorized and transfer rows alone', () => {
		const f = fixture();
		setProviderCategoryMap(f.db, { FOOD_AND_DRINK_GROCERIES: f.groceries, TRAVEL: f.rent });
		const exact = createTransaction(f.db, { accountId: f.checking, externalId: 'exact', postedDate: f.today, amount: -1000, payeeRaw: 'Store', providerCategory: 'FOOD_AND_DRINK_GROCERIES', source: 'sync' });
		const viaPrimary = createTransaction(f.db, { accountId: f.checking, externalId: 'primary', postedDate: f.today, amount: -1200, payeeRaw: 'Airline', providerCategory: 'TRAVEL_FLIGHTS', source: 'sync' });
		const unmapped = createTransaction(f.db, { accountId: f.checking, externalId: 'none', postedDate: f.today, amount: -500, payeeRaw: 'Mystery', providerCategory: 'UNKNOWN', source: 'sync' });
		const already = createTransaction(f.db, {
			accountId: f.checking, externalId: 'already', postedDate: f.today, amount: -300, payeeRaw: 'Already', providerCategory: 'FOOD_AND_DRINK_GROCERIES', source: 'sync',
			splits: [{ categoryId: f.groceries, amount: -300 }]
		});
		const t1 = createTransaction(f.db, { accountId: f.checking, externalId: 't1', postedDate: f.today, amount: -700, payeeRaw: 'Transfer out', providerCategory: 'TRAVEL', source: 'sync' });
		const t2 = createTransaction(f.db, { accountId: f.savings, externalId: 't2', postedDate: f.today, amount: 700, payeeRaw: 'Transfer in', providerCategory: 'TRAVEL', source: 'sync' });
		linkTransfer(f.db, t1, t2);

		const result = applyProviderCategoryMap(f.db);

		expect(result.categorized).toBe(2);
		expect(getTransaction(f.db, exact).splits[0].categoryId).toBe(f.groceries);
		expect(getTransaction(f.db, viaPrimary).splits[0].categoryId).toBe(f.rent);
		expect(getTransaction(f.db, unmapped).splits[0].categoryId).toBe(f.uncategorized);
		expect(getTransaction(f.db, already).splits[0].categoryId).toBe(f.groceries);
		const transferCat = systemCategoryId(f.db, 'transfer');
		expect(getTransaction(f.db, t1).splits[0].categoryId).toBe(transferCat);
		expect(getTransaction(f.db, t2).splits[0].categoryId).toBe(transferCat);
	});
});
