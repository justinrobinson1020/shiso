import { and, asc, eq, gte, isNull, lte, notInArray, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, categories, categoryGroups, transactions, transactionSplits, type CategoryKind } from '../db/schema';
import { periodBoundsFor, nextPeriodStart, type Cadence } from '../budget/periods';
import { addDays, endOfMonth, startOfMonth, compareIso } from '$lib/dates';

export type RangeKind = 'period' | 'month' | 'quarter' | 'year' | 'custom';
export type Range = { kind: RangeKind; start: string; end: string; label: string; prevStart: string; prevEnd: string; prevLabel: string };

export const EXCLUDED_KINDS: readonly CategoryKind[] = ['bill', 'debt_payment', 'transfer', 'income', 'reconciliation'];

export type SpendingFilter = { accountId?: number | null; groupId?: number | null; merchant?: string | null; includeExcluded?: boolean; compare?: boolean };

export type SpendingView = {
	range: Range;
	filter: SpendingFilter;
	total: number;
	prevTotal: number | null;
	byCategory: { categoryId: number; name: string; groupName: string; amount: number; share: number; prevAmount: number | null }[]; // amount desc
	byMerchant: { payee: string; count: number; total: number; prevTotal: number | null }[]; // top 25 by total desc
	overTime: {
		buckets: { key: string; label: string; start: string; end: string; total: number; prevTotal: number | null; byCategory: Record<string, number> }[];
		categories: { id: number; name: string }[];
	};
	accounts: { id: number; name: string }[];
	groups: { id: number; name: string }[];
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** First of the month `n` months from `iso`'s month (may be negative). */
function addMonths(iso: string, n: number): string {
	const y = +iso.slice(0, 4);
	const m = +iso.slice(5, 7);
	const d = new Date(Date.UTC(y, m - 1 + n, 1));
	return d.toISOString().slice(0, 10);
}

export function resolveRange(db: DbOrTx, q: { kind: RangeKind; anchor: string; end?: string | null; cadence: Cadence }): Range {
	const y = +q.anchor.slice(0, 4);
	const m = +q.anchor.slice(5, 7);
	const monthLabel = (iso: string) => `${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
	switch (q.kind) {
		case 'period': {
			const cur = periodBoundsFor(q.cadence, q.anchor);
			const prev = periodBoundsFor(q.cadence, addDays(cur.startDate, -1));
			return { kind: 'period', start: cur.startDate, end: cur.endDate, label: cur.label, prevStart: prev.startDate, prevEnd: prev.endDate, prevLabel: prev.label };
		}
		case 'month': {
			const start = startOfMonth(q.anchor);
			const prevStart = startOfMonth(addDays(start, -1));
			return { kind: 'month', start, end: endOfMonth(start), label: monthLabel(start), prevStart, prevEnd: endOfMonth(prevStart), prevLabel: monthLabel(prevStart) };
		}
		case 'quarter': {
			const qn = Math.floor((m - 1) / 3);
			const start = `${y}-${String(qn * 3 + 1).padStart(2, '0')}-01`;
			const end = endOfMonth(`${y}-${String(qn * 3 + 3).padStart(2, '0')}-01`);
			const prevStart = addMonths(start, -3);
			const prevEnd = endOfMonth(addMonths(start, -1));
			const py = +prevStart.slice(0, 4);
			const prevQ = Math.floor((+prevStart.slice(5, 7) - 1) / 3);
			return { kind: 'quarter', start, end, label: `Q${qn + 1} ${y}`, prevStart, prevEnd, prevLabel: `Q${prevQ + 1} ${py}` };
		}
		case 'year':
			return { kind: 'year', start: `${y}-01-01`, end: `${y}-12-31`, label: String(y), prevStart: `${y - 1}-01-01`, prevEnd: `${y - 1}-12-31`, prevLabel: String(y - 1) };
		case 'custom': {
			const end = q.end && compareIso(q.end, q.anchor) >= 0 ? q.end : q.anchor;
			const len = daysBetween(q.anchor, end) + 1;
			const prevEnd = addDays(q.anchor, -1);
			const prevStart = addDays(prevEnd, -(len - 1));
			return { kind: 'custom', start: q.anchor, end, label: `${q.anchor} – ${end}`, prevStart, prevEnd, prevLabel: `${prevStart} – ${prevEnd}` };
		}
	}
}

type SplitRow = { accountId: number; postedDate: string; payee: string; categoryId: number; categoryName: string; groupId: number; groupName: string; amount: number };

function splitRows(db: DbOrTx, start: string, end: string, f: SpendingFilter): SplitRow[] {
	const conds: SQL[] = [isNull(transactions.deletedAt), isNull(transactions.transferPeerId), gte(transactions.postedDate, start), lte(transactions.postedDate, end)];
	if (!f.includeExcluded) conds.push(notInArray(categories.kind, [...EXCLUDED_KINDS]));
	if (f.accountId != null) conds.push(eq(transactions.accountId, f.accountId));
	if (f.groupId != null) conds.push(eq(categories.groupId, f.groupId));
	if (f.merchant) conds.push(eq(transactions.payee, f.merchant));
	return db
		.select({
			accountId: transactions.accountId,
			postedDate: transactions.postedDate,
			payee: transactions.payee,
			categoryId: categories.id,
			categoryName: categories.name,
			groupId: categoryGroups.id,
			groupName: categoryGroups.name,
			amount: transactionSplits.amount
		})
		.from(transactionSplits)
		.innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
		.innerJoin(categories, eq(transactionSplits.categoryId, categories.id))
		.innerJoin(categoryGroups, eq(categories.groupId, categoryGroups.id))
		.where(and(...conds))
		.all();
}

function buckets(range: { start: string; end: string }, cadence: Cadence): { key: string; label: string; start: string; end: string }[] {
	const out: { key: string; label: string; start: string; end: string }[] = [];
	if (daysBetween(range.start, range.end) <= 92) {
		let cur = periodBoundsFor(cadence, range.start);
		while (compareIso(cur.startDate, range.end) <= 0) {
			out.push({ key: cur.startDate, label: cur.label, start: cur.startDate, end: cur.endDate });
			cur = periodBoundsFor(cadence, nextPeriodStart(cadence, cur.endDate));
		}
	} else {
		let cur = startOfMonth(range.start);
		while (compareIso(cur, range.end) <= 0) {
			out.push({ key: cur.slice(0, 7), label: `${MONTHS[+cur.slice(5, 7) - 1].slice(0, 3)} ${cur.slice(0, 4)}`, start: cur, end: endOfMonth(cur) });
			cur = addDays(endOfMonth(cur), 1);
		}
	}
	return out;
}

export function spendingView(db: DbOrTx, q: { range: Range; filter: SpendingFilter; cadence: Cadence }): SpendingView {
	const cur = splitRows(db, q.range.start, q.range.end, q.filter);
	const prev = q.filter.compare ? splitRows(db, q.range.prevStart, q.range.prevEnd, q.filter) : null;

	const sumBy = <K>(rows: SplitRow[], key: (r: SplitRow) => K) => {
		const m = new Map<K, number>();
		for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) - r.amount);
		return m;
	};

	const total = cur.reduce((s, r) => s - r.amount, 0);
	const prevTotal = prev ? prev.reduce((s, r) => s - r.amount, 0) : null;

	const byCat = sumBy(cur, (r) => r.categoryId);
	const prevByCat = prev ? sumBy(prev, (r) => r.categoryId) : null;
	const catMeta = new Map(cur.map((r) => [r.categoryId, { name: r.categoryName, groupName: r.groupName }]));
	const byCategory = [...byCat]
		.map(([id, amount]) => ({
			categoryId: id,
			name: catMeta.get(id)!.name,
			groupName: catMeta.get(id)!.groupName,
			amount,
			share: total ? Math.round((amount / total) * 10000) / 10000 : 0,
			prevAmount: prevByCat ? (prevByCat.get(id) ?? 0) : null
		}))
		.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));

	const merch = new Map<string, { count: number; total: number }>();
	for (const r of cur) {
		const m = merch.get(r.payee) ?? { count: 0, total: 0 };
		m.count++;
		m.total -= r.amount;
		merch.set(r.payee, m);
	}
	const prevMerch = prev ? sumBy(prev, (r) => r.payee) : null;
	const byMerchant = [...merch]
		.map(([payee, m]) => ({ payee, ...m, prevTotal: prevMerch ? (prevMerch.get(payee) ?? 0) : null }))
		.sort((a, b) => b.total - a.total || a.payee.localeCompare(b.payee))
		.slice(0, 25);

	const top = byCategory.slice(0, 8).map((c) => c.categoryId);
	const topSet = new Set(top);

	const bs = buckets(q.range, q.cadence);
	const pbs = prev ? buckets({ start: q.range.prevStart, end: q.range.prevEnd }, q.cadence) : [];
	const inB = (b: { start: string; end: string }, d: string) => compareIso(d, b.start) >= 0 && compareIso(d, b.end) <= 0;

	const overTime = bs.map((b, i) => {
		const rows = cur.filter((r) => inB(b, r.postedDate));
		const byC: Record<string, number> = {};
		for (const r of rows) {
			const k = topSet.has(r.categoryId) ? String(r.categoryId) : 'other';
			byC[k] = (byC[k] ?? 0) - r.amount;
		}
		const pb = pbs[i];
		const prevT = prev && pb ? prev.filter((r) => inB(pb, r.postedDate)).reduce((s, r) => s - r.amount, 0) : null;
		return { ...b, total: rows.reduce((s, r) => s - r.amount, 0), prevTotal: prevT, byCategory: byC };
	});
	const otherUsed = overTime.some((b) => 'other' in b.byCategory);

	return {
		range: q.range,
		filter: q.filter,
		total,
		prevTotal,
		byCategory,
		byMerchant,
		overTime: {
			buckets: overTime,
			categories: [...top.map((id) => ({ id, name: catMeta.get(id)!.name })), ...(otherUsed ? [{ id: 0, name: 'Other' }] : [])]
		},
		accounts: db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(isNull(accounts.closedAt)).orderBy(asc(accounts.name)).all(),
		groups: db.select({ id: categoryGroups.id, name: categoryGroups.name }).from(categoryGroups).orderBy(asc(categoryGroups.sort)).all()
	};
}
