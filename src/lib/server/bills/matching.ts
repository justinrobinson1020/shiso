import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, lt, gt, ne, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { DbOrTx } from '../db';
import { bills, billOccurrences, billOccurrenceTransactions, incomeSources, incomeOccurrences, transactions } from '../db/schema';
import { getTransaction, setSplits } from '../ledger/transactions';
import { addDays, nowIso, parseIso } from '$lib/dates';

const touch = () => ({ updatedAt: nowIso() });
const dayDiff = (a: string, b: string) => Math.abs((parseIso(a).getTime() - parseIso(b).getTime()) / 86_400_000);

function patternMatches(pattern: string | null, payee: string, payeeRaw: string): boolean {
	if (!pattern) return true;
	try { const re = new RegExp(pattern, 'i'); return re.test(payee) || re.test(payeeRaw); }
	catch { const p = pattern.toLowerCase(); return payee.toLowerCase().includes(p) || payeeRaw.toLowerCase().includes(p); }
}
const tolerance = (expected: number, abs: number, pct: number) => abs + Math.round((expected * pct) / 100);
/** marked_by is NULL on fresh occurrences; `ne(col, 'manual')` alone would exclude them. */
const notManual = (col: typeof billOccurrences.markedBy | typeof incomeOccurrences.markedBy) => or(isNull(col), ne(col, 'manual'));

function linkedTransactionIds(db: DbOrTx): Set<number> {
	return new Set(db.select({ id: billOccurrenceTransactions.transactionId }).from(billOccurrenceTransactions).all().map((r) => r.id));
}

function settle(db: DbOrTx, occId: number, expected: number, tolAbs: number, tolPct: number, paid: number, isDebt: boolean, markedBy: 'auto' | 'manual' | null): 'paid' | 'pending' {
	const status = paid >= expected - tolerance(expected, tolAbs, tolPct) && paid > 0 ? 'paid' : 'pending';
	db.update(billOccurrences).set({
		status, paidAmount: paid, extraAmount: isDebt ? Math.max(0, paid - expected) : 0, markedBy: paid > 0 ? markedBy : null, ...touch()
	}).where(eq(billOccurrences.id, occId)).run();
	return status;
}

/** §6.2. Occurrences are visited in due-date order so an earlier one claims a payment first. */
export function matchBillOccurrences(db: DbOrTx, todayIso: string): { matched: number; tied: number } {
	const peer = alias(transactions, 'peer');
	const used = linkedTransactionIds(db);
	let matched = 0, tied = 0;
	const open = db.select({ o: billOccurrences, b: bills }).from(billOccurrences)
		.innerJoin(bills, eq(billOccurrences.billId, bills.id))
		.where(and(
			or(
				inArray(billOccurrences.status, ['pending', 'overdue']),
				// §6.2: a debt occurrence settled by the minimum payment stays open to later transfers to the
				// card in the same window, so paid_amount and extra_amount keep accumulating. Re-scanning is
				// idempotent — `used` excludes already-linked rows and `settle` recomputes from the running total.
				and(eq(billOccurrences.status, 'paid'), isNotNull(bills.linkedDebtAccountId))
			),
			notManual(billOccurrences.markedBy)
		))
		.orderBy(asc(billOccurrences.dueDate), asc(billOccurrences.id))
		.all();
	for (const { o, b } of open) {
		const rows = db.select({ t: transactions, peerAccountId: peer.accountId }).from(transactions)
			.leftJoin(peer, eq(transactions.transferPeerId, peer.id))
			.where(and(
				eq(transactions.accountId, b.payFromAccountId), isNull(transactions.deletedAt), lt(transactions.amount, 0),
				gte(transactions.postedDate, o.windowStart), lte(transactions.postedDate, o.windowEnd)
			))
			.all()
			.filter((r) => !used.has(r.t.id));

		if (b.linkedDebtAccountId != null) {
			const hits = rows.filter((r) => r.peerAccountId === b.linkedDebtAccountId);
			if (hits.length === 0) continue;
			for (const h of hits) { db.insert(billOccurrenceTransactions).values({ billOccurrenceId: o.id, transactionId: h.t.id }).run(); used.add(h.t.id); }
			const paid = hits.reduce((s, h) => s - h.t.amount, 0) + o.paidAmount;
			if (settle(db, o.id, o.expectedAmount, b.toleranceAbs, b.tolerancePct, paid, true, 'auto') === 'paid') matched++;
			continue;
		}

		const tol = tolerance(o.expectedAmount, b.toleranceAbs, b.tolerancePct);
		const cands = rows
			.filter((r) => Math.abs(-r.t.amount - o.expectedAmount) <= tol && patternMatches(b.matchPattern, r.t.payee, r.t.payeeRaw))
			.map((r) => ({ id: r.t.id, amount: -r.t.amount, dAmt: Math.abs(-r.t.amount - o.expectedAmount), dDate: dayDiff(r.t.postedDate, o.dueDate) }))
			.sort((x, y) => x.dAmt - y.dAmt || x.dDate - y.dDate || x.id - y.id);
		if (cands.length === 0) continue;
		if (cands.length > 1 && cands[0].dAmt === cands[1].dAmt && cands[0].dDate === cands[1].dDate) {
			db.update(billOccurrences).set({ needsReview: true, ...touch() }).where(eq(billOccurrences.id, o.id)).run();
			tied++;
			continue;
		}
		const best = cands[0];
		db.insert(billOccurrenceTransactions).values({ billOccurrenceId: o.id, transactionId: best.id }).run();
		used.add(best.id);
		const t = getTransaction(db, best.id);
		if (t.splits.length === 1 && t.splits[0].categoryId !== b.categoryId) setSplits(db, best.id, [{ categoryId: b.categoryId, amount: t.amount }]);
		if (settle(db, o.id, o.expectedAmount, b.toleranceAbs, b.tolerancePct, best.amount, false, 'auto') === 'paid') matched++;
	}
	return { matched, tied };
}

