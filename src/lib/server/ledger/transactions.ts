import { eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { transactions, transactionSplits, type TransactionSource } from '../db/schema';
import { periodIdForDate } from '../budget/periods';
import { systemCategoryId, uncategorizedId } from './categories';
import { InvariantError } from './errors';
import { nowIso } from '$lib/dates';

export type SplitInput = { categoryId: number; amount: number; memo?: string | null };

export type NewTransaction = {
	accountId: number;
	externalId: string;
	postedDate: string;
	transactedAt?: string | null;
	amount: number;
	payeeRaw: string;
	payee?: string;
	memo?: string | null;
	pending?: boolean;
	providerCategory?: string | null;
	pendingExternalId?: string | null;
	source: TransactionSource;
	splits?: SplitInput[];
	periodId?: number;
};

const touch = () => ({ updatedAt: nowIso() });

function assertSplitsSum(amount: number, splits: SplitInput[]): void {
	if (splits.length === 0) throw new InvariantError('SPLITS_DO_NOT_SUM', 'a transaction needs at least one split');
	const sum = splits.reduce((s, x) => s + x.amount, 0);
	if (sum !== amount) throw new InvariantError('SPLITS_DO_NOT_SUM');
}

export function createTransaction(db: DbOrTx, input: NewTransaction): number {
	const splits = input.splits ?? [{ categoryId: uncategorizedId(db), amount: input.amount }];
	assertSplitsSum(input.amount, splits);
	const dateForPeriod = input.pending && input.transactedAt ? input.transactedAt.slice(0, 10) : input.postedDate;
	const periodId = input.periodId ?? periodIdForDate(db, dateForPeriod);
	return db.transaction((tx) => {
		const id = tx
			.insert(transactions)
			.values({
				accountId: input.accountId,
				externalId: input.externalId,
				pendingExternalId: input.pendingExternalId ?? null,
				postedDate: input.postedDate,
				transactedAt: input.transactedAt ?? null,
				amount: input.amount,
				payeeRaw: input.payeeRaw,
				payee: input.payee ?? input.payeeRaw,
				memo: input.memo ?? null,
				pending: input.pending ?? false,
				providerCategory: input.providerCategory ?? null,
				periodId,
				source: input.source
			})
			.returning({ id: transactions.id })
			.get().id;
		tx.insert(transactionSplits).values(splits.map((s) => ({ transactionId: id, categoryId: s.categoryId, amount: s.amount, memo: s.memo ?? null }))).run();
		return id;
	});
}

export function getTransaction(db: DbOrTx, id: number) {
	const row = db.select().from(transactions).where(eq(transactions.id, id)).get();
	if (!row) throw new Error(`transaction ${id} not found`);
	const splits = db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, id)).all();
	return { ...row, splits };
}

export function setSplits(db: DbOrTx, transactionId: number, splits: SplitInput[]): void {
	const row = db.select({ amount: transactions.amount }).from(transactions).where(eq(transactions.id, transactionId)).get();
	if (!row) throw new Error(`transaction ${transactionId} not found`);
	assertSplitsSum(row.amount, splits);
	db.transaction((tx) => {
		tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, transactionId)).run();
		tx.insert(transactionSplits).values(splits.map((s) => ({ transactionId, categoryId: s.categoryId, amount: s.amount, memo: s.memo ?? null }))).run();
		tx.update(transactions).set(touch()).where(eq(transactions.id, transactionId)).run();
	});
}

export function setPeriod(db: DbOrTx, transactionId: number, periodId: number): void {
	db.update(transactions).set({ periodId, ...touch() }).where(eq(transactions.id, transactionId)).run();
}

export function setPayee(db: DbOrTx, transactionId: number, payee: string): void {
	db.update(transactions).set({ payee, ...touch() }).where(eq(transactions.id, transactionId)).run();
}

export function setMemo(db: DbOrTx, transactionId: number, memo: string | null): void {
	db.update(transactions).set({ memo, ...touch() }).where(eq(transactions.id, transactionId)).run();
}

export function linkTransfer(db: DbOrTx, aId: number, bId: number): void {
	const a = db.select().from(transactions).where(eq(transactions.id, aId)).get();
	const b = db.select().from(transactions).where(eq(transactions.id, bId)).get();
	if (!a || !b) throw new Error('transfer: transaction not found');
	if (a.transferPeerId != null || b.transferPeerId != null) throw new InvariantError('TRANSFER_ALREADY_LINKED');
	if (a.accountId === b.accountId || a.amount !== -b.amount) throw new InvariantError('TRANSFER_NOT_OPPOSITE');
	const transferCat = systemCategoryId(db, 'transfer');
	db.transaction((tx) => {
		tx.update(transactions).set({ transferPeerId: bId, ...touch() }).where(eq(transactions.id, aId)).run();
		tx.update(transactions).set({ transferPeerId: aId, ...touch() }).where(eq(transactions.id, bId)).run();
		for (const [id, amount] of [[aId, a.amount], [bId, b.amount]] as const) {
			tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, id)).run();
			tx.insert(transactionSplits).values({ transactionId: id, categoryId: transferCat, amount }).run();
		}
	});
}

export function unlinkTransfer(db: DbOrTx, id: number): void {
	const a = db.select().from(transactions).where(eq(transactions.id, id)).get();
	if (!a || a.transferPeerId == null) return;
	const peer = a.transferPeerId;
	db.transaction((tx) => {
		for (const x of [id, peer]) {
			tx.update(transactions)
				.set({ transferPeerId: null, needsReview: true, reviewReason: 'transfer_unlinked', ...touch() })
				.where(eq(transactions.id, x))
				.run();
		}
	});
}

export function softDelete(db: DbOrTx, id: number, reason?: string): void {
	// Leave an existing review reason alone unless the caller supplies a new one.
	db.update(transactions)
		.set({ deletedAt: nowIso(), ...(reason ? { reviewReason: reason } : {}), ...touch() })
		.where(eq(transactions.id, id))
		.run();
}

export function flagForReview(db: DbOrTx, id: number, reason: string): void {
	db.update(transactions).set({ needsReview: true, reviewReason: reason, ...touch() }).where(eq(transactions.id, id)).run();
}

export function clearReview(db: DbOrTx, id: number): void {
	db.update(transactions).set({ needsReview: false, reviewReason: null, ...touch() }).where(eq(transactions.id, id)).run();
}

export function markProcessed(db: DbOrTx, ids: number[]): void {
	if (ids.length === 0) return;
	db.update(transactions).set({ processedAt: nowIso() }).where(inArray(transactions.id, ids)).run();
}

export const unprocessedWhere = sql`${transactions.processedAt} is null and ${transactions.deletedAt} is null`;
