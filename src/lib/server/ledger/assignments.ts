import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { budgetAssignments, categories } from '../db/schema';
import { InvariantError } from './errors';
import { nowIso } from '$lib/dates';
import { NO_ENVELOPE_KINDS } from '../budget/envelope';

function assertHasEnvelope(db: DbOrTx, categoryId: number): void {
	const c = db.select({ kind: categories.kind }).from(categories).where(eq(categories.id, categoryId)).get();
	if (!c) throw new Error(`category ${categoryId} not found`);
	if (NO_ENVELOPE_KINDS.has(c.kind)) throw new InvariantError('ASSIGN_NO_ENVELOPE');
}

function upsert(db: DbOrTx, periodId: number, categoryId: number, delta: number, absolute: boolean): void {
	const existing = db
		.select()
		.from(budgetAssignments)
		.where(and(eq(budgetAssignments.periodId, periodId), eq(budgetAssignments.categoryId, categoryId)))
		.get();
	const next = absolute ? delta : (existing?.assigned ?? 0) + delta;
	if (existing) {
		db.update(budgetAssignments).set({ assigned: next, updatedAt: nowIso() }).where(eq(budgetAssignments.id, existing.id)).run();
	} else {
		db.insert(budgetAssignments).values({ periodId, categoryId, assigned: next }).run();
	}
}

export function assign(db: DbOrTx, periodId: number, categoryId: number, assigned: number): void {
	assertHasEnvelope(db, categoryId);
	upsert(db, periodId, categoryId, assigned, true);
}

export function moveMoney(db: DbOrTx, periodId: number, fromCategoryId: number, toCategoryId: number, amount: number): void {
	if (fromCategoryId === toCategoryId) throw new InvariantError('MOVE_SAME_CATEGORY');
	if (!(amount > 0)) throw new InvariantError('MOVE_AMOUNT_NOT_POSITIVE');
	assertHasEnvelope(db, fromCategoryId);
	assertHasEnvelope(db, toCategoryId);
	db.transaction((tx) => {
		upsert(tx, periodId, fromCategoryId, -amount, false);
		upsert(tx, periodId, toCategoryId, amount, false);
	});
}

export function assignmentsForPeriod(db: DbOrTx, periodId: number): { categoryId: number; assigned: number }[] {
	return db
		.select({ categoryId: budgetAssignments.categoryId, assigned: budgetAssignments.assigned })
		.from(budgetAssignments)
		.where(eq(budgetAssignments.periodId, periodId))
		.all();
}