export function matchIncomeOccurrences(db: DbOrTx, todayIso: string): { matched: number } {
	const used = new Set(db.select({ id: incomeOccurrences.transactionId }).from(incomeOccurrences).all().map((r) => r.id).filter((x): x is number => x != null));
	let matched = 0;
	const open = db.select({ o: incomeOccurrences, s: incomeSources }).from(incomeOccurrences)
		.innerJoin(incomeSources, eq(incomeOccurrences.incomeSourceId, incomeSources.id))
		.where(and(inArray(incomeOccurrences.status, ['pending', 'overdue']), notManual(incomeOccurrences.markedBy)))
		.orderBy(asc(incomeOccurrences.dueDate), asc(incomeOccurrences.id))
		.all();
	for (const { o, s } of open) {
		const tol = tolerance(o.expectedAmount, s.toleranceAbs, s.tolerancePct);
		const cands = db.select().from(transactions)
			.where(and(eq(transactions.accountId, s.depositAccountId), isNull(transactions.deletedAt), gt(transactions.amount, 0),
				gte(transactions.postedDate, o.windowStart), lte(transactions.postedDate, o.windowEnd)))
			.all()
			.filter((t) => !used.has(t.id) && Math.abs(t.amount - o.expectedAmount) <= tol && patternMatches(s.matchPattern, t.payee, t.payeeRaw))
			.sort((x, y) => Math.abs(x.amount - o.expectedAmount) - Math.abs(y.amount - o.expectedAmount) || dayDiff(x.postedDate, o.dueDate) - dayDiff(y.postedDate, o.dueDate) || x.id - y.id);
		if (cands.length === 0) continue;
		const best = cands[0];
		used.add(best.id);
		const full = getTransaction(db, best.id);
		if (full.splits.length === 1 && full.splits[0].categoryId !== s.categoryId) setSplits(db, best.id, [{ categoryId: s.categoryId, amount: full.amount }]);
		db.update(incomeOccurrences).set({ status: 'paid', receivedAmount: best.amount, transactionId: best.id, markedBy: 'auto', ...touch() })
			.where(eq(incomeOccurrences.id, o.id)).run();
		matched++;
	}
	return { matched };
}

export function markOverdue(db: DbOrTx, todayIso: string, graceDays: number): number {
	const cutoff = addDays(todayIso, -graceDays);
	const r1 = db.update(billOccurrences).set({ status: 'overdue', ...touch() })
		.where(and(eq(billOccurrences.status, 'pending'), notManual(billOccurrences.markedBy), lt(billOccurrences.dueDate, cutoff))).run();
	const r2 = db.update(incomeOccurrences).set({ status: 'overdue', ...touch() })
		.where(and(eq(incomeOccurrences.status, 'pending'), notManual(incomeOccurrences.markedBy), lt(incomeOccurrences.dueDate, cutoff))).run();
	return r1.changes + r2.changes;
}

export function markOccurrencePaid(db: DbOrTx, occurrenceId: number, opts: { transactionId?: number | null; amount?: number | null } = {}): void {
	const o = db.select().from(billOccurrences).where(eq(billOccurrences.id, occurrenceId)).get();
	if (!o) throw new Error(`occurrence ${occurrenceId} not found`);
	db.transaction((tx) => {
		let paid = opts.amount ?? o.expectedAmount;
		if (opts.transactionId != null) {
			tx.insert(billOccurrenceTransactions).values({ billOccurrenceId: occurrenceId, transactionId: opts.transactionId }).onConflictDoNothing().run();
			if (opts.amount == null) paid = -getTransaction(tx, opts.transactionId).amount;
		}
		const b = tx.select().from(bills).where(eq(bills.id, o.billId)).get()!;
		tx.update(billOccurrences).set({
			status: 'paid', paidAmount: paid, extraAmount: b.linkedDebtAccountId != null ? Math.max(0, paid - o.expectedAmount) : 0,
			markedBy: 'manual', needsReview: false, ...touch()
		}).where(eq(billOccurrences.id, occurrenceId)).run();
	});
}

