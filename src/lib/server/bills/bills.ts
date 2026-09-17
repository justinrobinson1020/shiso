import { asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { and, desc, gt, gte, isNull } from 'drizzle-orm';
import { bills, billOccurrences, incomeSources, incomeOccurrences, type BillCadence } from '../db/schema';
import { InvariantError } from '../ledger/errors';
import { nowIso } from '$lib/dates';

export type NewBill = {
	name: string; categoryId: number; payFromAccountId: number; expectedAmount: number;
	toleranceAbs?: number; tolerancePct?: number; cadence: BillCadence; dueDay?: number | null; dueDay2?: number | null;
	interval?: number | null; anchorDate?: string | null; autopay?: boolean; variable?: boolean; matchPattern?: string | null; linkedDebtAccountId?: number | null;
};
export type NewIncome = {
	name: string; categoryId: number; depositAccountId: number; expectedAmount: number;
	toleranceAbs?: number; tolerancePct?: number; cadence: BillCadence; dueDay?: number | null; dueDay2?: number | null;
	interval?: number | null; anchorDate?: string | null; settleBusinessDays?: number | null; matchPattern?: string | null;
};
const touch = () => ({ updatedAt: nowIso() });

export function createBill(db: DbOrTx, input: NewBill): number {
	return db.insert(bills).values({
		name: input.name, categoryId: input.categoryId, payFromAccountId: input.payFromAccountId, expectedAmount: input.expectedAmount,
		toleranceAbs: input.toleranceAbs ?? 0, tolerancePct: input.tolerancePct ?? 0, cadence: input.cadence,
		dueDay: input.dueDay ?? null, dueDay2: input.dueDay2 ?? null, interval: input.interval ?? null, anchorDate: input.anchorDate ?? null,
		autopay: input.autopay ?? false, variable: input.variable ?? false, matchPattern: input.matchPattern ?? null, linkedDebtAccountId: input.linkedDebtAccountId ?? null
	}).returning({ id: bills.id }).get().id;
}
export function updateBill(db: DbOrTx, id: number, patch: Partial<NewBill>): void {
	db.update(bills).set({ ...patch, ...touch() }).where(eq(bills.id, id)).run();
}
/** What the bill last actually cost: the most recent paid occurrence's amount, or null if it has never been paid. */
export function lastPaidAmount(db: DbOrTx, billId: number): number | null {
	return db.select({ paid: billOccurrences.paidAmount }).from(billOccurrences)
		.where(and(eq(billOccurrences.billId, billId), eq(billOccurrences.status, 'paid'), gt(billOccurrences.paidAmount, 0)))
		.orderBy(desc(billOccurrences.dueDate)).get()?.paid ?? null;
}
/** Correct one open occurrence's estimate. Only this occurrence changes; the bill and later months keep their own. */
export function setOccurrenceExpected(db: DbOrTx, occurrenceId: number, amount: number): void {
	const o = db.select().from(billOccurrences).where(eq(billOccurrences.id, occurrenceId)).get();
	if (!o) throw new Error(`occurrence ${occurrenceId} not found`);
	if (o.status === 'paid') throw new InvariantError('OCCURRENCE_ALREADY_PAID');
	if (amount < 0) throw new InvariantError('OCCURRENCE_AMOUNT_NEGATIVE');
	db.update(billOccurrences).set({ expectedAmount: amount, ...touch() }).where(eq(billOccurrences.id, occurrenceId)).run();
}
export function setBillActive(db: DbOrTx, id: number, active: boolean): void {
	db.update(bills).set({ active, ...touch() }).where(eq(bills.id, id)).run();
}
export function listBills(db: DbOrTx) {
	return db.select().from(bills).orderBy(asc(bills.name)).all();
}

export function createIncomeSource(db: DbOrTx, input: NewIncome): number {
	return db.insert(incomeSources).values({
		name: input.name, categoryId: input.categoryId, depositAccountId: input.depositAccountId, expectedAmount: input.expectedAmount,
		toleranceAbs: input.toleranceAbs ?? 0, tolerancePct: input.tolerancePct ?? 0, cadence: input.cadence,
		dueDay: input.dueDay ?? null, dueDay2: input.dueDay2 ?? null, interval: input.interval ?? null, anchorDate: input.anchorDate ?? null,
		settleBusinessDays: input.settleBusinessDays ?? null, matchPattern: input.matchPattern ?? null
	}).returning({ id: incomeSources.id }).get().id;
}
export function updateIncomeSource(db: DbOrTx, id: number, patch: Partial<NewIncome>): void {
	db.update(incomeSources).set({ ...patch, ...touch() }).where(eq(incomeSources.id, id)).run();
}
/**
 * Drop the occurrences a schedule change would leave at stale dates: those still pending, not yet matched to a
 * deposit, and due today or later. The next generateOccurrences run recreates them from the new schedule.
 */
export function clearPendingIncomeOccurrences(db: DbOrTx, incomeSourceId: number, todayIso: string): number {
	return db.delete(incomeOccurrences).where(and(
		eq(incomeOccurrences.incomeSourceId, incomeSourceId), eq(incomeOccurrences.status, 'pending'),
		isNull(incomeOccurrences.transactionId), gte(incomeOccurrences.dueDate, todayIso)
	)).run().changes;
}
export function setIncomeActive(db: DbOrTx, id: number, active: boolean): void {
	db.update(incomeSources).set({ active, ...touch() }).where(eq(incomeSources.id, id)).run();
}
export function listIncomeSources(db: DbOrTx) {
	return db.select().from(incomeSources).orderBy(asc(incomeSources.name)).all();
}
