import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db';
import { accounts, billOccurrenceTransactions, transactions, CASH_TYPES } from '../db/schema';
import { ensurePeriods, periodBoundsFor, nextPeriodStart, type Cadence } from '../budget/periods';
import {
	createTransaction, updateTransaction, softDelete, setReplacedBy, setSplits, linkTransfer, unlinkTransfer,
	clearReview, flagForReview, markProcessed, getTransaction
} from '../ledger/transactions';
import { systemCategoryId } from '../ledger/categories';
import { InvariantError } from '../ledger/errors';
import { upsertAccount, appendBalance, appendTermsIfChanged, recordConnectionSuccess } from './connections';
import type { BatchTransaction, FetchMode, SyncBatch } from './types';
import { compareIso, nowIso, parseIso } from '$lib/dates';

export const PENDING_HEURISTIC_DAYS = 3;

export type ApplyResult = {
	accountsCreated: number; added: number; modified: number; removed: number;
	balancesWritten: number; termsWritten: number; openingCreated: number; flagged: number;
	newTransactionIds: number[]; removedTransactionIds: number[];
};

type AcctInfo = { id: number; type: string; hadTransactions: boolean };

function dayDiff(a: string, b: string): number {
	return Math.abs((parseIso(a).getTime() - parseIso(b).getTime()) / 86_400_000);
}

function liveByExternal(tx: DbOrTx, accountId: number, externalId: string) {
	return tx.select().from(transactions)
		.where(and(eq(transactions.accountId, accountId), eq(transactions.externalId, externalId), isNull(transactions.deletedAt)))
		.get() ?? null;
}

export function applyBatch(db: Db, connectionId: number, batch: SyncBatch, opts: { cadence: Cadence; todayIso: string; mode: FetchMode; now?: string }): ApplyResult {
	const now = opts.now ?? nowIso();
	return db.transaction((tx) => {
		const result: ApplyResult = {
			accountsCreated: 0, added: 0, modified: 0, removed: 0, balancesWritten: 0, termsWritten: 0,
			openingCreated: 0, flagged: 0, newTransactionIds: [], removedTransactionIds: []
		};

		// 1. Periods for every date the batch can touch (§5.1).
		const dates = [opts.todayIso, ...batch.balances.map((b) => b.asOf)];
		for (const t of [...batch.added, ...batch.modified]) {
			dates.push(t.postedDate);
			if (t.transactedAt) dates.push(t.transactedAt.slice(0, 10));
		}
		const from = dates.reduce((m, d) => (compareIso(d, m) < 0 ? d : m));
		const next = periodBoundsFor(opts.cadence, nextPeriodStart(opts.cadence, periodBoundsFor(opts.cadence, opts.todayIso).endDate));
		ensurePeriods(tx, opts.cadence, from, next.endDate);

		// 2. Accounts. Record whether each had transactions before this batch (for opening balances).
		const info = new Map<string, AcctInfo>();
		const known = tx.select().from(accounts).where(eq(accounts.connectionId, connectionId)).all();
		for (const a of known) info.set(a.externalId, { id: a.id, type: a.type, hadTransactions: hasTransactions(tx, a.id) });
		for (const a of batch.accounts) {
			const { id, created } = upsertAccount(tx, connectionId, a);
			if (created) result.accountsCreated++;
			if (!info.has(a.externalId)) info.set(a.externalId, { id, type: a.type, hadTransactions: false });
		}
		const acct = (ext: string): AcctInfo => {
			const a = info.get(ext);
			if (!a) throw new InvariantError('UNKNOWN_ACCOUNT');
			return a;
		};

		// 3. Balances and terms (append-only).
		for (const b of batch.balances) { appendBalance(tx, acct(b.accountExternalId).id, { ...b, source: 'sync' }); result.balancesWritten++; }
		for (const t of batch.terms) if (appendTermsIfChanged(tx, acct(t.accountExternalId).id, { ...t, source: 'provider' })) result.termsWritten++;

		// 4. Removals (§5.7). Bill-link unwinding happens in the runner from removedTransactionIds.
		for (const r of batch.removed) {
			const row = liveByExternal(tx, acct(r.accountExternalId).id, r.externalId);
			if (!row) continue;
			softDelete(tx, row.id, 'provider_removed');
			result.removed++;
			result.removedTransactionIds.push(row.id);
		}

		// 5. Modifications (§5.6). Unknown ids fall through to the add path.
		const toAdd: BatchTransaction[] = [];
		for (const m of batch.modified) {
			const row = liveByExternal(tx, acct(m.accountExternalId).id, m.externalId);
			if (!row) { toAdd.push(m); continue; }
			applyModification(tx, row.id, m, result);
		}

		// 6. Additions with pending reconciliation (§5.5).
		const batchIds = new Set(batch.added.map((t) => t.externalId));
		const addedPerAccount = new Map<number, { sum: number; earliest: string }>();
		for (const t of [...batch.added, ...toAdd]) {
			const a = acct(t.accountExternalId);
			const existing = liveByExternal(tx, a.id, t.externalId);
			if (existing) { applyModification(tx, existing.id, t, result); continue; }

			let inheritFrom: number | null = null;
			let ambiguous = false;
			if (t.pendingExternalId) {
				const old = liveByExternal(tx, a.id, t.pendingExternalId);
				if (old && old.pending) inheritFrom = old.id;
			} else if (!batch.sendsRemovals && !t.pending) {
				const cands = tx.select({ id: transactions.id, externalId: transactions.externalId, postedDate: transactions.postedDate })
					.from(transactions)
					.where(and(eq(transactions.accountId, a.id), eq(transactions.pending, true), eq(transactions.amount, t.amount), isNull(transactions.deletedAt)))
					.all()
					.filter((c) => !batchIds.has(c.externalId) && dayDiff(c.postedDate, t.postedDate) <= PENDING_HEURISTIC_DAYS);
				if (cands.length === 1) inheritFrom = cands[0].id;
				else if (cands.length > 1) ambiguous = true;
			}

			const newId = inheritFrom != null ? inheritTransaction(tx, inheritFrom, t, a.id, result) : createTransaction(tx, plain(t, a.id));
			if (ambiguous) { flagForReview(tx, newId, 'pending_ambiguous'); result.flagged++; }
			result.added++;
			result.newTransactionIds.push(newId);

			const countsTowardBalance = !t.pending || !(CASH_TYPES as readonly string[]).includes(a.type);
			const agg = addedPerAccount.get(a.id) ?? { sum: 0, earliest: t.postedDate };
			if (countsTowardBalance) agg.sum += t.amount;
			if (compareIso(t.postedDate, agg.earliest) < 0) agg.earliest = t.postedDate;
			addedPerAccount.set(a.id, agg);
		}

		// 7. Opening balances on an account's first full sync (§5.6 step 1).
		if (opts.mode === 'full') {
			const recon = systemCategoryId(tx, 'reconciliation');
			for (const b of batch.balances) {
				const a = acct(b.accountExternalId);
				if (a.hadTransactions) continue;
				const agg = addedPerAccount.get(a.id) ?? { sum: 0, earliest: b.asOf };
				const amount = b.current - agg.sum;
				if (amount === 0) continue;
				const postedDate = compareIso(agg.earliest, b.asOf) < 0 ? agg.earliest : b.asOf;
				const id = createTransaction(tx, {
					accountId: a.id, externalId: 'opening', postedDate, amount, payeeRaw: 'Opening balance', payee: 'Opening balance',
					source: 'opening', splits: [{ categoryId: recon, amount }]
				});
				markProcessed(tx, [id]);
				result.openingCreated++;
				a.hadTransactions = true;
			}
		}

		// 8. Cursor and success in the same transaction (§5.1).
		recordConnectionSuccess(tx, connectionId, batch.nextCursor, now);
		return result;
	});
}

