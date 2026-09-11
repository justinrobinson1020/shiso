import { and, asc, eq, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, bills, plannedExtras, promoBalances } from '../db/schema';
import { latestTerms } from '../sync/connections';
import { paymentCategoryForAccount } from '../ledger/categories';
import { assign, assignmentsForPeriod, assertBudgetPeriod } from '../ledger/assignments';
import { budgetForPeriod } from '../budget/load';
import { InvariantError } from '../ledger/errors';
import { nowIso } from '$lib/dates';

/** The only writer of `planned_extras` and `promo_balances` (P2 §3). */
const touch = () => ({ updatedAt: nowIso() });

function assertDebtAccount(db: DbOrTx, accountId: number): void {
	const a = db.select({ isDebt: accounts.isDebt }).from(accounts).where(eq(accounts.id, accountId)).get();
	if (!a) throw new Error(`account ${accountId} not found`);
	if (!a.isDebt) throw new InvariantError('NOT_DEBT_ACCOUNT');
}

/** P2 §2: latest terms minimum, else the linked active bill's expected amount, else null (unknown). */
export function debtMinimum(db: DbOrTx, accountId: number): number | null {
	const t = latestTerms(db, accountId);
	if (t?.minPayment != null && t.minPayment > 0) return t.minPayment;   // a provider's zero means "none reported", not "nothing due"
	const b = db.select({ expected: bills.expectedAmount }).from(bills).where(and(eq(bills.linkedDebtAccountId, accountId), eq(bills.active, true))).orderBy(asc(bills.id)).get();
	return b?.expected ?? null;
}

export function setPlannedExtra(db: DbOrTx, input: { periodId: number; accountId: number; extraAmount: number }): void {
	assertDebtAccount(db, input.accountId);
	if (!Number.isInteger(input.extraAmount) || input.extraAmount < 0) throw new InvariantError('EXTRA_NEGATIVE');
	const where = and(eq(plannedExtras.accountId, input.accountId), eq(plannedExtras.periodId, input.periodId));
	if (input.extraAmount === 0) { db.delete(plannedExtras).where(where).run(); return; }
	const existing = db.select({ id: plannedExtras.id }).from(plannedExtras).where(where).get();
	if (existing) db.update(plannedExtras).set({ extraAmount: input.extraAmount, ...touch() }).where(eq(plannedExtras.id, existing.id)).run();
	else db.insert(plannedExtras).values({ accountId: input.accountId, periodId: input.periodId, extraAmount: input.extraAmount }).run();
}

export function plannedExtrasForPeriod(db: DbOrTx, periodId: number): Map<number, number> {
	return new Map(db.select({ accountId: plannedExtras.accountId, extra: plannedExtras.extraAmount }).from(plannedExtras).where(eq(plannedExtras.periodId, periodId)).all().map((r) => [r.accountId, r.extra]));
}

/** P2 §4.2: raise the payment envelope's assignment by the shortfall between the planned payment and what it holds. Idempotent. */
export function fundShortfall(db: DbOrTx, input: { periodId: number; accountId: number }): { categoryId: number; shortfall: number; assigned: number } {
	assertBudgetPeriod(db, input.periodId);   // before budgetForPeriod: a history period has no envelopes to compute
	assertDebtAccount(db, input.accountId);
	const categoryId = paymentCategoryForAccount(db, input.accountId);
	if (categoryId == null) throw new InvariantError('NO_PAYMENT_CATEGORY');
	const minimum = debtMinimum(db, input.accountId) ?? 0;
	const extra = plannedExtrasForPeriod(db, input.periodId).get(input.accountId) ?? 0;
	const available = budgetForPeriod(db, input.periodId).byPeriod.get(input.periodId)?.get(categoryId)?.available ?? 0;
	const shortfall = Math.max(0, minimum + extra - available);
	const current = assignmentsForPeriod(db, input.periodId).find((a) => a.categoryId === categoryId)?.assigned ?? 0;
	if (shortfall > 0) assign(db, input.periodId, categoryId, current + shortfall);
	return { categoryId, shortfall, assigned: current + shortfall };
}

export type NewPromo = { accountId: number; description: string; originalAmount: number; remainingAmount?: number | null; aprBps?: number; expiresOn: string };

export function createPromo(db: DbOrTx, input: NewPromo): number {
	assertDebtAccount(db, input.accountId);
	const remaining = input.remainingAmount ?? input.originalAmount;
	if (input.originalAmount <= 0) throw new InvariantError('PROMO_AMOUNT_NOT_POSITIVE');
	if (remaining < 0 || remaining > input.originalAmount) throw new InvariantError('PROMO_REMAINING_OUT_OF_RANGE');
	if ((input.aprBps ?? 0) < 0) throw new InvariantError('PROMO_APR_NEGATIVE');
	return db.insert(promoBalances).values({
		accountId: input.accountId, description: input.description, originalAmount: input.originalAmount, remainingAmount: remaining,
		aprBps: input.aprBps ?? 0, expiresOn: input.expiresOn, closedAt: remaining === 0 ? nowIso() : null
	}).returning({ id: promoBalances.id }).get().id;
}

export function updatePromo(db: DbOrTx, id: number, patch: { description?: string; remainingAmount?: number; aprBps?: number; expiresOn?: string }): void {
	const row = db.select().from(promoBalances).where(eq(promoBalances.id, id)).get();
	if (!row) throw new Error(`promo ${id} not found`);
	const set: Partial<typeof promoBalances.$inferInsert> = { ...touch() };
	if (patch.description !== undefined) set.description = patch.description;
	if (patch.expiresOn !== undefined) set.expiresOn = patch.expiresOn;
	if (patch.aprBps !== undefined) { if (patch.aprBps < 0) throw new InvariantError('PROMO_APR_NEGATIVE'); set.aprBps = patch.aprBps; }
	if (patch.remainingAmount !== undefined) {
		if (patch.remainingAmount < 0 || patch.remainingAmount > row.originalAmount) throw new InvariantError('PROMO_REMAINING_OUT_OF_RANGE');
		set.remainingAmount = patch.remainingAmount;
		set.closedAt = patch.remainingAmount === 0 ? (row.closedAt ?? nowIso()) : null;
	}
	db.update(promoBalances).set(set).where(eq(promoBalances.id, id)).run();
}

export function closePromo(db: DbOrTx, id: number): void {
	const row = db.select({ id: promoBalances.id }).from(promoBalances).where(eq(promoBalances.id, id)).get();
	if (!row) throw new Error(`promo ${id} not found`);
	db.update(promoBalances).set({ closedAt: nowIso(), ...touch() }).where(eq(promoBalances.id, id)).run();
}

export function openPromos(db: DbOrTx) {
	return db.select().from(promoBalances).where(isNull(promoBalances.closedAt)).orderBy(asc(promoBalances.expiresOn), asc(promoBalances.id)).all();
}
