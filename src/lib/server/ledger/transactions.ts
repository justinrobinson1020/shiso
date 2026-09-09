import { randomUUID } from 'node:crypto';
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

/**
 * The (account_id, external_id) unique index. better-sqlite3 names the conflicting columns
 * rather than the index, so match on those; sync needs an InvariantError, not a driver error.
 */
function isDuplicateExternalId(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : '';
	return msg.startsWith('UNIQUE constraint failed') &&
		msg.includes('transactions.account_id') && msg.includes('transactions.external_id');
}

export function createTransaction(db: DbOrTx, input: NewTransaction): number {
	const splits = input.splits ?? [{ categoryId: uncategorizedId(db), amount: input.amount }];
	assertSplitsSum(input.amount, splits);
	const dateForPeriod = input.pending && input.transactedAt ? input.transactedAt.slice(0, 10) : input.postedDate;
	const periodId = input.periodId ?? periodIdForDate(db, dateForPeriod);
	return db.transaction((tx) => {
		let id: number;
		try {
			id = tx
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
		} catch (err) {
			if (isDuplicateExternalId(err)) throw new InvariantError('DUPLICATE_EXTERNAL_ID');
			throw err;
		}
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
	const row = db.select({ peer: transactions.transferPeerId }).from(transactions).where(eq(transactions.id, id)).get();
	db.transaction((tx) => {
		// A dangling peer link would block relinking the survivor when the row is reposted.
		if (row?.peer != null) {
			tx.update(transactions)
				.set({ transferPeerId: null, needsReview: true, reviewReason: 'transfer_peer_deleted', ...touch() })
				.where(eq(transactions.id, row.peer))
				.run();
		}
		// Leave an existing review reason alone unless the caller supplies a new one.
		tx.update(transactions)
			.set({ deletedAt: nowIso(), transferPeerId: null, ...(reason ? { reviewReason: reason } : {}), ...touch() })
			.where(eq(transactions.id, id))
			.run();
	});
}

/** Point a pending row at the posted row that superseded it (§4.2 pending → posted). */
export function setReplacedBy(db: DbOrTx, pendingId: number, replacementId: number): void {
	db.update(transactions).set({ replacedById: replacementId, ...touch() }).where(eq(transactions.id, pendingId)).run();
}

/** Bring a soft-deleted row back (a provider re-sent it). It is flagged so the user sees the reversal. */
export function restoreTransaction(db: DbOrTx, id: number, reason = 'provider_readded'): void {
	db.update(transactions).set({ deletedAt: null, needsReview: true, reviewReason: reason, ...touch() }).where(eq(transactions.id, id)).run();
}

export function flagForReview(db: DbOrTx, id: number, reason: string): void {
	db.update(transactions).set({ needsReview: true, reviewReason: reason, ...touch() }).where(eq(transactions.id, id)).run();
}

export function clearReview(db: DbOrTx, id: number): void {
	const row = db.select({ id: transactions.id }).from(transactions).where(eq(transactions.id, id)).get();
	if (!row) throw new Error(`transaction ${id} not found`);
	db.update(transactions).set({ needsReview: false, reviewReason: null, ...touch() }).where(eq(transactions.id, id)).run();
}

export type TransactionPatch = {
	amount?: number;
	postedDate?: string;
	transactedAt?: string | null;
	pending?: boolean;
	payeeRaw?: string;
	providerCategory?: string | null;
	// memo, payee, periodId, and categories are user edits; sync never writes them (spec §5.6)
};

/** Spec §5.6: provider modifications touch amount, dates, pending, raw payee, provider category. */
export function updateTransaction(db: DbOrTx, id: number, patch: TransactionPatch): { amountChanged: boolean; flagged: boolean } {
	const row = db.select().from(transactions).where(eq(transactions.id, id)).get();
	if (!row) throw new Error(`transaction ${id} not found`);
	const amountChanged = patch.amount !== undefined && patch.amount !== row.amount;
	return db.transaction((tx) => {
		const set: Partial<typeof transactions.$inferInsert> = { ...touch() };
		if (patch.amount !== undefined) set.amount = patch.amount;
		if (patch.postedDate !== undefined) set.postedDate = patch.postedDate;
		if (patch.transactedAt !== undefined) set.transactedAt = patch.transactedAt;
		if (patch.pending !== undefined) set.pending = patch.pending;
		if (patch.payeeRaw !== undefined) set.payeeRaw = patch.payeeRaw;
		if (patch.providerCategory !== undefined) set.providerCategory = patch.providerCategory;
		let flagged = false;
		if (amountChanged) {
			const splits = tx.select().from(transactionSplits).where(eq(transactionSplits.transactionId, id)).all();
			if (splits.length === 1) {
				tx.update(transactionSplits).set({ amount: patch.amount! }).where(eq(transactionSplits.id, splits[0].id)).run();
			} else {
				set.needsReview = true;
				set.reviewReason = 'amount_changed';
				flagged = true;
			}
		}
		tx.update(transactions).set(set).where(eq(transactions.id, id)).run();
		return { amountChanged, flagged };
	});
}

export function createManualTransaction(db: DbOrTx, input: {
	accountId: number; postedDate: string; amount: number; payee: string; memo?: string | null; categoryId?: number | null;
}): number {
	const categoryId = input.categoryId ?? uncategorizedId(db);
	return createTransaction(db, {
		accountId: input.accountId, externalId: `manual:${randomUUID()}`, postedDate: input.postedDate, amount: input.amount,
		payeeRaw: input.payee, payee: input.payee, memo: input.memo ?? null, source: 'manual',
		splits: [{ categoryId, amount: input.amount }]
	});
}

/** Only rows the user created (manual entry or CSV import) can be deleted by the user; synced rows are the provider's. */
export function deleteUserTransaction(db: DbOrTx, id: number): void {
	const row = db.select({ source: transactions.source }).from(transactions).where(eq(transactions.id, id)).get();
	if (!row) throw new Error(`transaction ${id} not found`);
	if (row.source !== 'manual' && row.source !== 'import') throw new InvariantError('NOT_USER_ROW');
	softDelete(db, id, 'user_deleted');
}

export function markProcessed(db: DbOrTx, ids: number[]): void {
	if (ids.length === 0) return;
	db.update(transactions).set({ processedAt: nowIso() }).where(inArray(transactions.id, ids)).run();
}

export const unprocessedWhere = sql`${transactions.processedAt} is null and ${transactions.deletedAt} is null`;
