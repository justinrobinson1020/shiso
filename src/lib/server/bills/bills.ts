import { asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { bills, incomeSources, type BillCadence } from '../db/schema';
import { nowIso } from '$lib/dates';

export type NewBill = {
	name: string; categoryId: number; payFromAccountId: number; expectedAmount: number;
	toleranceAbs?: number; tolerancePct?: number; cadence: BillCadence; dueDay?: number | null; dueDay2?: number | null;
	interval?: number | null; anchorDate?: string | null; autopay?: boolean; matchPattern?: string | null; linkedDebtAccountId?: number | null;
};
export type NewIncome = {
	name: string; categoryId: number; depositAccountId: number; expectedAmount: number;
	toleranceAbs?: number; tolerancePct?: number; cadence: BillCadence; dueDay?: number | null; dueDay2?: number | null;
	interval?: number | null; anchorDate?: string | null; matchPattern?: string | null;
};
const touch = () => ({ updatedAt: nowIso() });

export function createBill(db: DbOrTx, input: NewBill): number {
	return db.insert(bills).values({
		name: input.name, categoryId: input.categoryId, payFromAccountId: input.payFromAccountId, expectedAmount: input.expectedAmount,
		toleranceAbs: input.toleranceAbs ?? 0, tolerancePct: input.tolerancePct ?? 0, cadence: input.cadence,
		dueDay: input.dueDay ?? null, dueDay2: input.dueDay2 ?? null, interval: input.interval ?? null, anchorDate: input.anchorDate ?? null,
		autopay: input.autopay ?? false, matchPattern: input.matchPattern ?? null, linkedDebtAccountId: input.linkedDebtAccountId ?? null
	}).returning({ id: bills.id }).get().id;
}
export function updateBill(db: DbOrTx, id: number, patch: Partial<NewBill>): void {
	db.update(bills).set({ ...patch, ...touch() }).where(eq(bills.id, id)).run();
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
		matchPattern: input.matchPattern ?? null
	}).returning({ id: incomeSources.id }).get().id;
}
export function updateIncomeSource(db: DbOrTx, id: number, patch: Partial<NewIncome>): void {
	db.update(incomeSources).set({ ...patch, ...touch() }).where(eq(incomeSources.id, id)).run();
}
export function setIncomeActive(db: DbOrTx, id: number, active: boolean): void {
	db.update(incomeSources).set({ active, ...touch() }).where(eq(incomeSources.id, id)).run();
}
export function listIncomeSources(db: DbOrTx) {
	return db.select().from(incomeSources).orderBy(asc(incomeSources.name)).all();
}
