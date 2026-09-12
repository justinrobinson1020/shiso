import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { DbOrTx } from '../db';
import { accounts, categories, periods, transactions, transactionSplits } from '../db/schema';
import { driftReport } from '../reconcile';

export type LedgerFilter = {
	accountId?: number | null;
	periodId?: number | null;
	categoryId?: number | null;
	from?: string | null;
	to?: string | null;
	review?: boolean;
	q?: string | null;
	limit?: number;
	offset?: number;
	sort?: LedgerSortKey | null;
	dir?: 'asc' | 'desc' | null;
};
export const LEDGER_SORT_KEYS = ['date', 'account', 'payee', 'category', 'memo', 'amount', 'period'] as const;
export type LedgerSortKey = (typeof LEDGER_SORT_KEYS)[number];

export type LedgerRow = {
	id: number;
	accountId: number;
	accountName: string;
	postedDate: string;
	pending: boolean;
	payee: string;
	payeeRaw: string;
	memo: string | null;
	amount: number;
	periodId: number;
	periodLabel: string;
	source: string;
	needsReview: boolean;
	reviewReason: string | null;
	transferPeerId: number | null;
	transferPeerAccountName: string | null;
	splits: { id: number; categoryId: number; categoryName: string; amount: number; memo: string | null }[];
};

export type LedgerView = {
	rows: LedgerRow[];
	total: number;
	limit: number;
	offset: number;
	accounts: { id: number; name: string; type: string; closed: boolean }[];
	periods: { id: number; label: string }[];
	drift: { accountId: number; accountName: string; drift: number }[];
};

/** Server-side sort, because the ledger is paginated: sorting a page client-side would only order that page. Nulls last either way; id desc breaks ties. */
function orderFor(key: LedgerSortKey, dir: 'asc' | 'desc'): SQL[] {
	const d = dir === 'asc' ? asc : desc;
	const firstCategory = sql`(select c.name from ${transactionSplits} s join ${categories} c on c.id = s.category_id where s.transaction_id = ${transactions.id} order by s.id limit 1)`;
	const col: Record<LedgerSortKey, SQL | AnySQLiteColumn> = {
		date: transactions.postedDate, account: sql`lower(${accounts.name})`, payee: sql`lower(${transactions.payee})`, category: sql`lower(${firstCategory})`,
		memo: sql`lower(${transactions.memo})`, amount: transactions.amount, period: periods.startDate
	};
	const nullsLast = key === 'memo' ? [sql`(${transactions.memo} is null)`] : [];
	return [...nullsLast, d(col[key]), desc(transactions.id)];
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function ledgerView(db: DbOrTx, f: LedgerFilter): LedgerView {
	const limit = Math.min(Math.max(f.limit ?? 100, 1), 500), offset = Math.max(f.offset ?? 0, 0);
	const conds: SQL[] = [isNull(transactions.deletedAt)];
	if (f.accountId != null) conds.push(eq(transactions.accountId, f.accountId));
	if (f.periodId != null) conds.push(eq(transactions.periodId, f.periodId));
	if (f.from) conds.push(gte(transactions.postedDate, f.from));
	if (f.to) conds.push(lte(transactions.postedDate, f.to));
	if (f.review) conds.push(eq(transactions.needsReview, true));
	if (f.q?.trim()) { const p = `%${escapeLike(f.q.trim().toLowerCase())}%`; conds.push(or(sql`lower(${transactions.payee}) like ${p} escape '\\'`, sql`lower(${transactions.payeeRaw}) like ${p} escape '\\'`, sql`lower(coalesce(${transactions.memo}, '')) like ${p} escape '\\'`)!); }
	if (f.categoryId != null) conds.push(sql`exists (select 1 from ${transactionSplits} where ${transactionSplits.transactionId} = ${transactions.id} and ${transactionSplits.categoryId} = ${f.categoryId})`);
	const where = and(...conds);
	const total = db.select({ n: sql<number>`count(*)` }).from(transactions).where(where).get()?.n ?? 0;
	const peer = alias(transactions, 'peer'); const peerAcct = alias(accounts, 'peer_acct');
	const rows = db.select({ t: transactions, accountName: accounts.name, periodLabel: periods.label, peerAccountName: peerAcct.name })
		.from(transactions).innerJoin(accounts, eq(transactions.accountId, accounts.id)).innerJoin(periods, eq(transactions.periodId, periods.id))
		.leftJoin(peer, eq(transactions.transferPeerId, peer.id)).leftJoin(peerAcct, eq(peer.accountId, peerAcct.id))
		.where(where).orderBy(...orderFor(f.sort ?? 'date', f.dir ?? (f.sort ? 'asc' : 'desc'))).limit(limit).offset(offset).all();
	const ids = rows.map((r) => r.t.id);
	const splits = ids.length === 0 ? [] : db.select({ s: transactionSplits, categoryName: categories.name }).from(transactionSplits)
		.innerJoin(categories, eq(transactionSplits.categoryId, categories.id)).where(inArray(transactionSplits.transactionId, ids)).orderBy(asc(transactionSplits.id)).all();
	const acctRows = db.select().from(accounts).orderBy(asc(accounts.id)).all();
	const byId = new Map(acctRows.map((a) => [a.id, a.name]));
	return {
		rows: rows.map(({ t, accountName, periodLabel, peerAccountName }) => ({
			id: t.id, accountId: t.accountId, accountName, postedDate: t.postedDate, pending: t.pending, payee: t.payee, payeeRaw: t.payeeRaw, memo: t.memo,
			amount: t.amount, periodId: t.periodId, periodLabel, source: t.source, needsReview: t.needsReview, reviewReason: t.reviewReason,
			transferPeerId: t.transferPeerId, transferPeerAccountName: peerAccountName ?? null,
			splits: splits.filter((x) => x.s.transactionId === t.id).map((x) => ({ id: x.s.id, categoryId: x.s.categoryId, categoryName: x.categoryName, amount: x.s.amount, memo: x.s.memo }))
		})),
		total, limit, offset,
		accounts: acctRows.map((a) => ({ id: a.id, name: a.name, type: a.type, closed: a.closedAt != null })),
		periods: db.select({ id: periods.id, label: periods.label }).from(periods).orderBy(desc(periods.startDate)).all(),
		drift: driftReport(db).filter((d) => d.drift != null && d.drift !== 0).map((d) => ({ accountId: d.accountId, accountName: byId.get(d.accountId) ?? String(d.accountId), drift: d.drift! }))
	};
}