export function unmarkOccurrence(db: DbOrTx, occurrenceId: number): void {
	db.transaction((tx) => {
		tx.delete(billOccurrenceTransactions).where(eq(billOccurrenceTransactions.billOccurrenceId, occurrenceId)).run();
		tx.update(billOccurrences).set({ status: 'pending', paidAmount: 0, extraAmount: 0, markedBy: 'manual', needsReview: false, ...touch() })
			.where(eq(billOccurrences.id, occurrenceId)).run();
	});
}

export function skipOccurrence(db: DbOrTx, occurrenceId: number): void {
	db.update(billOccurrences).set({ status: 'skipped', markedBy: 'manual', needsReview: false, ...touch() }).where(eq(billOccurrences.id, occurrenceId)).run();
}

export function markIncomeReceived(db: DbOrTx, occurrenceId: number, opts: { transactionId?: number | null; amount?: number | null } = {}): void {
	const o = db.select().from(incomeOccurrences).where(eq(incomeOccurrences.id, occurrenceId)).get();
	if (!o) throw new Error(`income occurrence ${occurrenceId} not found`);
	const received = opts.amount ?? (opts.transactionId != null ? getTransaction(db, opts.transactionId).amount : o.expectedAmount);
	db.update(incomeOccurrences).set({ status: 'paid', receivedAmount: received, transactionId: opts.transactionId ?? null, markedBy: 'manual', ...touch() }).where(eq(incomeOccurrences.id, occurrenceId)).run();
}

export function unmarkIncome(db: DbOrTx, occurrenceId: number): void {
	db.update(incomeOccurrences).set({ status: 'pending', receivedAmount: 0, transactionId: null, markedBy: 'manual', ...touch() }).where(eq(incomeOccurrences.id, occurrenceId)).run();
}

export function skipIncome(db: DbOrTx, occurrenceId: number): void {
	db.update(incomeOccurrences).set({ status: 'skipped', markedBy: 'manual', ...touch() }).where(eq(incomeOccurrences.id, occurrenceId)).run();
}

/** §5.7: a removed transaction releases auto-matched occurrences; manual marks stay. */
export function unwindRemovedTransactions(db: DbOrTx, transactionIds: number[]): { reopened: number } {
	if (transactionIds.length === 0) return { reopened: 0 };
	let reopened = 0;
	db.transaction((tx) => {
		const links = tx.select().from(billOccurrenceTransactions).where(inArray(billOccurrenceTransactions.transactionId, transactionIds)).all();
		for (const link of links) {
			const o = tx.select().from(billOccurrences).where(eq(billOccurrences.id, link.billOccurrenceId)).get()!;
			if (o.markedBy === 'manual') continue;
			tx.delete(billOccurrenceTransactions)
				.where(and(eq(billOccurrenceTransactions.billOccurrenceId, o.id), eq(billOccurrenceTransactions.transactionId, link.transactionId))).run();
			const remaining = tx.select({ id: billOccurrenceTransactions.transactionId }).from(billOccurrenceTransactions).where(eq(billOccurrenceTransactions.billOccurrenceId, o.id)).all();
			const paid = remaining.reduce((s, r) => s - getTransaction(tx, r.id).amount, 0);
			const b = tx.select().from(bills).where(eq(bills.id, o.billId)).get()!;
			if (settle(tx, o.id, o.expectedAmount, b.toleranceAbs, b.tolerancePct, paid, b.linkedDebtAccountId != null, 'auto') === 'pending') reopened++;
		}
		const inc = tx.select().from(incomeOccurrences).where(and(inArray(incomeOccurrences.transactionId, transactionIds), notManual(incomeOccurrences.markedBy))).all();
		for (const o of inc) {
			tx.update(incomeOccurrences).set({ status: 'pending', receivedAmount: 0, transactionId: null, markedBy: null, ...touch() }).where(eq(incomeOccurrences.id, o.id)).run();
			reopened++;
		}
	});
	return { reopened };
}

export function matchAll(db: DbOrTx, opts: { todayIso: string; graceDays: number }) {
	const overdue = markOverdue(db, opts.todayIso, opts.graceDays);
	const billsResult = matchBillOccurrences(db, opts.todayIso);
	const income = matchIncomeOccurrences(db, opts.todayIso);
	return { overdue, bills: billsResult, income };
}
