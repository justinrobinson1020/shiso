import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, accountBalances, accountTerms, bills, billOccurrences, billOccurrenceTransactions, connections, periods, transactions } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, systemCategoryId, uncategorizedId } from '../ledger/categories';
import { createTransaction, getTransaction, linkTransfer, setSplits } from '../ledger/transactions';
import { createConnection } from './connections';
import { applyBatch } from './apply';
import { emptyBatch, type SyncBatch, type BatchTransaction } from './types';

const KEY = 'k'.repeat(44);
const TODAY = '2026-09-08';
let db: Db;
let conn: number;

function tx(p: Partial<BatchTransaction> & Pick<BatchTransaction, 'externalId' | 'amount' | 'postedDate'>): BatchTransaction {
	return { accountExternalId: 'chk', payeeRaw: 'PAYEE', pending: false, ...p };
}
function batch(p: Partial<SyncBatch>): SyncBatch {
	return {
		...emptyBatch('c1'),
		accounts: [
			{ externalId: 'chk', name: 'Checking', type: 'checking' },
			{ externalId: 'card', name: 'Card', type: 'credit' }
		],
		balances: [
			{ accountExternalId: 'chk', asOf: TODAY, current: 100000 },
			{ accountExternalId: 'card', asOf: TODAY, current: -8000 }
		],
		sendsRemovals: true,
		...p
	};
}
const opts = { cadence: 'semi_monthly' as const, todayIso: TODAY, mode: 'full' as const, now: '2026-09-08T03:00:00.000Z' };
const byExt = (ext: string) => db.select().from(transactions).where(eq(transactions.externalId, ext)).get();
const acct = (ext: string) => db.select().from(accounts).where(and(eq(accounts.connectionId, conn), eq(accounts.externalId, ext))).get()!;

beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	conn = createConnection(db, { provider: 'plaid', institutionName: 'T', appKey: KEY });
});

describe('applyBatch first sync', () => {
	it('creates accounts, balances, transactions, periods, and opening balances', () => {
		const r = applyBatch(db, conn, batch({
			added: [
				tx({ externalId: 't1', amount: -2500, postedDate: '2026-09-02' }),
				tx({ externalId: 't2', amount: -1500, postedDate: '2026-09-05', pending: true, transactedAt: '2026-09-04T18:00:00Z' }),
				tx({ externalId: 'c1', accountExternalId: 'card', amount: -8000, postedDate: '2026-09-06' })
			]
		}), opts);
		expect(r.accountsCreated).toBe(2);
		expect(r.added).toBe(3);
		expect(r.balancesWritten).toBe(2);
		expect(r.openingCreated).toBe(1);
		// checking: 100000 = opening + (-2500 posted); pending -1500 excluded for a cash account
		const opening = db.select().from(transactions).where(and(eq(transactions.accountId, acct('chk').id), eq(transactions.source, 'opening'))).get()!;
		expect(opening.amount).toBe(102500);
		expect(opening.postedDate).toBe('2026-09-02');
		expect(opening.processedAt).not.toBeNull();
		// card: -8000 = 0 opening + (-8000); nothing inserted for zero
		expect(db.select().from(transactions).where(and(eq(transactions.accountId, acct('card').id), eq(transactions.source, 'opening'))).all().length).toBe(0);
		// pending row took its period from the transacted date
		const t2 = byExt('t2')!;
		expect(db.select().from(periods).where(eq(periods.id, t2.periodId)).get()!.startDate).toBe('2026-09-01');
		expect(r.newTransactionIds.length).toBe(3);
		expect(db.select().from(connections).where(eq(connections.id, conn)).get()!.cursor).toBe('c1');
	});

	it('counts pending rows toward the opening balance for credit accounts but not cash accounts', () => {
		const r = applyBatch(db, conn, batch({
			added: [
				tx({ externalId: 'chk1', amount: -2500, postedDate: '2026-09-02' }),
				tx({ externalId: 'chk2', amount: -1500, postedDate: '2026-09-05', pending: true }),
				tx({ externalId: 'card1', accountExternalId: 'card', amount: -4000, postedDate: '2026-09-06' }),
				tx({ externalId: 'card2', accountExternalId: 'card', amount: -3000, postedDate: '2026-09-06', pending: true })
			]
		}), opts);
		expect(r.openingCreated).toBe(2);
		// checking (cash): 100000 = opening + (-2500 posted); pending -1500 excluded
		const chkOpening = db.select().from(transactions).where(and(eq(transactions.accountId, acct('chk').id), eq(transactions.source, 'opening'))).get()!;
		expect(chkOpening.amount).toBe(102500);
		// card (credit): -8000 = opening + (-4000 posted + -3000 pending); pending counted
		const cardOpening = db.select().from(transactions).where(and(eq(transactions.accountId, acct('card').id), eq(transactions.source, 'opening'))).get()!;
		expect(cardOpening.amount).toBe(-1000);
	});

	it('is idempotent on replay and treats re-added rows as modifications', () => {
		const b = batch({ added: [tx({ externalId: 't1', amount: -2500, postedDate: '2026-09-02' })] });
		applyBatch(db, conn, b, opts);
		const r = applyBatch(db, conn, { ...b, added: [tx({ externalId: 't1', amount: -2600, postedDate: '2026-09-02' })] }, opts);
		expect(r.added).toBe(0);
		expect(r.modified).toBe(1);
		expect(r.openingCreated).toBe(0);
		expect(db.select().from(transactions).where(eq(transactions.externalId, 't1')).all().length).toBe(1);
		expect(byExt('t1')!.amount).toBe(-2600);
	});

	it('skips opening balances in balances mode', () => {
		const r = applyBatch(db, conn, batch({}), { ...opts, mode: 'balances' });
		expect(r.openingCreated).toBe(0);
		expect(r.balancesWritten).toBe(2);
	});

	it('rolls back everything on an unknown account', () => {
		expect(() => applyBatch(db, conn, batch({ added: [tx({ externalId: 'x', accountExternalId: 'ghost', amount: -1, postedDate: TODAY })] }), opts))
			.toThrowError(/UNKNOWN_ACCOUNT/);
		expect(db.select().from(accounts).all().length).toBe(0);
		expect(db.select().from(accountBalances).all().length).toBe(0);
	});
});

