import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db';
import { accounts, accountBalances, transactions, transactionSplits } from '../db/schema';
import { ensurePeriods, periodBoundsFor, nextPeriodStart, periodIdForDate, type Cadence } from '../budget/periods';
import { createTransaction, createOpeningRow, markProcessed } from '../ledger/transactions';
import { InvariantError, NotFoundError } from '../ledger/errors';
import { appendBalance } from '../sync/connections';
import { contentHash, normalizeDescription } from '../sync/hash';
import { ImportError, type ImportFormat, type ParsedFile, type ParsedRow, type ParsedStatement } from './formats/types';
import { addDays, compareIso, dayDistance, nowIso } from '$lib/dates';

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
type Candidate = { id: number; amount: number; postedDate: string; transactedAt: string | null };
/** Closest live row with the same amount whose dates come within the window of the row's dates; null when none. */
function closestMatch(cands: Candidate[], r: ParsedRow, claimed: Set<number>): Candidate | null {
	const mine = [r.postedDate, dayOf(r.transactedAt)].filter((d): d is string => d != null);
	let best: { c: Candidate; d: number } | null = null;
	for (const c of cands) {
		if (claimed.has(c.id)) continue;
		const theirs = [c.postedDate, dayOf(c.transactedAt)].filter((d): d is string => d != null);
		let d = Infinity; for (const a of mine) for (const b of theirs) d = Math.min(d, dayDistance(a, b));
		if (d <= MATCH_WINDOW_DAYS && (best == null || d < best.d || (d === best.d && c.id < best.c.id))) best = { c, d };
	}
	return best?.c ?? null;
}
const hasImportBalance = (db: DbOrTx, accountId: number, asOf: string, current: number) =>
	!!db.select({ id: accountBalances.id }).from(accountBalances).where(and(eq(accountBalances.accountId, accountId), eq(accountBalances.asOf, asOf), eq(accountBalances.current, current), eq(accountBalances.source, 'import'))).get();
/** The newest synced balance's date, or null. A statement sample on or after it would outrank it in `latestBalance` and move ready-to-assign. */
const latestSyncBalanceDate = (db: DbOrTx, accountId: number): string | null =>
	db.select({ asOf: accountBalances.asOf }).from(accountBalances).where(and(eq(accountBalances.accountId, accountId), eq(accountBalances.source, 'sync'))).orderBy(desc(accountBalances.asOf)).get()?.asOf ?? null;

type ExistingRow = { id: number; amount: number; postedDate: string; transactedAt: string | null; externalId: string; source: string };
type CreatedRow = { postedDate: string; amount: number };
type Opening = ImportReport['opening'];

const sum = (rows: { amount: number }[]) => rows.reduce((s, t) => s + t.amount, 0);
const earliestOf = (dates: string[]) => dates.reduce((m, d) => (compareIso(d, m) < 0 ? d : m));
const isDuplicateId = (err: unknown) => err instanceof InvariantError && err.code === 'DUPLICATE_EXTERNAL_ID';

// Fuzzy matching exists only to absorb rows a provider already synced (or the user typed by hand) under a
// slightly different date. Rows from earlier imports are identified exactly by reference id or content hash,
// and opening/adjustment rows are synthetic plugs — none of those may be candidates, or two distinct purchases
// of the same amount on adjacent days collapse into one.
const FUZZY_SOURCES = new Set(['sync', 'manual']);

/** Create, skip or absorb each parsed row against what the account already holds. */
function importRows(tx: DbOrTx, accountId: number, parsedRows: ParsedRow[], existingRows: ExistingRow[]): { created: number; duplicates: number; matched: number; createdRows: CreatedRow[] } {
	const liveByExternalId = new Map<string, number>(existingRows.map((e) => [e.externalId, e.id]));
	const byAmount = new Map<number, Candidate[]>();
	for (const e of existingRows) if (FUZZY_SOURCES.has(e.source)) byAmount.set(e.amount, [...(byAmount.get(e.amount) ?? []), e]);
	const claimed = new Set<number>();
	const seen = new Map<string, number>();
	let created = 0, duplicates = 0, matched = 0;
	const createdRows: CreatedRow[] = [];
	const rows = [...parsedRows].sort((a, b) => compareIso(a.postedDate, b.postedDate));
	for (const r of rows) {
		const desc = r.memo ?? r.payeeRaw;
		const key = `${r.postedDate}|${r.amount}|${normalizeDescription(desc)}`;
		const ordinal = seen.get(key) ?? 0;
		seen.set(key, ordinal + 1);
		const externalId = r.referenceId ?? contentHash({ accountKey: `csv:${accountId}`, date: r.postedDate, amount: r.amount, description: desc, ordinal });
		const dupId = liveByExternalId.get(externalId);
		if (dupId !== undefined) { duplicates++; claimed.add(dupId); continue; }   // its live twin is spoken for; a different row must not fuzzy-match it
		const m = closestMatch(byAmount.get(r.amount) ?? [], r, claimed);
		if (m) { claimed.add(m.id); matched++; continue; }
		try {
			const id = createTransaction(tx, { accountId, externalId, postedDate: r.postedDate, transactedAt: r.transactedAt, amount: r.amount, payeeRaw: r.payeeRaw, memo: r.memo, providerCategory: r.providerCategory, source: 'import' });
			created++; createdRows.push({ postedDate: r.postedDate, amount: r.amount }); liveByExternalId.set(externalId, id);
		} catch (err) { if (isDuplicateId(err)) duplicates++; else throw err; }   // a soft-deleted row still owns the id
	}
	return { created, duplicates, matched, createdRows };
}

