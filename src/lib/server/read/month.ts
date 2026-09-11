import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, accountBalances, billOccurrences, bills, incomeOccurrences, incomeSources, CASH_TYPES } from '../db/schema';
import { latestBalance } from '../sync/connections';
import type { Cadence } from '../budget/periods';
import { addDays, endOfMonth } from '$lib/dates';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const shiftMonth = (month: string, by: number) => { const y = +month.slice(0, 4), m = +month.slice(5, 7) - 1 + by; const d = new Date(Date.UTC(y, m, 1)); return d.toISOString().slice(0, 7); };
const OPEN = ['pending', 'overdue'] as const;

export type BillRow = { id: number; name: string; dueDate: string; expected: number; paid: number; extra: number; status: string };

export type MonthView = {
	month: string; label: string; prev: string; next: string; today: string;
	cash: { accounts: { id: number; name: string; type: string; current: number; asOf: string | null }[]; total: number };
	income: { expected: number; received: number; remaining: number; occurrences: { id: number; name: string; dueDate: string; expected: number; received: number; status: string }[] };
	/** Bills paid from cash that are not card or loan payments. */
	bills: { paid: number; pending: number; occurrences: BillRow[] };
	/** Bills linked to a debt account: the sheet's Credit Cards block. `minimum` is Σ expected; `pending` is Σ expected for open occurrences. */
	cards: { minimum: number; extra: number; paid: number; pending: number; occurrences: BillRow[] };
	/** Bills pending plus cards pending: the sheet's Expenses line. */
	expensesPending: number;
	cashLeft: number;
	trend: { asOf: string; current: number }[];
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

	const bl = db.select({ o: billOccurrences, b: bills }).from(billOccurrences).innerJoin(bills, eq(billOccurrences.billId, bills.id))
		.where(and(gte(billOccurrences.dueDate, start), lte(billOccurrences.dueDate, end))).orderBy(asc(billOccurrences.dueDate)).all();
	const rows = bl.map(({ o, b }) => ({ row: { id: o.id, name: b.name, dueDate: o.dueDate, expected: o.expectedAmount, paid: o.paidAmount, extra: o.extraAmount, status: o.status }, isDebt: b.linkedDebtAccountId != null }));
	const open = (s: string) => (OPEN as readonly string[]).includes(s);
	const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
	const billOcc = rows.filter((r) => !r.isDebt).map((r) => r.row);
	const cardOcc = rows.filter((r) => r.isDebt).map((r) => r.row);

	const checkingIds = cashRows.filter((a) => a.type === 'checking').map((a) => a.id);
	const trendRows = checkingIds.length === 0 ? [] : db.select({ asOf: accountBalances.asOf, total: sql<number>`sum(${accountBalances.current})` })
		.from(accountBalances).where(and(inArray(accountBalances.accountId, checkingIds), gte(accountBalances.asOf, addDays(opts.todayIso, -90)), lte(accountBalances.asOf, opts.todayIso)))
		.groupBy(accountBalances.asOf).orderBy(asc(accountBalances.asOf)).all();

	const cashTotal = sum(cashAccounts, (a) => a.current);
	const incomeRemaining = sum(live.filter((o) => open(o.status)), (o) => o.expected);
	const billsPending = sum(billOcc.filter((o) => open(o.status)), (o) => o.expected);
	const cardsPending = sum(cardOcc.filter((o) => open(o.status)), (o) => o.expected);
	return {
		month: opts.month, label: `${MONTHS[+opts.month.slice(5, 7) - 1]} ${opts.month.slice(0, 4)}`, prev: shiftMonth(opts.month, -1), next: shiftMonth(opts.month, 1), today: opts.todayIso,
		cash: { accounts: cashAccounts, total: cashTotal },
		income: { expected: sum(live, (o) => o.expected), received: sum(live, (o) => o.received), remaining: incomeRemaining, occurrences: incomeOcc },
		bills: { paid: sum(billOcc, (o) => o.paid), pending: billsPending, occurrences: billOcc },
		cards: { minimum: sum(cardOcc, (o) => o.expected), extra: sum(cardOcc, (o) => o.extra), paid: sum(cardOcc, (o) => o.paid), pending: cardsPending, occurrences: cardOcc },
		expensesPending: billsPending + cardsPending,
		cashLeft: cashTotal + incomeRemaining - billsPending - cardsPending,
		trend: trendRows.map((r) => ({ asOf: r.asOf, current: r.total }))
	};
}
