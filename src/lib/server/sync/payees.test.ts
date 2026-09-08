import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, connections, payeeRules } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, uncategorizedId } from '../ledger/categories';
import { ensurePeriods } from '../budget/periods';
import { createTransaction, getTransaction, setSplits } from '../ledger/transactions';
import { createPayeeRule, matchPayeeRule, applyPayeeRules } from './payees';

let db: Db; let chk: number; let groceries: number;
beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-12-31');
	const c = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get().id;
	chk = db.insert(accounts).values({ connectionId: c, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
	groceries = createCategory(db, { groupId: createGroup(db, 'Spending'), name: 'Groceries', kind: 'spending' });
});

describe('matchPayeeRule', () => {
	it('picks by priority, matches substrings case-insensitively, and ignores bad regexes', () => {
		createPayeeRule(db, { pattern: 'amzn', payee: 'Amazon', priority: 50 });
		createPayeeRule(db, { pattern: '^AMZN MKTP', isRegex: true, payee: 'Amazon Marketplace', priority: 10 });
		createPayeeRule(db, { pattern: '(', isRegex: true, payee: 'broken', priority: 1 });
		const rules = db.select().from(payeeRules).all();
		expect(matchPayeeRule(rules, 'AMZN MKTP US*2K4')?.payee).toBe('Amazon Marketplace');
		expect(matchPayeeRule(rules, 'Prime Video amzn.com')?.payee).toBe('Amazon');
		expect(matchPayeeRule(rules, 'COSTCO')).toBeNull();
	});
});

describe('applyPayeeRules', () => {
	it('renames and categorises only uncategorised single-split rows', () => {
		createPayeeRule(db, { pattern: 'grocer', payee: 'Grocer', categoryId: groceries });
		const a = createTransaction(db, { accountId: chk, externalId: 'a', postedDate: '2026-03-01', amount: -1000, payeeRaw: 'THE GROCER #12', source: 'sync' });
		const b = createTransaction(db, { accountId: chk, externalId: 'b', postedDate: '2026-03-02', amount: -1000, payeeRaw: 'THE GROCER #12', source: 'sync' });
		setSplits(db, b, [{ categoryId: uncategorizedId(db), amount: -600 }, { categoryId: groceries, amount: -400 }]);
		const r = applyPayeeRules(db, [a, b]);
		expect(r).toEqual({ renamed: 2, categorized: 1 });
		expect(getTransaction(db, a).payee).toBe('Grocer');
		expect(getTransaction(db, a).splits[0].categoryId).toBe(groceries);
		expect(getTransaction(db, b).splits.length).toBe(2);
	});
});