function hasTransactions(tx: DbOrTx, accountId: number): boolean {
	const row = tx.select({ n: sql<number>`count(*)` }).from(transactions).where(eq(transactions.accountId, accountId)).get();
	return (row?.n ?? 0) > 0;
}

function plain(t: BatchTransaction, accountId: number) {
	return {
		accountId, externalId: t.externalId, pendingExternalId: t.pendingExternalId ?? null,
		postedDate: t.postedDate, transactedAt: t.transactedAt ?? null, amount: t.amount,
		payeeRaw: t.payeeRaw, memo: t.memo ?? null, pending: t.pending, providerCategory: t.providerCategory ?? null,
		source: 'sync' as const
	};
}

function applyModification(tx: DbOrTx, id: number, m: BatchTransaction, result: ApplyResult): void {
	const r = updateTransaction(tx, id, {
		amount: m.amount, postedDate: m.postedDate, transactedAt: m.transactedAt ?? null, pending: m.pending,
		payeeRaw: m.payeeRaw, providerCategory: m.providerCategory ?? null
	});
	result.modified++;
	if (r.flagged) result.flagged++;
}

/** Create the posted row as the pending row's successor, carrying every user-facing edit across (§5.5). */
function inheritTransaction(tx: DbOrTx, oldId: number, t: BatchTransaction, accountId: number, result: ApplyResult): number {
	const old = getTransaction(tx, oldId);
	const sameAmount = old.amount === t.amount;
	let splits = old.splits.map((s) => ({ categoryId: s.categoryId, amount: s.amount, memo: s.memo }));
	let flagAmount = false;
	if (!sameAmount) {
		if (splits.length === 1) splits = [{ ...splits[0], amount: t.amount }];
		else { splits = [{ categoryId: splits[0].categoryId, amount: t.amount, memo: null }]; flagAmount = true; }
	}
	const peer = old.transferPeerId;
	if (peer != null) unlinkTransfer(tx, oldId);
	const newId = createTransaction(tx, {
		...plain(t, accountId), pendingExternalId: old.externalId, payee: old.payee, memo: old.memo, periodId: old.periodId, splits
	});
	if (peer != null) {
		linkTransfer(tx, newId, peer);
		setSplits(tx, newId, splits);      // linkTransfer resets both sides to the transfer kind; restore the near side's categorisation
		clearReview(tx, peer);
	}
	tx.update(billOccurrenceTransactions).set({ transactionId: newId }).where(eq(billOccurrenceTransactions.transactionId, oldId)).run();
	softDelete(tx, oldId, 'pending_replaced');
	setReplacedBy(tx, oldId, newId);
	if (old.processedAt) markProcessed(tx, [newId]);
	if (old.needsReview && old.reviewReason) flagForReview(tx, newId, old.reviewReason);
	if (flagAmount) { flagForReview(tx, newId, 'amount_changed'); result.flagged++; }
	return newId;
}
