import { alias } from 'drizzle-orm/sqlite-core';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, accountBalances, categories, periods, transactions, transactionSplits, CASH_TYPES } from '../db/schema';

export type TrendRow = {
	periodId: number; label: string; startDate: string; endDate: string;
	/** Σ owed across debt accounts at the period end, carried forward from the latest snapshot. */
	total: number;
	/** Versus the previous row; null on the first. */
	change: number | null;
	/** Ledger columns; null before the first ledger row (P2 §4.4). */
	paid: number | null; interest: number | null; income: number | null; paidShare: number | null;
};

/** P2 §4.4: one row per period from the first debt snapshot through the period containing `throughIso`. */
export function debtTrend(db: DbOrTx, opts: { throughIso: string }): TrendRow[] {
	const debts = db.select({ id: accounts.id, closedAt: accounts.closedAt }).from(accounts).where(eq(accounts.isDebt, true)).all();
	if (debts.length === 0) return [];
	const debtIds = new Set(debts.map((d) => d.id));
	const snaps = db.select({ accountId: accountBalances.accountId, asOf: accountBalances.asOf, current: accountBalances.current })
		.from(accountBalances).where(sql`${accountBalances.accountId} in ${[...debtIds]}`).orderBy(asc(accountBalances.asOf), asc(accountBalances.id)).all();
	if (snaps.length === 0) return [];
	const firstSnap = snaps[0].asOf;
	const rows = db.select().from(periods).where(lte(periods.startDate, opts.throughIso)).orderBy(asc(periods.startDate)).all().filter((p) => p.endDate >= firstSnap);

	const firstLedger = db.select({ d: sql<string | null>`min(${transactions.postedDate})` }).from(transactions).where(isNull(transactions.deletedAt)).get()?.d ?? null;
	const peer = alias(transactions, 'peer');
	const splits = db.select({
		periodId: transactions.periodId, accountId: transactions.accountId, accountType: accounts.type, amount: transactionSplits.amount,
		kind: categories.kind, categoryAccountId: categories.accountId, peerAccountId: peer.accountId
	}).from(transactionSplits)
		.innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
		.innerJoin(accounts, eq(transactions.accountId, accounts.id))
		.innerJoin(categories, eq(transactionSplits.categoryId, categories.id))
		.leftJoin(peer, and(eq(transactions.transferPeerId, peer.id), isNull(peer.deletedAt)))
		.where(isNull(transactions.deletedAt)).all();
	const offBudget = new Set(db.select({ id: accounts.id }).from(accounts).where(eq(accounts.onBudget, false)).all().map((a) => a.id));
	const cash = (t: string) => (CASH_TYPES as readonly string[]).includes(t);
	const agg = new Map<number, { paid: number; interest: number; income: number }>();
	const at = (p: number) => { let a = agg.get(p); if (!a) { a = { paid: 0, interest: 0, income: 0 }; agg.set(p, a); } return a; };
	for (const s of splits) {
		if (cash(s.accountType) && s.amount < 0 && s.peerAccountId != null && debtIds.has(s.peerAccountId)) at(s.periodId).paid -= s.amount;
		else if (cash(s.accountType) && s.kind === 'debt_payment' && s.categoryAccountId != null && offBudget.has(s.categoryAccountId)) at(s.periodId).paid -= s.amount;
		if (debtIds.has(s.accountId) && s.kind === 'interest') at(s.periodId).interest -= s.amount;
		if (cash(s.accountType) && s.kind === 'income') at(s.periodId).income += s.amount;
	}

	const latest = new Map<number, number>(); let cursor = 0; let prev: number | null = null;
	return rows.map((p) => {
		while (cursor < snaps.length && snaps[cursor].asOf <= p.endDate) { latest.set(snaps[cursor].accountId, snaps[cursor].current); cursor++; }
		let total = 0;
		for (const d of debts) if (!(d.closedAt != null && d.closedAt <= p.endDate)) total -= latest.get(d.id) ?? 0;
		const change = prev == null ? null : total - prev; prev = total;
		const hasLedger = firstLedger != null && p.endDate >= firstLedger;
		const a = agg.get(p.id) ?? { paid: 0, interest: 0, income: 0 };
		return {
			periodId: p.id, label: p.label, startDate: p.startDate, endDate: p.endDate, total, change,
			paid: hasLedger ? a.paid : null, interest: hasLedger ? a.interest : null, income: hasLedger ? a.income : null,
			paidShare: hasLedger && a.income > 0 ? a.paid / a.income : null
		};
	});
}
