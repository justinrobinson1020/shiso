import { and, gte, lte, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { periods } from '../db/schema';
import { addDays, endOfMonth, startOfMonth, compareIso } from '$lib/dates';

export type Cadence = 'semi_monthly' | 'monthly';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function label(startDate: string, endDate: string, cadence: Cadence): string {
	const y = startDate.slice(0, 4);
	const m = MONTHS[+startDate.slice(5, 7) - 1];
	if (cadence === 'monthly') return `${m} ${y}`;
	return `${m} ${+startDate.slice(8, 10)}–${+endDate.slice(8, 10)}, ${y}`;
}

/** The period (by cadence) containing `iso`. Pure. */
export function periodBoundsFor(cadence: Cadence, iso: string) {
	const som = startOfMonth(iso);
	const eom = endOfMonth(iso);
	if (cadence === 'monthly') return { startDate: som, endDate: eom, label: label(som, eom, cadence) };
	const day = +iso.slice(8, 10);
	const mid = som.slice(0, 8) + '15';
	const [startDate, endDate] = day <= 15 ? [som, mid] : [som.slice(0, 8) + '16', eom];
	return { startDate, endDate, label: label(startDate, endDate, cadence) };
}

export function nextPeriodStart(cadence: Cadence, endDate: string): string {
	return addDays(endDate, 1);
}

/** Insert every period needed so that [fromIso, throughIso] is fully covered. Idempotent. */
export function ensurePeriods(db: DbOrTx, cadence: Cadence, fromIso: string, throughIso: string): void {
	const existing = new Set(db.select({ s: periods.startDate }).from(periods).all().map((r) => r.s));
	const rows: { startDate: string; endDate: string; label: string }[] = [];
	let cursor = periodBoundsFor(cadence, fromIso);
	while (compareIso(cursor.startDate, throughIso) <= 0) {
		if (!existing.has(cursor.startDate)) rows.push(cursor);
		cursor = periodBoundsFor(cadence, nextPeriodStart(cadence, cursor.endDate));
	}
	if (rows.length > 0) db.insert(periods).values(rows).run();
}

export function periodIdForDate(db: DbOrTx, iso: string): number {
	const row = db
		.select({ id: periods.id })
		.from(periods)
		.where(and(lte(periods.startDate, iso), gte(periods.endDate, iso)))
		.get();
	if (!row) throw new Error(`no period covers ${iso}; call ensurePeriods first`);
	return row.id;
}

/**
 * The period containing today, extending the table when the process has outlived
 * the startup back-fill. Keeps one period beyond today covered, as startup does.
 */
export function currentPeriodId(db: DbOrTx, cadence: Cadence, todayIso: string): number {
	const current = periodBoundsFor(cadence, todayIso);
	const next = periodBoundsFor(cadence, nextPeriodStart(cadence, current.endDate));
	ensurePeriods(db, cadence, todayIso, next.endDate);
	return periodIdForDate(db, todayIso);
}

/** Earliest and latest period start dates, or null when none exist. */
export function periodRange(db: DbOrTx): { first: string; last: string } | null {
	const row = db
		.select({ first: sql<string>`min(${periods.startDate})`, last: sql<string>`max(${periods.startDate})` })
		.from(periods)
		.get();
	return row && row.first ? { first: row.first, last: row.last } : null;
}
