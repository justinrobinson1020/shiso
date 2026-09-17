import { and, asc, eq, gt, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, accountBalances, billOccurrences, bills, categories, incomeOccurrences, incomeSources, CASH_TYPES } from '../db/schema';
import { latestBalance } from '../sync/connections';
import type { Cadence } from '../budget/periods';
import { addDays, endOfMonth } from '$lib/dates';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const shiftMonth = (month: string, by: number) => { const y = +month.slice(0, 4), m = +month.slice(5, 7) - 1 + by; const d = new Date(Date.UTC(y, m, 1)); return d.toISOString().slice(0, 7); };
const OPEN = ['pending', 'overdue'] as const;

/** `dueNow`: open and due on or before the next paycheck that has not arrived, so it comes out of cash on hand. */
export type BillRow = { id: number; name: string; dueDate: string; expected: number; paid: number; extra: number; status: string; markedBy: string | null; dueNow: boolean; variable: boolean };

export type MonthView = {
	month: string; label: string; prev: string; prevLabel: string; next: string; nextLabel: string; today: string;
	cash: { accounts: { id: number; name: string; type: string; current: number; asOf: string | null }[]; total: number };
	income: { expected: number; received: number; remaining: number; occurrences: { id: number; name: string; dueDate: string; expected: number; received: number; status: string }[] };
	/** Bills paid from cash that are not card or loan payments. */
	bills: { paid: number; pending: number; occurrences: BillRow[] };
	/** Bills whose category is the Subscriptions envelope, shown apart from household bills. */
	subscriptions: { paid: number; pending: number; occurrences: BillRow[] };
	/** Bills linked to a debt account: the sheet's Credit Cards block. `minimum` is Σ expected; `pending` is Σ expected for open occurrences. */
	cards: { minimum: number; extra: number; paid: number; pending: number; occurrences: BillRow[] };
	/** Bills pending plus cards pending: the sheet's Expenses line. */
	expensesPending: number;
	cashLeft: number;
	trend: { asOf: string; current: number }[];
	/** Due date of the next open paycheck on or after today; null when none is scheduled. */
	nextPaycheck: string | null;
};

