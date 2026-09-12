import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db';
import { accounts, accountBalances, transactions, transactionSplits } from '../db/schema';
import { ensurePeriods, periodBoundsFor, nextPeriodStart, periodIdForDate, type Cadence } from '../budget/periods';
import { createTransaction, markProcessed } from '../ledger/transactions';
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
	/** Σ of every live row dated before the statement's `opensOn` minus its previous balance; 0 when history up to it is complete, null with no statement. Reported, never rejected on. */
	previousDelta: number | null;
	/** The same through `closesOn` against the new balance. It differs from `previousDelta` by exactly what this statement's own window got wrong: a false match, or one that should have happened and did not. */
	closingDelta: number | null;
	processed: number; dryRun: boolean;
};
const MATCH_WINDOW_DAYS = 3;
class DryRunRollback extends Error { constructor(public readonly report: ImportReport) { super('dry run'); } }

export function reconcileStatement(parsed: ParsedFile): void {
	if (!parsed.statement) return;
	const sum = parsed.rows.reduce((s, r) => s + r.amount, 0);
	const expected = parsed.statement.previousBalance + sum;
	if (expected !== parsed.statement.newBalance)
		// Signed, not absolute: over a 125-file run the direction is half the diagnosis. Positive means the parsed
		// rows land above the statement's new balance — on a card, a debit the parser missed — negative below it.
		throw new ImportError('reconcile', `does not reconcile: previous ${parsed.statement.previousBalance} + rows ${sum} ≠ new ${parsed.statement.newBalance} (off by ${expected - parsed.statement.newBalance})`);
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
/** The newest synced balance's date, or null. A statement sample on or after it would outrank it in `latestBalance` and move ready-to-assign. */
const latestSyncBalanceDate = (db: DbOrTx, accountId: number): string | null =>
	db.select({ asOf: accountBalances.asOf }).from(accountBalances).where(and(eq(accountBalances.accountId, accountId), eq(accountBalances.source, 'sync'))).orderBy(desc(accountBalances.asOf)).get()?.asOf ?? null;

/** `acceptMasks`: printed last-fours to accept besides the account's own — a reissued card keeps the account but changes the number. */
export function importParsed(db: Db, accountId: number, parsed: ParsedFile, opts: { cadence: Cadence; todayIso: string; dryRun?: boolean; acceptMasks?: string[] }): ImportReport {
	const account = db.select({ id: accounts.id, mask: accounts.mask }).from(accounts).where(eq(accounts.id, accountId)).get();
	if (!account) throw new Error(`account ${accountId} not found`);
	if (parsed.mask && account.mask && parsed.mask !== account.mask && !(opts.acceptMasks ?? []).includes(parsed.mask)) throw new ImportError('mask_mismatch', `mask mismatch (file ${parsed.mask}, account ${account.mask})`);
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
		const existingRows = tx.select({ id: transactions.id, amount: transactions.amount, postedDate: transactions.postedDate, transactedAt: transactions.transactedAt, externalId: transactions.externalId, source: transactions.source }).from(transactions).where(and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt))).all();
		const liveByExternalId = new Map<string, number>(existingRows.map((e) => [e.externalId, e.id]));
		// Opening rows are a synthetic plug, not a real transaction a statement row could be — never a fuzzy-match candidate.
		const byAmount = new Map<number, Candidate[]>(); for (const e of existingRows) if (e.source !== 'opening') byAmount.set(e.amount, [...(byAmount.get(e.amount) ?? []), e]);
		const claimed = new Set<number>(); const seen = new Map<string, number>();
		let created = 0, duplicates = 0, matched = 0; const createdRows: { postedDate: string; amount: number }[] = [];
		const rows = [...parsed.rows].sort((a, b) => compareIso(a.postedDate, b.postedDate));
		for (const r of rows) {
			const desc = r.memo ?? r.payeeRaw;
			const key = `${r.postedDate}|${r.amount}|${normalizeDescription(desc)}`; const ordinal = seen.get(key) ?? 0; seen.set(key, ordinal + 1);
			const externalId = r.referenceId ?? contentHash({ accountKey: `csv:${accountId}`, date: r.postedDate, amount: r.amount, description: desc, ordinal });
			const dupId = liveByExternalId.get(externalId);
			if (dupId !== undefined) { duplicates++; claimed.add(dupId); continue; }   // its live twin is spoken for; a different row must not fuzzy-match it
			const m = closestMatch(byAmount.get(r.amount) ?? [], r, claimed);
			if (m) { claimed.add(m.id); matched++; continue; }
			try {
				const id = createTransaction(tx, { accountId, externalId, postedDate: r.postedDate, transactedAt: r.transactedAt, amount: r.amount, payeeRaw: r.payeeRaw, memo: r.memo, providerCategory: r.providerCategory, source: 'import' });
				created++; createdRows.push({ postedDate: r.postedDate, amount: r.amount }); liveByExternalId.set(externalId, id);
			} catch (err) { if (err instanceof InvariantError && err.code === 'DUPLICATE_EXTERNAL_ID') duplicates++; else throw err; }   // a soft-deleted row still owns the id
		}
		let balances = 0;
		// A month-end sample dated on or after the newest sync balance would become the account's current
		// balance and move ready-to-assign; only samples strictly older than it are history worth keeping.
		const syncedThrough = latestSyncBalanceDate(tx, accountId);
		for (const b of parsed.balances) {
			if (syncedThrough && compareIso(b.asOf, syncedThrough) >= 0) continue;
			if (hasImportBalance(tx, accountId, b.asOf, b.current)) continue;
			appendBalance(tx, accountId, { asOf: b.asOf, current: b.current, source: 'import' }); balances++;
		}
		// The account's live rows as they stand now, this call's included.
		const liveRows = () => tx.select({ amount: transactions.amount, postedDate: transactions.postedDate, source: transactions.source })
			.from(transactions).where(and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt))).all();
		const sum = (rows: { amount: number }[]) => rows.reduce((s, t) => s + t.amount, 0);
		/** Move the opening row to `amount`/`date`, its single reconciliation split with it, and keep it out of transfer detection. */
		const moveOpening = (id: number, amount: number, date: string) => {
			const openingSplits = tx.select({ id: transactionSplits.id }).from(transactionSplits).where(eq(transactionSplits.transactionId, id)).all();
			if (openingSplits.length !== 1) throw new Error('opening row has multiple splits; cannot adjust');
			ensurePeriods(tx, opts.cadence, date, date);
			tx.update(transactions).set({ amount, postedDate: date, periodId: periodIdForDate(tx, date), updatedAt: nowIso() }).where(eq(transactions.id, id)).run();
			tx.update(transactionSplits).set({ amount }).where(eq(transactionSplits.id, openingSplits[0].id)).run();
			markProcessed(tx, [id]);
		};
		let opening: ImportReport['opening'] = null;
		let previousDelta: number | null = null, closingDelta: number | null = null;
		const S = parsed.statement;
		const O = tx.select().from(transactions).where(and(eq(transactions.accountId, accountId), eq(transactions.source, 'opening'), isNull(transactions.deletedAt))).get();
		if (S) {
			// The statement states the balance the day before it opens, so the opening plug is whatever that
			// balance is not already explained by: previousBalance − (live rows dated before opensOn).
			const date = addDays(S.opensOn, -1);
			const amount = S.previousBalance - sum(liveRows().filter((t) => t.source !== 'opening' && compareIso(t.postedDate, S.opensOn) < 0));
			if (!O) {
				try {
					const id = createTransaction(tx, { accountId, externalId: 'opening', postedDate: date, amount, payeeRaw: 'Opening balance', payee: 'Opening balance', source: 'opening', splits: [{ categoryId: systemCategoryId(tx, 'reconciliation'), amount }] });
					markProcessed(tx, [id]);
					opening = { seeded: amount, date };
				} catch (err) { if (!(err instanceof InvariantError && err.code === 'DUPLICATE_EXTERNAL_ID')) throw err; }   // a soft-deleted opening row still owns the id
			} else if (compareIso(O.postedDate, date) >= 0 && (O.amount !== amount || O.postedDate !== date)) {
				// O sits at or after this statement's opening day: this statement is the earliest history the
				// account has, so it owns the plug. An O already earlier than that covers older history; leave it.
				moveOpening(O.id, amount, date);
				opening = { from: O.amount, to: amount, date };
			}
			const settled = liveRows();   // after the opening step, so both deltas read the ledger the caller will see
			previousDelta = sum(settled.filter((t) => compareIso(t.postedDate, S.opensOn) < 0)) - S.previousBalance;
			closingDelta = sum(settled.filter((t) => compareIso(t.postedDate, S.closesOn) <= 0)) - S.newBalance;
		} else if (O) {
			const before = createdRows.filter((c) => compareIso(c.postedDate, O.postedDate) <= 0);
			if (before.length) {
				const to = O.amount - before.reduce((s, c) => s + c.amount, 0);
				const date = addDays(before.map((c) => c.postedDate).reduce((m, d) => (compareIso(d, m) < 0 ? d : m)), -1);
				moveOpening(O.id, to, date);
				opening = { from: O.amount, to, date };
			}
		}
		const report = { ...base, created, duplicates, matched, balances, opening, previousDelta, closingDelta };
		if (opts.dryRun) throw new DryRunRollback(report);
		return report;
	};
	try { return db.transaction(run); } catch (err) { if (err instanceof DryRunRollback) return err.report; throw err; }
}