describe('applyBatch pending reconciliation', () => {
	it('explicit: a posted row inherits the pending row\'s edits, links, and bill links', () => {
		applyBatch(db, conn, batch({ added: [tx({ externalId: 'p1', amount: -4200, postedDate: '2026-09-03', pending: true })] }), opts);
		const pendingId = byExt('p1')!.id;
		const g = createGroup(db, 'Spending');
		const groceries = createCategory(db, { groupId: g, name: 'Groceries', kind: 'spending' });
		setSplits(db, pendingId, [{ categoryId: groceries, amount: -4200 }]);
		db.update(transactions).set({ payee: 'Grocer', memo: 'weekly', processedAt: '2026-09-03T00:00:00Z' }).where(eq(transactions.id, pendingId)).run();

		const r = applyBatch(db, conn, batch({
			added: [tx({ externalId: 'q1', pendingExternalId: 'p1', amount: -4200, postedDate: '2026-09-05', pending: false })]
		}), opts);
		expect(r.added).toBe(1);
		const old = getTransaction(db, pendingId);
		const posted = getTransaction(db, byExt('q1')!.id);
		expect(old.deletedAt).not.toBeNull();
		expect(old.replacedById).toBe(posted.id);
		expect(posted.splits[0].categoryId).toBe(groceries);
		expect(posted.payee).toBe('Grocer');
		expect(posted.memo).toBe('weekly');
		expect(posted.periodId).toBe(old.periodId);
		expect(posted.processedAt).not.toBeNull();
		expect(posted.needsReview).toBe(false);
	});

	it('explicit: a changed amount on a multi-split pending row flags the posted row', () => {
		applyBatch(db, conn, batch({ added: [tx({ externalId: 'p2', amount: -1000, postedDate: '2026-09-03', pending: true })] }), opts);
		const id = byExt('p2')!.id;
		setSplits(db, id, [{ categoryId: uncategorizedId(db), amount: -600 }, { categoryId: uncategorizedId(db), amount: -400 }]);
		applyBatch(db, conn, batch({ added: [tx({ externalId: 'q2', pendingExternalId: 'p2', amount: -1100, postedDate: '2026-09-05' })] }), opts);
		const posted = getTransaction(db, byExt('q2')!.id);
		expect(posted.amount).toBe(-1100);
		expect(posted.splits.length).toBe(1);
		expect(posted.reviewReason).toBe('amount_changed');
	});

	it('explicit: re-links a transfer peer and re-points bill occurrence links', () => {
		applyBatch(db, conn, batch({ added: [
			tx({ externalId: 'p3', amount: -25000, postedDate: '2026-09-03', pending: true }),
			tx({ externalId: 'k3', accountExternalId: 'card', amount: 25000, postedDate: '2026-09-03' })
		] }), opts);
		const pendingId = byExt('p3')!.id, peerId = byExt('k3')!.id;
		linkTransfer(db, pendingId, peerId);
		// a bare bill and occurrence (the bills service lands in Task 6); only the link row matters here
		const billId = db.insert(bills).values({ name: 'Card', categoryId: systemCategoryId(db, 'transfer'), payFromAccountId: acct('chk').id, expectedAmount: 25000, cadence: 'monthly', dueDay: 3 }).returning({ id: bills.id }).get().id;
		const occId = db.insert(billOccurrences).values({ billId, dueDate: '2026-09-03', periodId: getTransaction(db, pendingId).periodId, expectedAmount: 25000, windowStart: '2026-08-20', windowEnd: '2026-09-08' }).returning({ id: billOccurrences.id }).get().id;
		db.insert(billOccurrenceTransactions).values({ billOccurrenceId: occId, transactionId: pendingId }).run();

		applyBatch(db, conn, batch({ added: [tx({ externalId: 'q3', pendingExternalId: 'p3', amount: -25000, postedDate: '2026-09-05' })] }), opts);
		const posted = getTransaction(db, byExt('q3')!.id);
		expect(posted.transferPeerId).toBe(peerId);
		expect(getTransaction(db, peerId).transferPeerId).toBe(posted.id);
		expect(getTransaction(db, peerId).needsReview).toBe(false);
		expect(db.select().from(billOccurrenceTransactions).all()).toEqual([{ billOccurrenceId: occId, transactionId: posted.id }]);
	});

	it('explicit: a re-priced pending transfer posts unlinked and flagged instead of throwing', () => {
		applyBatch(db, conn, batch({ added: [
			tx({ externalId: 'p4', amount: -25000, postedDate: '2026-09-03', pending: true }),
			tx({ externalId: 'k4', accountExternalId: 'card', amount: 25000, postedDate: '2026-09-03' })
		] }), opts);
		const pendingId = byExt('p4')!.id, peerId = byExt('k4')!.id;
		linkTransfer(db, pendingId, peerId);

		expect(() => applyBatch(db, conn, batch({
			added: [tx({ externalId: 'q4', pendingExternalId: 'p4', amount: -25500, postedDate: '2026-09-05' })]
		}), opts)).not.toThrow();
		const posted = getTransaction(db, byExt('q4')!.id);
		expect(posted.transferPeerId).toBeNull();
		expect(posted.reviewReason).toBe('transfer_unlinked');
		const peer = getTransaction(db, peerId);
		expect(peer.transferPeerId).toBeNull();
		expect(peer.needsReview).toBe(true);
	});

	it('explicit: a stale re-send of an already-superseded pending row is ignored, not resurrected', () => {
		applyBatch(db, conn, batch({ added: [tx({ externalId: 'p9', amount: -4200, postedDate: '2026-09-03', pending: true })] }), opts);
		applyBatch(db, conn, batch({
			added: [tx({ externalId: 'q9', pendingExternalId: 'p9', amount: -4200, postedDate: '2026-09-05', pending: false })]
		}), opts);
		const q9Id = byExt('q9')!.id;

		const r = applyBatch(db, conn, batch({
			added: [tx({ externalId: 'p9', amount: -4200, postedDate: '2026-09-03', pending: true })]
		}), opts);
		expect(r.added).toBe(0);
		expect(r.modified).toBe(0);
		const p9 = getTransaction(db, byExt('p9')!.id);
		expect(p9.deletedAt).not.toBeNull();
		expect(p9.replacedById).toBe(q9Id);
		const live = db.select().from(transactions)
			.where(and(isNull(transactions.deletedAt), inArray(transactions.externalId, ['p9', 'q9'])))
			.all();
		expect(live.length).toBe(1);
		expect(live[0].externalId).toBe('q9');
	});

	it('heuristic: a pending row re-sent as modified in the same batch is not a stale candidate', () => {
		const b = batch({ sendsRemovals: false, added: [tx({ externalId: 'sf-3', amount: -900, postedDate: '2026-09-03', pending: true })] });
		applyBatch(db, conn, b, opts);
		const pendingId = byExt('sf-3')!.id;
		const r = applyBatch(db, conn, {
			...b,
			added: [tx({ externalId: 'sf-4', amount: -900, postedDate: '2026-09-05', pending: false })],
			modified: [tx({ externalId: 'sf-3', amount: -900, postedDate: '2026-09-03', pending: true })]
		}, opts);
		expect(r.added).toBe(1);
		expect(getTransaction(db, pendingId).deletedAt).toBeNull();
		const posted = getTransaction(db, byExt('sf-4')!.id);
		expect(posted.splits[0].categoryId).toBe(uncategorizedId(db));
	});

	it('heuristic: matches one pending row by amount and date when the provider sends no removals', () => {
		const b = batch({ sendsRemovals: false, added: [tx({ externalId: 'sf-1', amount: -777, postedDate: '2026-09-03', pending: true })] });
		applyBatch(db, conn, b, opts);
		const pendingId = byExt('sf-1')!.id;
		db.update(transactions).set({ payee: 'Cafe' }).where(eq(transactions.id, pendingId)).run();
		const r = applyBatch(db, conn, { ...b, added: [tx({ externalId: 'sf-2', amount: -777, postedDate: '2026-09-05', pending: false })] }, opts);
		expect(r.added).toBe(1);
		expect(getTransaction(db, pendingId).deletedAt).not.toBeNull();
		expect(getTransaction(db, byExt('sf-2')!.id).payee).toBe('Cafe');
	});

	it('heuristic: two candidates flag the new row and inherit nothing', () => {
		const b = batch({ sendsRemovals: false, added: [
			tx({ externalId: 'a', amount: -500, postedDate: '2026-09-03', pending: true }),
			tx({ externalId: 'b', amount: -500, postedDate: '2026-09-04', pending: true })
		] });
		applyBatch(db, conn, b, opts);
		applyBatch(db, conn, { ...b, added: [tx({ externalId: 'c', amount: -500, postedDate: '2026-09-05' })] }, opts);
		expect(getTransaction(db, byExt('c')!.id).reviewReason).toBe('pending_ambiguous');
		expect(getTransaction(db, byExt('a')!.id).deletedAt).toBeNull();
	});
});

