import { asc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, billOccurrences, billOccurrenceTransactions, bills, categories, incomeOccurrences, incomeSources, periods, BILL_CADENCES } from '../db/schema';
import { compareIso } from '$lib/dates';

export type Occ = {
	id: number; dueDate: string; periodLabel: string; expected: number; paid: number; extra: number; status: string;
	markedBy: string | null; needsReview: boolean; transactionIds: number[];
};
export type BillsView = {
	bills: {
		id: number; name: string; categoryId: number; categoryName: string; payFromAccountId: number; payFromAccountName: string;
		expectedAmount: number; toleranceAbs: number; tolerancePct: number;
		cadence: string; dueDay: number | null; dueDay2: number | null; interval: number | null; anchorDate: string | null;
		autopay: boolean; variable: boolean; matchPattern: string | null; linkedDebtAccountId: number | null; active: boolean;
		next: Occ | null; history: Occ[];
	}[];
	income: {
		id: number; name: string; categoryId: number; depositAccountId: number; depositAccountName: string; expectedAmount: number;
		toleranceAbs: number; tolerancePct: number; cadence: string; dueDay: number | null; dueDay2: number | null; interval: number | null; settleBusinessDays: number | null;
		anchorDate: string | null; matchPattern: string | null; active: boolean;
		next: Occ | null; history: Occ[];
	}[];
	accounts: { id: number; name: string; type: string; isDebt: boolean }[];
	cadences: readonly string[];
};

export function billsView(db: DbOrTx, opts: { todayIso: string }): BillsView {
	const periodLabel = new Map(db.select({ id: periods.id, label: periods.label }).from(periods).all().map((p) => [p.id, p.label]));
	const accts = db.select().from(accounts).orderBy(asc(accounts.id)).all();
	const acctName = new Map(accts.map((a) => [a.id, a.name]));
	const catName = new Map(db.select({ id: categories.id, name: categories.name }).from(categories).all().map((c) => [c.id, c.name]));
	const links = db.select().from(billOccurrenceTransactions).all();
	const split = (occs: Occ[]) => {
		const sorted = [...occs].sort((a, b) => compareIso(a.dueDate, b.dueDate));
		const next = sorted.find((o) => o.status !== 'skipped' && compareIso(o.dueDate, opts.todayIso) >= 0) ?? null;
		return { next, history: sorted.reverse().slice(0, 12) };
	};
	const billRows = db.select().from(bills).orderBy(asc(bills.name)).all();
	const billOccs = db.select().from(billOccurrences)
		.where(billRows.length ? inArray(billOccurrences.billId, billRows.map((b) => b.id)) : eq(billOccurrences.id, -1))
		.all();
	const incRows = db.select().from(incomeSources).orderBy(asc(incomeSources.name)).all();
	const incOccs = db.select().from(incomeOccurrences)
		.where(incRows.length ? inArray(incomeOccurrences.incomeSourceId, incRows.map((i) => i.id)) : eq(incomeOccurrences.id, -1))
		.all();
	return {
		bills: billRows.map((b) => ({
			id: b.id, name: b.name, categoryId: b.categoryId, categoryName: catName.get(b.categoryId) ?? '',
			payFromAccountId: b.payFromAccountId, payFromAccountName: acctName.get(b.payFromAccountId) ?? '',
			expectedAmount: b.expectedAmount, toleranceAbs: b.toleranceAbs, tolerancePct: b.tolerancePct,
			cadence: b.cadence, dueDay: b.dueDay, dueDay2: b.dueDay2, interval: b.interval, anchorDate: b.anchorDate,
			autopay: b.autopay, variable: b.variable, matchPattern: b.matchPattern, linkedDebtAccountId: b.linkedDebtAccountId, active: b.active,
			...split(billOccs.filter((o) => o.billId === b.id).map((o) => ({
				id: o.id, dueDate: o.dueDate, periodLabel: periodLabel.get(o.periodId) ?? '', expected: o.expectedAmount,
				paid: o.paidAmount, extra: o.extraAmount, status: o.status, markedBy: o.markedBy, needsReview: o.needsReview,
				transactionIds: links.filter((l) => l.billOccurrenceId === o.id).map((l) => l.transactionId)
			})))
		})),
		income: incRows.map((s) => ({
			id: s.id, name: s.name, categoryId: s.categoryId, depositAccountId: s.depositAccountId, depositAccountName: acctName.get(s.depositAccountId) ?? '',
			expectedAmount: s.expectedAmount, toleranceAbs: s.toleranceAbs, tolerancePct: s.tolerancePct,
			cadence: s.cadence, dueDay: s.dueDay, dueDay2: s.dueDay2, interval: s.interval, anchorDate: s.anchorDate, settleBusinessDays: s.settleBusinessDays,
			matchPattern: s.matchPattern, active: s.active,
			...split(incOccs.filter((o) => o.incomeSourceId === s.id).map((o) => ({
				id: o.id, dueDate: o.dueDate, periodLabel: periodLabel.get(o.periodId) ?? '', expected: o.expectedAmount,
				paid: o.receivedAmount, extra: 0, status: o.status, markedBy: o.markedBy, needsReview: false,
				transactionIds: o.transactionId != null ? [o.transactionId] : []
			})))
		})),
		accounts: accts.map((a) => ({ id: a.id, name: a.name, type: a.type, isDebt: a.isDebt })),
		cadences: BILL_CADENCES
	};
}
