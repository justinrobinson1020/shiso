import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { bills, billOccurrences, billOccurrenceTransactions, incomeSources, incomeOccurrences, type BillCadence } from '../db/schema';
import { ensurePeriods, periodIdForDate, periodBoundsFor, nextPeriodStart, type Cadence } from '../budget/periods';
import { latestTerms } from '../sync/connections';
import { lastPaidAmount } from './bills';
import { addDays, compareIso, endOfMonth, isoDate, parseIso } from '$lib/dates';
import { landOnBusinessDays } from '$lib/business-days';

export const DEBT_WINDOW_BEFORE = 25;
export const BILL_WINDOW_BEFORE = 10;
export const INCOME_WINDOW_BEFORE = 5;
const LOOKBACK_DAYS = 31;

/** `settleBusinessDays` moves each nominal date to where the money actually lands (see landOnBusinessDays); null or 0 keeps the nominal date. */
export type Schedule = { cadence: BillCadence; dueDay?: number | null; dueDay2?: number | null; interval?: number | null; anchorDate?: string | null; settleBusinessDays?: number | null };
/** Landing can only move a date forward, and never by more than this many calendar days. */
const MAX_SETTLE_SHIFT = 14;

function clampDay(year: number, month0: number, day: number): string {
	const first = isoDate(new Date(Date.UTC(year, month0, 1)));
	const eom = endOfMonth(first);
	const d = Math.min(day, +eom.slice(8, 10));
	return `${first.slice(0, 8)}${String(d).padStart(2, '0')}`;
}

/** Due dates inside [fromIso, throughIso], ascending. Pure. */
export function dueDatesBetween(s: Schedule, fromIso: string, throughIso: string): string[] {
	const out: string[] = [];
	const inRange = (d: string) => compareIso(d, fromIso) >= 0 && compareIso(d, throughIso) <= 0;
	const settle = s.settleBusinessDays ?? 0;
	if (settle > 0) {
		// A nominal date shortly before the range can land inside it, so widen the nominal search backwards.
		const nominal = dueDatesBetween({ ...s, settleBusinessDays: null }, addDays(fromIso, -MAX_SETTLE_SHIFT), throughIso);
		return [...new Set(nominal.map((d) => landOnBusinessDays(d, settle)).filter(inRange))].sort();
	}
	if (s.cadence === 'monthly' || s.cadence === 'semi_monthly') {
		const days = s.cadence === 'monthly' ? [s.dueDay ?? 1] : [s.dueDay ?? 1, s.dueDay2 ?? 15];
		const start = parseIso(fromIso), end = parseIso(throughIso);
		for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) {
			const m0 = y === start.getUTCFullYear() ? start.getUTCMonth() : 0;
			const m1 = y === end.getUTCFullYear() ? end.getUTCMonth() : 11;
			for (let m = m0; m <= m1; m++) for (const day of days) { const d = clampDay(y, m, day); if (inRange(d)) out.push(d); }
		}
	} else if (s.cadence === 'every_n_weeks') {
		const step = Math.max(1, s.interval ?? 1) * 7;
		let d = s.anchorDate ?? fromIso;
		while (compareIso(d, fromIso) < 0) d = addDays(d, step);
		while (compareIso(d, throughIso) <= 0) { out.push(d); d = addDays(d, step); }
	} else if (s.cadence === 'yearly') {
		const anchor = s.anchorDate ?? fromIso;
		const y0 = +fromIso.slice(0, 4), y1 = +throughIso.slice(0, 4);
		for (let y = y0; y <= y1; y++) { const d = clampDay(y, +anchor.slice(5, 7) - 1, +anchor.slice(8, 10)); if (inRange(d)) out.push(d); }
	}
	return [...new Set(out)].sort();
}

