import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from './db';
import { accounts, transactions, CASH_TYPES } from './db/schema';
import { latestBalance } from './sync/connections';
import { getSetting } from './settings';
import { createTransaction, markProcessed } from './ledger/transactions';
import { systemCategoryId } from './ledger/categories';
import { nowIso } from '$lib/dates';

export type PendingConvention = 'exclude_pending' | 'include_pending';
export const PENDING_CONVENTION_KEY = 'pending_convention';
export type Drift = { accountId: number; providerBalance: number | null; ledgerBalance: number; drift: number | null; convention: PendingConvention };

export function conventionFor(db: DbOrTx, account: { id: number; type: string }): PendingConvention {
	const overrides = getSetting<Record<string, PendingConvention>>(db, PENDING_CONVENTION_KEY, {});
	return overrides[String(account.id)] ?? ((CASH_TYPES as readonly string[]).includes(account.type) ? 'exclude_pending' : 'include_pending');
}

export function driftForAccount(db: DbOrTx, accountId: number): Drift {
	const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
	if (!account) throw new Error(`account ${accountId} not found`);
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