/** Keep the file's month-end balance samples that are history, not a competitor to the newest synced balance. */
function importBalances(tx: DbOrTx, accountId: number, samples: ParsedFile['balances']): number {
	// A month-end sample dated on or after the newest sync balance would become the account's current
	// balance and move ready-to-assign; only samples strictly older than it are history worth keeping.
	const syncedThrough = latestSyncBalanceDate(tx, accountId);
	let written = 0;
	for (const b of samples) {
		if (syncedThrough && compareIso(b.asOf, syncedThrough) >= 0) continue;
		if (hasImportBalance(tx, accountId, b.asOf, b.current)) continue;
		appendBalance(tx, accountId, { asOf: b.asOf, current: b.current, source: 'import' });
		written++;
	}
	return written;
}

/** Move the opening row to `amount`/`date`, its single reconciliation split with it, and keep it out of transfer detection. */
function moveOpening(tx: DbOrTx, cadence: Cadence, id: number, amount: number, date: string): void {
	const openingSplits = tx.select({ id: transactionSplits.id }).from(transactionSplits).where(eq(transactionSplits.transactionId, id)).all();
	if (openingSplits.length !== 1) throw new Error('opening row has multiple splits; cannot adjust');
	ensurePeriods(tx, cadence, date, date);
	tx.update(transactions).set({ amount, postedDate: date, periodId: periodIdForDate(tx, date), updatedAt: nowIso() }).where(eq(transactions.id, id)).run();
	tx.update(transactionSplits).set({ amount }).where(eq(transactionSplits.id, openingSplits[0].id)).run();
	markProcessed(tx, [id]);
}

/** Create the opening row; false when a soft-deleted one still owns the account's `opening` id. */
function seedOpening(tx: DbOrTx, cadence: Cadence, accountId: number, date: string, amount: number): boolean {
	try {
		ensurePeriods(tx, cadence, date, date);
		createOpeningRow(tx, { accountId, postedDate: date, amount });
		return true;
	} catch (err) { if (isDuplicateId(err)) return false; throw err; }
}

/** The account's live rows as they stand now, this call's included. */
const liveRows = (tx: DbOrTx, accountId: number) => tx.select({ amount: transactions.amount, postedDate: transactions.postedDate, source: transactions.source })
	.from(transactions).where(and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt))).all();

/** With a statement: the opening plug is whatever its previous balance is not already explained by. Returns how the plug moved and both deltas. */
function settleFromStatement(tx: DbOrTx, cadence: Cadence, accountId: number, S: ParsedStatement, O: { id: number; amount: number; postedDate: string } | undefined, existingRows: ExistingRow[]): { opening: Opening; previousDelta: number; closingDelta: number } {
	// The statement states the balance the day before it opens, so the opening plug is previousBalance − (live rows dated before opensOn).
	const date = addDays(S.opensOn, -1);
	// Only rows that existed before this call count: a row this statement prints with a transaction date
	// before its own opening day posted inside this cycle, so it is not part of previousBalance either.
	const amount = S.previousBalance - sum(existingRows.filter((t) => t.source !== 'opening' && compareIso(t.postedDate, S.opensOn) < 0));
	let opening: Opening = null;
	if (!O) {
		if (seedOpening(tx, cadence, accountId, date, amount)) opening = { seeded: amount, date };
	} else if (compareIso(O.postedDate, date) >= 0 && (O.amount !== amount || O.postedDate !== date)) {
		// O sits at or after this statement's opening day: this statement is the earliest history the
		// account has, so it owns the plug. An O already earlier than that covers older history; leave it.
		moveOpening(tx, cadence, O.id, amount, date);
		opening = { from: O.amount, to: amount, date };
	}
	const settled = liveRows(tx, accountId);   // after the opening step, so both deltas read the ledger the caller will see
	return {
		opening,
		previousDelta: sum(settled.filter((t) => compareIso(t.postedDate, S.opensOn) < 0)) - S.previousBalance,
		closingDelta: sum(settled.filter((t) => compareIso(t.postedDate, S.closesOn) <= 0)) - S.newBalance
	};
}