describe('applyBatch modified, removed, terms', () => {
	it('applies removals as soft deletes and returns their ids', () => {
		applyBatch(db, conn, batch({ added: [tx({ externalId: 'r1', amount: -100, postedDate: '2026-09-03' })] }), opts);
		const r = applyBatch(db, conn, batch({ removed: [{ accountExternalId: 'chk', externalId: 'r1' }] }), opts);
		expect(r.removed).toBe(1);
		expect(r.removedTransactionIds).toEqual([byExt('r1')!.id]);
		expect(byExt('r1')!.reviewReason).toBe('provider_removed');
	});
	it('restores a soft-deleted external id when the provider re-adds it', () => {
		applyBatch(db, conn, batch({ added: [tx({ externalId: 'g1', amount: -100, postedDate: '2026-09-03' })] }), opts);
		applyBatch(db, conn, batch({ removed: [{ accountExternalId: 'chk', externalId: 'g1' }] }), opts);
		expect(() => applyBatch(db, conn, batch({ added: [tx({ externalId: 'g1', amount: -150, postedDate: '2026-09-04' })] }), opts)).not.toThrow();
		const rows = db.select().from(transactions).where(eq(transactions.externalId, 'g1')).all();
		expect(rows.length).toBe(1);
		expect(rows[0].deletedAt).toBeNull();
		expect(rows[0].reviewReason).toBe('provider_readded');
		expect(rows[0].amount).toBe(-150);
	});
	it('applies modifications through updateTransaction', () => {
		applyBatch(db, conn, batch({ added: [tx({ externalId: 'm1', amount: -100, postedDate: '2026-09-03' })] }), opts);
		const r = applyBatch(db, conn, batch({ modified: [tx({ externalId: 'm1', amount: -120, postedDate: '2026-09-04', payeeRaw: 'NEW' })] }), opts);
		expect(r.modified).toBe(1);
		const t = getTransaction(db, byExt('m1')!.id);
		expect(t.amount).toBe(-120);
		expect(t.splits[0].amount).toBe(-120);
		expect(t.payeeRaw).toBe('NEW');
	});
	it('appends terms only on change', () => {
		const terms = [{ accountExternalId: 'card', asOf: TODAY, aprBps: 2749, minPayment: 3500, nextDueDate: '2026-09-15' }];
		expect(applyBatch(db, conn, batch({ terms }), opts).termsWritten).toBe(1);
		expect(applyBatch(db, conn, batch({ terms }), opts).termsWritten).toBe(0);
		expect(db.select().from(accountTerms).all().length).toBe(1);
	});
});