export function monthView(db: DbOrTx, opts: { month: string; todayIso: string; cadence: Cadence }): MonthView {
	const start = `${opts.month}-01`, end = endOfMonth(start);
	const cashRows = db.select().from(accounts)
		.where(and(inArray(accounts.type, [...CASH_TYPES]), eq(accounts.onBudget, true), isNull(accounts.closedAt))).orderBy(asc(accounts.id)).all();
	const cashAccounts = cashRows.map((a) => { const b = latestBalance(db, a.id); return { id: a.id, name: a.name, type: a.type, current: b?.current ?? 0, asOf: b?.asOf ?? null }; });

	const inc = db.select({ o: incomeOccurrences, name: incomeSources.name }).from(incomeOccurrences)
		.innerJoin(incomeSources, eq(incomeOccurrences.incomeSourceId, incomeSources.id))
		.where(and(gte(incomeOccurrences.dueDate, start), lte(incomeOccurrences.dueDate, end))).orderBy(asc(incomeOccurrences.dueDate)).all();
	const incomeOcc = inc.map(({ o, name }) => ({ id: o.id, name, dueDate: o.dueDate, expected: o.expectedAmount, received: o.receivedAmount, status: o.status }));
	const live = incomeOcc.filter((o) => o.status !== 'skipped');

	const bl = db.select({ o: billOccurrences, b: bills, categoryName: categories.name, categoryKind: categories.kind }).from(billOccurrences)
		.innerJoin(bills, eq(billOccurrences.billId, bills.id)).innerJoin(categories, eq(bills.categoryId, categories.id))
		.where(and(gte(billOccurrences.dueDate, start), lte(billOccurrences.dueDate, end))).orderBy(asc(billOccurrences.dueDate)).all();
	const open = (s: string) => (OPEN as readonly string[]).includes(s);
	// A balance already reflects every deposit through its as-of date, and the transactions feed can lag a
	// live balance by a day. A paycheck due on or before that date is in the balance or late — never still to
	// come — so it is neither "expected" income nor the boundary for what must be paid from cash on hand.
	const cashAsOf = cashAccounts.reduce<string | null>((m, a) => (a.asOf && (!m || a.asOf > m) ? a.asOf : m), null);
	const arrivedThrough = cashAsOf ?? addDays(opts.todayIso, -1);
	const nextPaycheck = db.select({ d: incomeOccurrences.dueDate }).from(incomeOccurrences)
		.where(and(inArray(incomeOccurrences.status, [...OPEN]), gt(incomeOccurrences.dueDate, arrivedThrough))).orderBy(asc(incomeOccurrences.dueDate)).get()?.d ?? null;
	const dueNow = (status: string, due: string) => open(status) && (nextPaycheck == null || due <= nextPaycheck);
	// Section by what the bill pays: a linked debt account or a debt-payment category is a card; a card or
	// financing plan shiso cannot read (Synchrony, Apple Card, "Other Debt Payments") is one by its category name.
	const section = (b: { linkedDebtAccountId: number | null }, categoryName: string, categoryKind: string) =>
		b.linkedDebtAccountId != null || categoryKind === 'debt_payment' || /card|debt/i.test(categoryName) ? 'card' : /subscription/i.test(categoryName) ? 'subscription' : 'bill';
	const rows = bl.map(({ o, b, categoryName, categoryKind }) => ({
		row: { id: o.id, name: b.name, dueDate: o.dueDate, expected: o.expectedAmount, paid: o.paidAmount, extra: o.extraAmount, status: o.status, markedBy: o.markedBy, dueNow: dueNow(o.status, o.dueDate), variable: b.variable },
		kind: section(b, categoryName, categoryKind)
	}));
	const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
	const billOcc = rows.filter((r) => r.kind === 'bill').map((r) => r.row);
	const subOcc = rows.filter((r) => r.kind === 'subscription').map((r) => r.row);
	const cardOcc = rows.filter((r) => r.kind === 'card').map((r) => r.row);

	const checkingIds = cashRows.filter((a) => a.type === 'checking').map((a) => a.id);
	// Balance rows are append-only and a day can hold several per account (a sync plus a manual entry, or two
	// refreshes). The trend point for a day is the latest snapshot of each account, summed — never every snapshot.
	const inWindow = and(inArray(accountBalances.accountId, checkingIds), gte(accountBalances.asOf, addDays(opts.todayIso, -90)), lte(accountBalances.asOf, opts.todayIso));
	const latestPerAccountDay = db.select({ id: sql<number>`max(${accountBalances.id})` }).from(accountBalances).where(inWindow).groupBy(accountBalances.accountId, accountBalances.asOf);
	const trendRows = checkingIds.length === 0 ? [] : db.select({ asOf: accountBalances.asOf, total: sql<number>`sum(${accountBalances.current})` })
		.from(accountBalances).where(inArray(accountBalances.id, latestPerAccountDay))
		.groupBy(accountBalances.asOf).orderBy(asc(accountBalances.asOf)).all();

	const cashTotal = sum(cashAccounts, (a) => a.current);
	const incomeRemaining = sum(live.filter((o) => open(o.status) && o.dueDate > arrivedThrough), (o) => o.expected);
	const billsPending = sum(billOcc.filter((o) => open(o.status)), (o) => o.expected);
	const subsPending = sum(subOcc.filter((o) => open(o.status)), (o) => o.expected);
	const cardsPending = sum(cardOcc.filter((o) => open(o.status)), (o) => o.expected);
	return {
		month: opts.month, label: `${MONTHS[+opts.month.slice(5, 7) - 1]} ${opts.month.slice(0, 4)}`, today: opts.todayIso,
		prev: shiftMonth(opts.month, -1), prevLabel: MONTHS[+shiftMonth(opts.month, -1).slice(5, 7) - 1], next: shiftMonth(opts.month, 1), nextLabel: MONTHS[+shiftMonth(opts.month, 1).slice(5, 7) - 1],
		cash: { accounts: cashAccounts, total: cashTotal },
		income: { expected: sum(live, (o) => o.expected), received: sum(live, (o) => o.received), remaining: incomeRemaining, occurrences: incomeOcc },
		bills: { paid: sum(billOcc, (o) => o.paid), pending: billsPending, occurrences: billOcc },
		subscriptions: { paid: sum(subOcc, (o) => o.paid), pending: subsPending, occurrences: subOcc },
		cards: { minimum: sum(cardOcc, (o) => o.expected), extra: sum(cardOcc, (o) => o.extra), paid: sum(cardOcc, (o) => o.paid), pending: cardsPending, occurrences: cardOcc },
		expensesPending: billsPending + subsPending + cardsPending,
		cashLeft: cashTotal + incomeRemaining - billsPending - subsPending - cardsPending,
		trend: trendRows.map((r) => ({ asOf: r.asOf, current: r.total })),
		nextPaycheck
	};
}