/** Without statement balances (a CSV): fold rows older than the account's synced history into the opening plug. */
function settleFromRows(tx: DbOrTx, cadence: Cadence, accountId: number, O: { id: number; amount: number; postedDate: string } | undefined, existingRows: ExistingRow[], createdRows: CreatedRow[]): Opening {
	// Rows dated before the account's first synced row were already folded into the opening plug when sync began,
	// so the plug absorbs them — across files, since O moves earlier with each one. Rows dated after it are real
	// gaps in the synced data and stay visible. Without synced rows the plug's own date is the cutoff.
	const firstSync = existingRows.filter((e) => e.source === 'sync').map((e) => e.postedDate).sort()[0] ?? null;
	const absorbed = createdRows.filter((c) => (firstSync ? compareIso(c.postedDate, firstSync) < 0 : O != null && compareIso(c.postedDate, O.postedDate) <= 0));
	if (absorbed.length === 0) return null;
	const total = sum(absorbed);
	const earliest = earliestOf(absorbed.map((c) => c.postedDate));
	if (O) {
		const date = compareIso(O.postedDate, earliest) < 0 ? O.postedDate : addDays(earliest, -1);
		moveOpening(tx, cadence, O.id, O.amount - total, date);
		return { from: O.amount, to: O.amount - total, date };
	}
	const date = addDays(earliest, -1);
	ensurePeriods(tx, cadence, date, date);
	createOpeningRow(tx, { accountId, postedDate: date, amount: -total });   // unlike a statement, a duplicate id here is a real conflict and surfaces
	return { seeded: -total, date };
}

/** `acceptMasks`: printed last-fours to accept besides the account's own — a reissued card keeps the account but changes the number. */
export function importParsed(db: Db, accountId: number, parsed: ParsedFile, opts: { cadence: Cadence; todayIso: string; dryRun?: boolean; acceptMasks?: string[] }): ImportReport {
	const account = db.select({ id: accounts.id, mask: accounts.mask }).from(accounts).where(eq(accounts.id, accountId)).get();
	if (!account) throw new NotFoundError(`account ${accountId} not found`);
	if (parsed.mask && account.mask && parsed.mask !== account.mask && !(opts.acceptMasks ?? []).includes(parsed.mask)) throw new ImportError('mask_mismatch', `mask mismatch (file ${parsed.mask}, account ${account.mask})`);
	reconcileStatement(parsed);
	const base = { format: parsed.format, mask: parsed.mask, statement: parsed.statement, processed: 0, dryRun: !!opts.dryRun };
	const run = (tx: DbOrTx): ImportReport => {
		const dates = [...parsed.rows.map((r) => r.postedDate), ...parsed.balances.map((b) => b.asOf)];
		if (parsed.statement) dates.push(addDays(parsed.statement.opensOn, -1));
		if (dates.length) {
			const next = periodBoundsFor(opts.cadence, nextPeriodStart(opts.cadence, periodBoundsFor(opts.cadence, opts.todayIso).endDate));
			ensurePeriods(tx, opts.cadence, earliestOf(dates), next.endDate);
		}
		const existingRows = tx.select({ id: transactions.id, amount: transactions.amount, postedDate: transactions.postedDate, transactedAt: transactions.transactedAt, externalId: transactions.externalId, source: transactions.source }).from(transactions).where(and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt))).all();
		const { created, duplicates, matched, createdRows } = importRows(tx, accountId, parsed.rows, existingRows);
		const balances = importBalances(tx, accountId, parsed.balances);
		const O = tx.select().from(transactions).where(and(eq(transactions.accountId, accountId), eq(transactions.source, 'opening'), isNull(transactions.deletedAt))).get();
		const settled = parsed.statement
			? settleFromStatement(tx, opts.cadence, accountId, parsed.statement, O, existingRows)
			: { opening: settleFromRows(tx, opts.cadence, accountId, O, existingRows, createdRows), previousDelta: null, closingDelta: null };
		const report: ImportReport = { ...base, created, duplicates, matched, balances, ...settled };
		if (opts.dryRun) throw new DryRunRollback(report);
		return report;
	};
	try { return db.transaction(run); } catch (err) { if (err instanceof DryRunRollback) return err.report; throw err; }
}
