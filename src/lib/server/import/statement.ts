import { and, eq, isNull } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db';
import { accounts, accountBalances, transactions, transactionSplits } from '../db/schema';
import { ensurePeriods, periodBoundsFor, nextPeriodStart, periodIdForDate, type Cadence } from '../budget/periods';
import { createTransaction } from '../ledger/transactions';
import { systemCategoryId } from '../ledger/categories';
import { InvariantError } from '../ledger/errors';
import { appendBalance } from '../sync/connections';
import { contentHash, normalizeDescription } from '../sync/hash';
import { ImportError, type ImportFormat, type ParsedFile, type ParsedRow, type ParsedStatement } from './formats/types';
import { addDays, compareIso, nowIso, parseIso } from '$lib/dates';

export type ImportReport = {
	format: ImportFormat; mask: string | null; statement: ParsedStatement | null;
	created: number; duplicates: number; matched: number; balances: number;
	opening: { from: number; to: number; date: string } | { seeded: number; date: string } | null;
	processed: number; dryRun: boolean;
};
const MATCH_WINDOW_DAYS = 3;
class DryRunRollback extends Error { constructor(public readonly report: ImportReport) { super('dry run'); } }

export function reconcileStatement(parsed: ParsedFile): void {
	if (!parsed.statement) return;
	const sum = parsed.rows.reduce((s, r) => s + r.amount, 0);
	const expected = parsed.statement.previousBalance + sum;
	if (expected !== parsed.statement.newBalance)
		throw new ImportError('reconcile', `does not reconcile: previous ${parsed.statement.previousBalance} + rows ${sum} ≠ new ${parsed.statement.newBalance} (off by ${Math.abs(parsed.statement.newBalance - expected)})`);
}

const dayOf = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);
const daysBetween = (a: string, b: string) => Math.abs(parseIso(a).getTime() - parseIso(b).getTime()) / 86_400_000;
type Candidate = { id: number; amount: number; postedDate: string; transactedAt: string | null };
/** Closest live row with the same amount whose dates come within the window of the row's dates; null when none. */
function closestMatch(cands: Candidate[], r: ParsedRow, claimed: Set<number>): Candidate | null {
	const mine = [r.postedDate, dayOf(r.transactedAt)].filter((d): d is string => d != null);
	let best: { c: Candidate; d: number } | null = null;
	for (const c of cands) {
		if (claimed.has(c.id)) continue;
		const theirs = [c.postedDate, dayOf(c.transactedAt)].filter((d): d is string => d != null);
		let d = Infinity; for (const a of mine) for (const b of theirs) d = Math.min(d, daysBetween(a, b));
		if (d <= MATCH_WINDOW_DAYS && (best == null || d < best.d || (d === best.d && c.id < best.c.id))) best = { c, d };
	}
	return best?.c ?? null;
}
const hasImportBalance = (db: DbOrTx, accountId: number, asOf: string, current: number) =>
	!!db.select({ id: accountBalances.id }).from(accountBalances).where(and(eq(accountBalances.accountId, accountId), eq(accountBalances.asOf, asOf), eq(accountBalances.current, current), eq(accountBalances.source, 'import'))).get();

