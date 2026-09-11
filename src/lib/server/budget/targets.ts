import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { categories, categoryTargets, periods, type TargetKind } from '../db/schema';
import { InvariantError } from '../ledger/errors';
import { assign, assignmentsForPeriod } from '../ledger/assignments';
import { budgetForPeriod } from './load';
import { NO_ENVELOPE_KINDS } from './envelope';
import type { Cadence } from './periods';
import { nowIso } from '$lib/dates';

/** P4 §4: what a target asks of one period. */
export type Target = { kind: TargetKind; amount: number; targetDate: string | null };
export type TargetStatus = { kind: TargetKind; amount: number; targetDate: string | null; needed: number; progress: number; perPeriod: number | null; periodsLeft: number | null };

export function targetStatus(t: Target, cell: { assigned: number; available: number }, ctx: { periodsPerMonth: number; periodsThroughDate: number }): TargetStatus {
	const base = { kind: t.kind, amount: t.amount, targetDate: t.targetDate, perPeriod: null as number | null, periodsLeft: null as number | null };
	const clamp = (x: number) => Math.min(1, Math.max(0, x));
	switch (t.kind) {
		case 'monthly': {
			const perPeriod = Math.round(t.amount / ctx.periodsPerMonth);
			return { ...base, perPeriod, needed: Math.max(0, perPeriod - cell.assigned), progress: perPeriod > 0 ? clamp(cell.assigned / perPeriod) : 1 };
		}
		case 'refill':
			return { ...base, needed: Math.max(0, t.amount - cell.available), progress: clamp(cell.available / t.amount) };
		case 'by_date': {
			const n = Math.max(1, ctx.periodsThroughDate);
			const remaining = t.amount - (cell.available - cell.assigned);
			const share = Math.max(0, Math.ceil(remaining / n));
			return { ...base, periodsLeft: n, perPeriod: share, needed: Math.max(0, share - cell.assigned), progress: clamp(cell.available / t.amount) };
		}
	}
}

/** Periods from `periodId` through the one containing `date`, inclusive; 1 when the date is in or before the period. */
export function periodsThrough(db: DbOrTx, periodId: number, date: string): number {
	const p = db.select().from(periods).where(eq(periods.id, periodId)).get();
	if (!p) throw new Error(`period ${periodId} not found`);
	if (date <= p.endDate) return 1;
	return 1 + db.select({ id: periods.id }).from(periods).where(and(gte(periods.startDate, p.endDate), lte(periods.startDate, date))).all().length;
}

export const periodsPerMonth = (cadence: Cadence) => (cadence === 'semi_monthly' ? 2 : 1);

export function listTargets(db: DbOrTx): Map<number, Target> {
	return new Map(db.select().from(categoryTargets).orderBy(asc(categoryTargets.id)).all().map((t) => [t.categoryId, { kind: t.kind, amount: t.amount, targetDate: t.targetDate }]));
}

const touch = () => ({ updatedAt: nowIso() });

export function setTarget(db: DbOrTx, categoryId: number, t: Target): void {
	const c = db.select({ kind: categories.kind }).from(categories).where(eq(categories.id, categoryId)).get();
	if (!c) throw new Error(`category ${categoryId} not found`);
	if (NO_ENVELOPE_KINDS.has(c.kind)) throw new InvariantError('TARGET_NO_ENVELOPE');
	if (!Number.isInteger(t.amount) || t.amount <= 0) throw new InvariantError('TARGET_AMOUNT_NOT_POSITIVE');
	if (t.kind === 'by_date' ? t.targetDate == null : t.targetDate != null) throw new InvariantError('TARGET_DATE_MISMATCH');
	const existing = db.select({ id: categoryTargets.id }).from(categoryTargets).where(eq(categoryTargets.categoryId, categoryId)).get();
	if (existing) db.update(categoryTargets).set({ kind: t.kind, amount: t.amount, targetDate: t.targetDate, ...touch() }).where(eq(categoryTargets.id, existing.id)).run();
	else db.insert(categoryTargets).values({ categoryId, kind: t.kind, amount: t.amount, targetDate: t.targetDate }).run();
}

export function clearTarget(db: DbOrTx, categoryId: number): void {
	db.delete(categoryTargets).where(eq(categoryTargets.categoryId, categoryId)).run();
}

/** Status for every targeted category in a period. */
export function targetStatuses(db: DbOrTx, periodId: number, cadence: Cadence): Map<number, TargetStatus> {
	const cells = budgetForPeriod(db, periodId).byPeriod.get(periodId) ?? new Map();
	const ppm = periodsPerMonth(cadence);
	const out = new Map<number, TargetStatus>();
	for (const [categoryId, t] of listTargets(db)) {
		const cell = cells.get(categoryId) ?? { assigned: 0, available: 0 };
		out.set(categoryId, targetStatus(t, cell, { periodsPerMonth: ppm, periodsThroughDate: t.targetDate ? periodsThrough(db, periodId, t.targetDate) : 1 }));
	}
	return out;
}

/** P4 §2: assign each need on top of the current assignment. One category when given, else every category with a positive need. Idempotent. */
export function fundTargets(db: DbOrTx, opts: { periodId: number; cadence: Cadence; categoryId?: number | null }): { funded: { categoryId: number; amount: number }[] } {
	const statuses = targetStatuses(db, opts.periodId, opts.cadence);
	const current = new Map(assignmentsForPeriod(db, opts.periodId).map((a) => [a.categoryId, a.assigned]));
	const funded: { categoryId: number; amount: number }[] = [];
	db.transaction((tx) => {
		for (const [categoryId, s] of statuses) {
			if (opts.categoryId != null && categoryId !== opts.categoryId) continue;
			if (s.needed <= 0) continue;
			assign(tx, opts.periodId, categoryId, (current.get(categoryId) ?? 0) + s.needed);
			funded.push({ categoryId, amount: s.needed });
		}
	});
	if (opts.categoryId != null && !statuses.has(opts.categoryId)) throw new InvariantError('NO_TARGET');
	return { funded };
}
