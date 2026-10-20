import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from './db';
import { accounts, connections, driftWatch, transactions, CASH_TYPES } from './db/schema';
import { latestBalance } from './sync/connections';
import { getSetting, type SettingKey } from './settings';
import { createTransaction, markProcessed } from './ledger/transactions';
import { systemCategoryId } from './ledger/categories';
import { nowIso } from '$lib/dates';
import { NotFoundError } from './ledger/errors';

export type PendingConvention = 'exclude_pending' | 'include_pending';
export const PENDING_CONVENTION_KEY = 'pending_convention' satisfies SettingKey;
export type Drift = { accountId: number; providerBalance: number | null; ledgerBalance: number; drift: number | null; convention: PendingConvention };

export function conventionFor(db: DbOrTx, account: { id: number; type: string }): PendingConvention {
	const overrides = getSetting(db, PENDING_CONVENTION_KEY, {});
	return overrides[String(account.id)] ?? ((CASH_TYPES as readonly string[]).includes(account.type) ? 'exclude_pending' : 'include_pending');
}

export function driftForAccount(db: DbOrTx, accountId: number): Drift {
	const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
	if (!account) throw new NotFoundError(`account ${accountId} not found`);
	const convention = conventionFor(db, account);
	const where = convention === 'exclude_pending'
		? and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt), eq(transactions.pending, false))
		: and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt));
	const ledgerBalance = db.select({ s: sql<number>`coalesce(sum(${transactions.amount}), 0)` }).from(transactions).where(where).get()?.s ?? 0;
	const bal = latestBalance(db, accountId);
	const providerBalance = bal?.current ?? null;
	return { accountId, providerBalance, ledgerBalance, drift: providerBalance == null ? null : providerBalance - ledgerBalance, convention };
}

export function driftReport(db: DbOrTx): Drift[] {
	return db.select({ id: accounts.id }).from(accounts).where(isNull(accounts.closedAt)).all().map((a) => driftForAccount(db, a.id));
}

/**
 * A provider's balance can run a sync or more ahead of the transactions that explain it, and an adjustment made in
 * that window is counted twice when they arrive. So a synced account's drift settles only after this many consecutive
 * full syncs saw exactly the same amount. Balance-only refreshes cannot bring the missing rows, so they do not count.
 */
export const SETTLE_FULL_SYNCS = 2;

/** Record each open account's drift at the end of a successful full sync of its connection. */
export function observeDrift(db: DbOrTx, connectionId: number, now: string): void {
	const accts = db.select({ id: accounts.id }).from(accounts)
		.where(and(eq(accounts.connectionId, connectionId), isNull(accounts.closedAt))).all();
	for (const { id } of accts) {
		const { drift } = driftForAccount(db, id);
		if (drift == null || drift === 0) {
			db.delete(driftWatch).where(eq(driftWatch.accountId, id)).run();
			continue;
		}
		const prev = db.select().from(driftWatch).where(eq(driftWatch.accountId, id)).get();
		const next = prev && prev.drift === drift
			? { drift, fullSyncs: prev.fullSyncs + 1, firstSeenAt: prev.firstSeenAt, lastSeenAt: now }
			: { drift, fullSyncs: 1, firstSeenAt: now, lastSeenAt: now };
		db.insert(driftWatch).values({ accountId: id, ...next })
			.onConflictDoUpdate({ target: driftWatch.accountId, set: next }).run();
	}
}

/** Whether the account's current drift may be adjusted away. A manual account's drift is a balance the user typed, so it settles at once. */
export function driftSettled(db: DbOrTx, accountId: number): boolean {
	const row = db.select({ provider: connections.provider }).from(accounts)
		.innerJoin(connections, eq(connections.id, accounts.connectionId)).where(eq(accounts.id, accountId)).get();
	if (!row) throw new NotFoundError(`account ${accountId} not found`);
	if (row.provider === 'manual') return true;
	const { drift } = driftForAccount(db, accountId);
	const watch = db.select().from(driftWatch).where(eq(driftWatch.accountId, accountId)).get();
	return drift != null && watch != null && watch.drift === drift && watch.fullSyncs >= SETTLE_FULL_SYNCS;
}

export function createAdjustment(db: DbOrTx, accountId: number, amount: number, dateIso: string): number {
	const recon = systemCategoryId(db, 'reconciliation');
	const id = createTransaction(db, {
		accountId, externalId: `adjustment:${dateIso}:${nowIso()}`, postedDate: dateIso, amount,
		payeeRaw: 'Reconciliation adjustment', payee: 'Reconciliation adjustment', source: 'adjustment',
		splits: [{ categoryId: recon, amount }]
	});
	markProcessed(db, [id]);
	return id;
}
