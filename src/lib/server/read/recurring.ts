import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { bills } from '../db/schema';
import { patternMatches } from '../bills/matching';
import { detectRecurring, type Recurring } from '../spending/recurring';
import { splitRows, historyMonths } from './spending';

export type RecurringView = {
	windowStart: string; windowEnd: string; includeExcluded: boolean;
	rows: Recurring[];
	totals: { monthly: number; newMonthly: number; count: number; newCount: number; overdue: number };
};

/** P3 §3.3: recurring payees over the twelve months ending today, marked covered when an active bill already matches them. */
export function recurringView(db: DbOrTx, opts: { todayIso: string; includeExcluded?: boolean }): RecurringView {
	const months = historyMonths(opts.todayIso);
	const windowStart = `${months[0]}-01`;
	const charges = splitRows(db, windowStart, opts.todayIso, { includeExcluded: opts.includeExcluded ?? false })
		.map((r) => ({ date: r.postedDate, payee: r.payee, amount: -r.amount }));
	const active = db.select({ name: bills.name, pattern: bills.matchPattern }).from(bills).where(and(eq(bills.active, true))).all();
	const isCovered = (payee: string) => active.some((b) => (b.pattern ? patternMatches(b.pattern, payee, payee) : false) || b.name.toLowerCase() === payee.toLowerCase());
	const rows = detectRecurring(charges, { todayIso: opts.todayIso, isCovered });
	const fresh = rows.filter((r) => !r.covered);
	return {
		windowStart, windowEnd: opts.todayIso, includeExcluded: opts.includeExcluded ?? false, rows,
		totals: { monthly: rows.reduce((s, r) => s + r.monthlyCost, 0), newMonthly: fresh.reduce((s, r) => s + r.monthlyCost, 0), count: rows.length, newCount: fresh.length, overdue: rows.filter((r) => r.overdue).length }
	};
}
