import { describe, it, expect } from 'vitest';
import { openMemoryDatabase } from '../db';
import { accounts, accountBalances, connections } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, systemCategoryId } from '../ledger/categories';
import { createTransaction, linkTransfer, softDelete } from '../ledger/transactions';
import { assign } from '../ledger/assignments';
import { ensurePeriods, periodIdForDate } from './periods';
import { loadBudgetInput, budgetForPeriod } from './load';

describe('loadBudgetInput', () => {
	it('reproduces the $80 grocery scenario end to end through the database', () => {
		const { db } = openMemoryDatabase();
		seedDefaultCategories(db);
		ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-01-31');
		const p1 = periodIdForDate(db, '2026-01-05');
		const conn = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get();
		const checking = db.insert(accounts).values({ connectionId: conn.id, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
		const card = db.insert(accounts).values({ connectionId: conn.id, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
		const g = createGroup(db, 'Spending');
		const groceries = createCategory(db, { groupId: g, name: 'Groceries', kind: 'spending' });
		const dg = createGroup(db, 'Debt');
		const cardEnv = createCategory(db, { groupId: dg, name: 'Card', kind: 'debt_payment', accountId: card });

		createTransaction(db, { accountId: checking, externalId: 'open', postedDate: '2026-01-01', amount: 100000, payeeRaw: 'Opening', source: 'opening',
			splits: [{ categoryId: systemCategoryId(db, 'reconciliation'), amount: 100000 }] });
		db.insert(accountBalances).values({ accountId: checking, asOf: '2026-01-10', current: 100000, source: 'manual' }).run();
		db.insert(accountBalances).values({ accountId: card, asOf: '2026-01-10', current: -8000, source: 'manual' }).run();
		assign(db, p1, groceries, 5000);
		createTransaction(db, { accountId: card, externalId: 'g', postedDate: '2026-01-06', amount: -8000, payeeRaw: 'GROCER', source: 'sync',
			splits: [{ categoryId: groceries, amount: -8000 }] });

		const input = loadBudgetInput(db);
		expect(input.splits.length).toBe(2);
		expect(input.balances.find((b) => b.accountId === card)?.current).toBe(-8000);

		const r = budgetForPeriod(db, p1);
		expect(r.byPeriod.get(p1)!.get(groceries)!.available).toBe(-3000);
		expect(r.byPeriod.get(p1)!.get(cardEnv)!.available).toBe(5000);
		expect(r.readyToAssign).toBe(95000);
		expect(r.readyToAssignFromFlows).toBe(95000);
		expect(r.underfunded.get(card)).toBe(3000);
	});

	it('resolves transfer peers and ignores soft-deleted rows', () => {
		const { db } = openMemoryDatabase();
		seedDefaultCategories(db);
		ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-01-31');
		const conn = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get();
		const checking = db.insert(accounts).values({ connectionId: conn.id, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
		const card = db.insert(accounts).values({ connectionId: conn.id, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
		const a = createTransaction(db, { accountId: checking, externalId: 'a', postedDate: '2026-01-06', amount: -500, payeeRaw: 'P', source: 'sync' });
		const b = createTransaction(db, { accountId: card, externalId: 'b', postedDate: '2026-01-06', amount: 500, payeeRaw: 'P', source: 'sync' });
		linkTransfer(db, a, b);
		const gone = createTransaction(db, { accountId: checking, externalId: 'z', postedDate: '2026-01-07', amount: -999, payeeRaw: 'Z', source: 'sync' });
		softDelete(db, gone);
		const input = loadBudgetInput(db);
		expect(input.splits.length).toBe(2);
		expect(input.splits.find((s) => s.accountId === checking)?.transferPeerAccountId).toBe(card);
		expect(input.balances.find((bb) => bb.accountId === checking)?.current).toBe(-500); // fallback: sum of live transactions
	});

	it('gives a closed account no cash while keeping its history', () => {
		const { db } = openMemoryDatabase();
		seedDefaultCategories(db);
		ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-01-31');
		const p1 = periodIdForDate(db, '2026-01-05');
		const conn = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get();
		const open = db.insert(accounts).values({ connectionId: conn.id, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
		const closed = db.insert(accounts).values({ connectionId: conn.id, externalId: 'old', name: 'Old Chk', type: 'checking', onBudget: true, isDebt: false, closedAt: '2026-01-04' }).returning({ id: accounts.id }).get().id;
		createTransaction(db, { accountId: open, externalId: 'open', postedDate: '2026-01-01', amount: 20000, payeeRaw: 'Opening', source: 'opening',
			splits: [{ categoryId: systemCategoryId(db, 'reconciliation'), amount: 20000 }] });
		db.insert(accountBalances).values({ accountId: open, asOf: '2026-01-10', current: 20000, source: 'manual' }).run();
		db.insert(accountBalances).values({ accountId: closed, asOf: '2026-01-03', current: 50000, source: 'manual' }).run();

		const input = loadBudgetInput(db);
		expect(input.balances.find((b) => b.accountId === closed)?.current).toBe(0);
		expect(input.accounts.some((a) => a.id === closed)).toBe(true);
		expect(budgetForPeriod(db, p1).readyToAssign).toBe(20000);
	});

	it('reports no transfer peer once the other half is deleted', () => {
		const { db } = openMemoryDatabase();
		seedDefaultCategories(db);
		ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-01-31');
		const conn = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get();
		const checking = db.insert(accounts).values({ connectionId: conn.id, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
		const card = db.insert(accounts).values({ connectionId: conn.id, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
		const a = createTransaction(db, { accountId: checking, externalId: 'a', postedDate: '2026-01-06', amount: -500, payeeRaw: 'P', source: 'sync' });
		const b = createTransaction(db, { accountId: card, externalId: 'b', postedDate: '2026-01-06', amount: 500, payeeRaw: 'P', source: 'sync' });
		linkTransfer(db, a, b);
		softDelete(db, a);
		const input = loadBudgetInput(db);
		expect(input.splits.length).toBe(1);
		expect(input.splits[0].accountId).toBe(card);
		expect(input.splits[0].transferPeerAccountId).toBeNull();
	});

	it('prefers the latest balance row over the transaction sum, ordering by as_of then id', () => {
		const { db } = openMemoryDatabase();
		seedDefaultCategories(db);
		ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-01-31');
		const conn = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get();
		const checking = db.insert(accounts).values({ connectionId: conn.id, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
		// Live transactions sum to -700; the balance rows disagree with that on purpose.
		createTransaction(db, { accountId: checking, externalId: 'a', postedDate: '2026-01-06', amount: -700, payeeRaw: 'P', source: 'sync' });
		db.insert(accountBalances).values({ accountId: checking, asOf: '2026-01-05', current: 50000, source: 'sync' }).run();
		db.insert(accountBalances).values({ accountId: checking, asOf: '2026-01-10', current: 70000, source: 'sync' }).run();
		// Same as_of as the newest row but inserted later: higher id wins the tie.
		db.insert(accountBalances).values({ accountId: checking, asOf: '2026-01-10', current: 71000, source: 'manual' }).run();
		const input = loadBudgetInput(db);
		expect(input.balances.find((b) => b.accountId === checking)?.current).toBe(71000);
	});
});
