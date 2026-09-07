import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, connections, transactions, transactionSplits } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, uncategorizedId, systemCategoryId } from './categories';
import { ensurePeriods, periodIdForDate } from '../budget/periods';
import { createTransaction, setSplits, linkTransfer, unlinkTransfer, softDelete, getTransaction } from './transactions';
import { InvariantError } from './errors';
import { eq } from 'drizzle-orm';

let db: Db;
let checking: number;
let card: number;
let groceries: number;

beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-12-31');
	const conn = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get();
	checking = db.insert(accounts).values({ connectionId: conn.id, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
	card = db.insert(accounts).values({ connectionId: conn.id, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
	const g = createGroup(db, 'Spending');
	groceries = createCategory(db, { groupId: g, name: 'Groceries', kind: 'spending' });
});

describe('createTransaction', () => {
	it('defaults to one uncategorized split and the posted period', () => {
		const id = createTransaction(db, {
			accountId: checking, externalId: 'a', postedDate: '2026-03-20', amount: -1234, payeeRaw: 'SHOP', source: 'manual'
		});
		const t = getTransaction(db, id);
		expect(t.splits).toEqual([expect.objectContaining({ categoryId: uncategorizedId(db), amount: -1234 })]);
		expect(t.periodId).toBe(periodIdForDate(db, '2026-03-20'));
		expect(t.payee).toBe('SHOP');
	});
	it('uses the transacted date for the period while pending', () => {
		const id = createTransaction(db, {
			accountId: checking, externalId: 'p', postedDate: '2026-03-16', transactedAt: '2026-03-15T22:00:00Z',
			amount: -500, payeeRaw: 'X', pending: true, source: 'sync'
		});
		expect(getTransaction(db, id).periodId).toBe(periodIdForDate(db, '2026-03-15'));
	});
	it('rejects splits that do not sum to the amount', () => {
		expect(() => createTransaction(db, {
			accountId: checking, externalId: 'b', postedDate: '2026-03-20', amount: -1000, payeeRaw: 'X', source: 'manual',
			splits: [{ categoryId: groceries, amount: -600 }, { categoryId: groceries, amount: -300 }]
		})).toThrowError(/SPLITS_DO_NOT_SUM/);
		expect(db.select().from(transactions).all().length).toBe(0);
	});
});

describe('setSplits', () => {
	it('replaces splits atomically', () => {
		const id = createTransaction(db, { accountId: checking, externalId: 'a', postedDate: '2026-03-20', amount: -1000, payeeRaw: 'X', source: 'manual' });
		setSplits(db, id, [{ categoryId: groceries, amount: -700 }, { categoryId: uncategorizedId(db), amount: -300 }]);
		expect(getTransaction(db, id).splits.map((s) => s.amount).sort()).toEqual([-700, -300].sort());
		expect(() => setSplits(db, id, [{ categoryId: groceries, amount: -1 }])).toThrow(InvariantError);
		expect(getTransaction(db, id).splits.length).toBe(2);
	});
});

describe('transfers', () => {
	it('links equal and opposite transactions and sets the transfer category', () => {
		const a = createTransaction(db, { accountId: checking, externalId: 'a', postedDate: '2026-03-20', amount: -25000, payeeRaw: 'PAYMENT', source: 'manual' });
		const b = createTransaction(db, { accountId: card, externalId: 'b', postedDate: '2026-03-21', amount: 25000, payeeRaw: 'PAYMENT THANK YOU', source: 'manual' });
		linkTransfer(db, a, b);
		const ta = getTransaction(db, a);
		const tb = getTransaction(db, b);
		expect(ta.transferPeerId).toBe(b);
		expect(tb.transferPeerId).toBe(a);
		expect(ta.splits[0].categoryId).toBe(systemCategoryId(db, 'transfer'));
		expect(tb.splits[0].categoryId).toBe(systemCategoryId(db, 'transfer'));
	});
	it('rejects mismatched amounts and double links', () => {
		const a = createTransaction(db, { accountId: checking, externalId: 'a', postedDate: '2026-03-20', amount: -25000, payeeRaw: 'P', source: 'manual' });
		const b = createTransaction(db, { accountId: card, externalId: 'b', postedDate: '2026-03-21', amount: 24000, payeeRaw: 'P', source: 'manual' });
		const c = createTransaction(db, { accountId: card, externalId: 'c', postedDate: '2026-03-21', amount: 25000, payeeRaw: 'P', source: 'manual' });
		expect(() => linkTransfer(db, a, b)).toThrowError(/TRANSFER_NOT_OPPOSITE/);
		linkTransfer(db, a, c);
		const d = createTransaction(db, { accountId: card, externalId: 'd', postedDate: '2026-03-22', amount: 25000, payeeRaw: 'P', source: 'manual' });
		expect(() => linkTransfer(db, a, d)).toThrowError(/TRANSFER_ALREADY_LINKED/);
	});
	it('unlinks both sides and flags them', () => {
		const a = createTransaction(db, { accountId: checking, externalId: 'a', postedDate: '2026-03-20', amount: -100, payeeRaw: 'P', source: 'manual' });
		const b = createTransaction(db, { accountId: card, externalId: 'b', postedDate: '2026-03-20', amount: 100, payeeRaw: 'P', source: 'manual' });
		linkTransfer(db, a, b);
		unlinkTransfer(db, a);
		expect(getTransaction(db, a).transferPeerId).toBeNull();
		expect(getTransaction(db, b).transferPeerId).toBeNull();
		expect(getTransaction(db, b).needsReview).toBe(true);
	});
});

describe('softDelete', () => {
	it('sets deleted_at and keeps the row and splits', () => {
		const id = createTransaction(db, { accountId: checking, externalId: 'a', postedDate: '2026-03-20', amount: -100, payeeRaw: 'P', source: 'sync' });
		softDelete(db, id);
		expect(getTransaction(db, id).deletedAt).not.toBeNull();
		expect(db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, id)).all().length).toBe(1);
	});
});