export function generateOccurrences(db: DbOrTx, opts: { todayIso: string; cadence: Cadence; graceDays: number }): { billsCreated: number; incomeCreated: number } {
	const current = periodBoundsFor(opts.cadence, opts.todayIso);
	const horizonEnd = periodBoundsFor(opts.cadence, nextPeriodStart(opts.cadence, current.endDate)).endDate;
	const lookback = addDays(opts.todayIso, -LOOKBACK_DAYS);
	ensurePeriods(db, opts.cadence, lookback, horizonEnd);
	let billsCreated = 0, incomeCreated = 0;

	for (const b of db.select().from(bills).where(eq(bills.active, true)).all()) {
		const floor = lookback;
		const existing = new Set(db.select({ d: billOccurrences.dueDate }).from(billOccurrences).where(eq(billOccurrences.billId, b.id)).all().map((r) => r.d));
		const terms = b.linkedDebtAccountId != null ? latestTerms(db, b.linkedDebtAccountId) : null;
		const isDebt = b.linkedDebtAccountId != null;
		let plan: { due: string; expected: number; statement: number | null; windowStart: string }[];
		const termsDue = terms?.nextDueDate;
		const termsInRange = termsDue != null && compareIso(termsDue, floor) >= 0 && compareIso(termsDue, horizonEnd) <= 0;
		if (isDebt && termsInRange) {
			const due = termsDue!;
			plan = [{ due, expected: terms!.minPayment ?? b.expectedAmount, statement: terms!.lastStatementBalance ?? null,
				windowStart: terms!.lastStatementDate ?? addDays(due, -DEBT_WINDOW_BEFORE) }];
		} else {
			// A variable bill's estimate is what it cost last time; the definition's amount only seeds a bill never paid.
			const expected = (b.variable && lastPaidAmount(db, b.id)) || b.expectedAmount;
			plan = dueDatesBetween(b, floor, horizonEnd).map((due) => ({
				due, expected, statement: null, windowStart: addDays(due, -(isDebt ? DEBT_WINDOW_BEFORE : BILL_WINDOW_BEFORE))
			}));
		}
		for (const p of plan) {
			if (existing.has(p.due)) {
				// Plaid reports a card's minimum as 0 until the statement cuts, and the number moves after a payment.
				// Keep a terms-driven occurrence current while it is still open and no payment is linked to it.
				if (isDebt && termsInRange && p.due === termsDue) {
					const row = db.select().from(billOccurrences).where(and(eq(billOccurrences.billId, b.id), eq(billOccurrences.dueDate, p.due))).get();
					const linked = row && db.select({ t: billOccurrenceTransactions.transactionId }).from(billOccurrenceTransactions).where(eq(billOccurrenceTransactions.billOccurrenceId, row.id)).get();
					if (row && row.status === 'pending' && !linked && (row.expectedAmount !== p.expected || row.statementBalance !== p.statement || row.windowStart !== p.windowStart)) {
						db.update(billOccurrences).set({ expectedAmount: p.expected, statementBalance: p.statement, windowStart: p.windowStart }).where(eq(billOccurrences.id, row.id)).run();
					}
				}
				continue;
			}
			db.insert(billOccurrences).values({
				billId: b.id, dueDate: p.due, periodId: periodIdForDate(db, p.due), expectedAmount: p.expected, statementBalance: p.statement,
				windowStart: p.windowStart, windowEnd: addDays(p.due, opts.graceDays)
			}).run();
			billsCreated++;
		}
	}

	for (const s of db.select().from(incomeSources).where(eq(incomeSources.active, true)).all()) {
		const floor = lookback;
		const existing = new Set(db.select({ d: incomeOccurrences.dueDate }).from(incomeOccurrences).where(eq(incomeOccurrences.incomeSourceId, s.id)).all().map((r) => r.d));
		for (const due of dueDatesBetween(s, floor, horizonEnd)) {
			if (existing.has(due)) continue;
			db.insert(incomeOccurrences).values({
				incomeSourceId: s.id, dueDate: due, periodId: periodIdForDate(db, due), expectedAmount: s.expectedAmount,
				windowStart: addDays(due, -INCOME_WINDOW_BEFORE), windowEnd: addDays(due, opts.graceDays)
			}).run();
			incomeCreated++;
		}
	}
	return { billsCreated, incomeCreated };
}