export function importParsed(db: Db, accountId: number, parsed: ParsedFile, opts: { cadence: Cadence; todayIso: string; dryRun?: boolean }): ImportReport {
	const account = db.select({ id: accounts.id, mask: accounts.mask }).from(accounts).where(eq(accounts.id, accountId)).get();
	if (!account) throw new Error(`account ${accountId} not found`);
	if (parsed.mask && account.mask && parsed.mask !== account.mask) throw new ImportError('mask_mismatch', `mask mismatch (file ${parsed.mask}, account ${account.mask})`);
	reconcileStatement(parsed);
	const base = { format: parsed.format, mask: parsed.mask, statement: parsed.statement, processed: 0, dryRun: !!opts.dryRun };
	const run = (tx: DbOrTx): ImportReport => {
		const dates = [...parsed.rows.map((r) => r.postedDate), ...parsed.balances.map((b) => b.asOf)];
		if (parsed.statement) dates.push(addDays(parsed.statement.opensOn, -1));
		if (dates.length) {
			const earliest = dates.reduce((m, d) => (compareIso(d, m) < 0 ? d : m));
			const next = periodBoundsFor(opts.cadence, nextPeriodStart(opts.cadence, periodBoundsFor(opts.cadence, opts.todayIso).endDate));
			ensurePeriods(tx, opts.cadence, earliest, next.endDate);
		}
		const existing: Candidate[] = tx.select({ id: transactions.id, amount: transactions.amount, postedDate: transactions.postedDate, transactedAt: transactions.transactedAt }).from(transactions).where(and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt))).all();
		const liveIds = new Set(tx.select({ e: transactions.externalId }).from(transactions).where(and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt))).all().map((r) => r.e));
		const byAmount = new Map<number, Candidate[]>(); for (const e of existing) byAmount.set(e.amount, [...(byAmount.get(e.amount) ?? []), e]);
		const claimed = new Set<number>(); const seen = new Map<string, number>();
		let created = 0, duplicates = 0, matched = 0; const createdRows: { postedDate: string; amount: number }[] = [];
		const rows = [...parsed.rows].sort((a, b) => compareIso(a.postedDate, b.postedDate));
		for (const r of rows) {
			const desc = r.memo ?? r.payeeRaw;
			const key = `${r.postedDate}|${r.amount}|${normalizeDescription(desc)}`; const ordinal = seen.get(key) ?? 0; seen.set(key, ordinal + 1);
			const externalId = r.referenceId ?? contentHash({ accountKey: `csv:${accountId}`, date: r.postedDate, amount: r.amount, description: desc, ordinal });
			if (liveIds.has(externalId)) { duplicates++; continue; }
			const m = closestMatch(byAmount.get(r.amount) ?? [], r, claimed);
			if (m) { claimed.add(m.id); matched++; continue; }
			try {
				createTransaction(tx, { accountId, externalId, postedDate: r.postedDate, transactedAt: r.transactedAt, amount: r.amount, payeeRaw: r.payeeRaw, memo: r.memo, providerCategory: r.providerCategory, source: 'import' });
				created++; createdRows.push({ postedDate: r.postedDate, amount: r.amount }); liveIds.add(externalId);
			} catch (err) { if (err instanceof InvariantError && err.code === 'DUPLICATE_EXTERNAL_ID') duplicates++; else throw err; }   // a soft-deleted row still owns the id
		}
		let balances = 0;
		for (const b of parsed.balances) if (!hasImportBalance(tx, accountId, b.asOf, b.current)) { appendBalance(tx, accountId, { asOf: b.asOf, current: b.current, source: 'import' }); balances++; }
		let opening: ImportReport['opening'] = null;
		const O = tx.select().from(transactions).where(and(eq(transactions.accountId, accountId), eq(transactions.source, 'opening'), isNull(transactions.deletedAt))).get();
		if (O) {
			const before = createdRows.filter((c) => compareIso(c.postedDate, O.postedDate) <= 0);
			if (before.length) {
				const to = O.amount - before.reduce((s, c) => s + c.amount, 0);
				const date = addDays(before.map((c) => c.postedDate).reduce((m, d) => (compareIso(d, m) < 0 ? d : m)), -1);
				ensurePeriods(tx, opts.cadence, date, date);
				tx.update(transactions).set({ amount: to, postedDate: date, periodId: periodIdForDate(tx, date), updatedAt: nowIso() }).where(eq(transactions.id, O.id)).run();
				tx.update(transactionSplits).set({ amount: to }).where(eq(transactionSplits.transactionId, O.id)).run();
				opening = { from: O.amount, to, date };
			}
		} else if (parsed.statement && !existing.some((e) => compareIso(e.postedDate, parsed.statement!.opensOn) < 0)) {
			const date = addDays(parsed.statement.opensOn, -1); const amount = parsed.statement.previousBalance;
			createTransaction(tx, { accountId, externalId: 'opening', postedDate: date, amount, payeeRaw: 'Opening balance', payee: 'Opening balance', source: 'opening', splits: [{ categoryId: systemCategoryId(tx, 'reconciliation'), amount }] });
			opening = { seeded: amount, date };
		}
		const report = { ...base, created, duplicates, matched, balances, opening };
		if (opts.dryRun) throw new DryRunRollback(report);
		return report;
	};
	try { return db.transaction(run); } catch (err) { if (err instanceof DryRunRollback) return err.report; throw err; }
}
