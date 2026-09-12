import { describe, it, expect } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { fixture } from '../test/fixture';
import { accounts, accountBalances, transactions, transactionSplits } from '../db/schema';
import { createTransaction } from '../ledger/transactions';
import { systemCategoryId } from '../ledger/categories';
import { appendBalance } from '../sync/connections';
import { importParsed, reconcileStatement } from './statement';
import { ImportError, type ParsedFile, type ParsedRow } from './formats/types';
const row = (postedDate: string, amount: number, payeeRaw: string, extra: Partial<ParsedRow> = {}): ParsedRow => ({ postedDate, transactedAt: null, amount, payeeRaw, memo: null, providerCategory: null, referenceId: null, ...extra });
const file = (rows: ParsedRow[], extra: Partial<ParsedFile> = {}): ParsedFile => ({ format: 'chase', mask: null, statement: null, rows, balances: [], ...extra });
const opts = { cadence: 'semi_monthly' as const, todayIso: '2026-09-08' };
const live = (db: ReturnType<typeof fixture>['db'], accountId: number) => db.select().from(transactions).where(and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt))).orderBy(transactions.postedDate).all();
const ledgerSum = (db: ReturnType<typeof fixture>['db'], accountId: number) => live(db, accountId).reduce((s, t) => s + t.amount, 0);

describe('reconcileStatement', () => {
	it('passes when previous + rows = new and rejects otherwise with the difference', () => {
		const ok = file([row('2026-08-01', -1000, 'A'), row('2026-08-02', 500, 'B')], { statement: { opensOn: '2026-07-15', closesOn: '2026-08-14', previousBalance: -2000, newBalance: -2500 } });
		expect(() => reconcileStatement(ok)).not.toThrow();
		const bad = { ...ok, statement: { ...ok.statement!, newBalance: -2600 } };
		expect(() => reconcileStatement(bad)).toThrow(ImportError);
		expect(() => reconcileStatement(bad)).toThrow(/does not reconcile: previous -2000 \+ rows -500 ≠ new -2600 \(off by 100\)/);
		// signed, so the direction survives: the same gap the other way reads -100, not 100
		const other = { ...ok, statement: { ...ok.statement!, newBalance: -2400 } };
		expect(() => reconcileStatement(other)).toThrow(/≠ new -2400 \(off by -100\)/);
	});
});

describe('importParsed', () => {
	it('creates rows once with content-hash ids, keeps identical rows apart by ordinal, and is idempotent', () => {
		const f = fixture();
		const parsed = file([row('2026-08-03', -9526, 'UBER'), row('2026-08-03', -9526, 'UBER'), row('2026-08-05', 20000, 'Payment')]);
		expect(importParsed(f.db, f.card, parsed, opts)).toMatchObject({ created: 3, duplicates: 0, matched: 0, balances: 0, opening: null, dryRun: false });
		expect(importParsed(f.db, f.card, parsed, opts)).toMatchObject({ created: 0, duplicates: 3, matched: 0 });
		expect(live(f.db, f.card).every((t) => t.source === 'import' && t.processedAt === null)).toBe(true);
	});
	it('uses the issuer reference id as the external id when the row has one', () => {
		const f = fixture();
		importParsed(f.db, f.card, file([row('2026-08-03', -100, 'X', { referenceId: 'syf:ABC' })]), opts);
		expect(live(f.db, f.card)[0].externalId).toBe('syf:ABC');
	});
	it('matches synced rows by amount within three days of posted or transacted date, claiming each once', () => {
		const f = fixture();
		// Plaid rows: posted 1–2 days after the statement's transaction date; two identical $18.98 rides
		createTransaction(f.db, { accountId: f.card, externalId: 'plaid1', postedDate: '2026-08-02', transactedAt: '2026-08-01T00:00:00Z', amount: -5125, payeeRaw: 'Uber', source: 'sync' });
		createTransaction(f.db, { accountId: f.card, externalId: 'plaid2', postedDate: '2026-08-09', transactedAt: '2026-08-07T00:00:00Z', amount: -1898, payeeRaw: 'Lyft', source: 'sync' });
		createTransaction(f.db, { accountId: f.card, externalId: 'plaid3', postedDate: '2026-08-10', transactedAt: '2026-08-08T00:00:00Z', amount: -1898, payeeRaw: 'Lyft', source: 'sync' });
		createTransaction(f.db, { accountId: f.card, externalId: 'plaid4', postedDate: '2026-08-20', amount: -1898, payeeRaw: 'Lyft', source: 'sync' });   // too far away
		const parsed = file([row('2026-08-01', -5125, 'UBER *TRIP'), row('2026-08-08', -1898, 'LYFT *RIDE'), row('2026-08-08', -1898, 'LYFT *RIDE'), row('2026-08-08', -1898, 'LYFT *RIDE')]);
		const r = importParsed(f.db, f.card, parsed, opts);
		expect(r).toMatchObject({ created: 1, duplicates: 0, matched: 3 });
		expect(live(f.db, f.card).filter((t) => t.source === 'import').map((t) => t.postedDate)).toEqual(['2026-08-08']);
	});
	it('never matches two rows from the same file against each other', () => {
		const f = fixture();
		const r = importParsed(f.db, f.card, file([row('2026-08-08', -1898, 'LYFT'), row('2026-08-09', -1898, 'LYFT')]), opts);
		expect(r).toMatchObject({ created: 2, matched: 0 });
	});
	it('claims an exact duplicate\'s live twin so a different row cannot fuzzy-match it', () => {
		const f = fixture();
		importParsed(f.db, f.card, file([row('2026-08-03', -1599, 'NETFLIX')]), opts);
		const r = importParsed(f.db, f.card, file([row('2026-08-03', -1599, 'NETFLIX'), row('2026-08-05', -1599, 'SPOTIFY')]), opts);
		expect(r).toMatchObject({ duplicates: 1, created: 1, matched: 0 });
		expect(live(f.db, f.card)).toHaveLength(2);
	});
	it('never fuzzy-matches a statement row against the synthetic opening row', () => {
		const f = fixture();
		const recon = systemCategoryId(f.db, 'reconciliation');
		createTransaction(f.db, { accountId: f.card, externalId: 'opening', postedDate: '2026-08-01', amount: -5000, payeeRaw: 'Opening balance', source: 'opening', splits: [{ categoryId: recon, amount: -5000 }] });
		const r = importParsed(f.db, f.card, file([row('2026-08-02', -5000, 'TV')]), opts);
		expect(r).toMatchObject({ created: 1, matched: 0 });
		expect(live(f.db, f.card)).toHaveLength(2);
		const o = live(f.db, f.card).find((t) => t.source === 'opening')!;
		expect([o.postedDate, o.amount]).toEqual(['2026-08-01', -5000]);
	});
	it('accepts a printed mask listed in acceptMasks (a reissued card)', () => {
		const f = fixture();
		f.db.update(accounts).set({ mask: '5692' }).where(eq(accounts.id, f.card)).run();
		expect(importParsed(f.db, f.card, file([row('2026-08-01', -1, 'x')], { mask: '0140' }), { ...opts, acceptMasks: ['0140'] })).toMatchObject({ created: 1 });
		expect(() => importParsed(f.db, f.card, file([row('2026-08-02', -1, 'y')], { mask: '1403' }), { ...opts, acceptMasks: ['0140'] })).toThrow(/mask mismatch/);
	});
	it('rejects a mask mismatch before writing anything', () => {
		const f = fixture();
		f.db.update(accounts).set({ mask: '5692' }).where(eq(accounts.id, f.card)).run();
		expect(() => importParsed(f.db, f.card, file([row('2026-08-01', -1, 'x')], { mask: '1403' }), opts)).toThrow(/mask mismatch \(file 1403, account 5692\)/);
		expect(live(f.db, f.card)).toHaveLength(0);
	});
	it('appends statement balances once', () => {
		const f = fixture();
		const parsed = file([], { balances: [{ asOf: '2026-08-14', current: -250000 }] });
		expect(importParsed(f.db, f.card, parsed, opts).balances).toBe(1);
		expect(importParsed(f.db, f.card, parsed, opts).balances).toBe(0);
		expect(f.db.select().from(accountBalances).where(eq(accountBalances.accountId, f.card)).all()).toMatchObject([{ asOf: '2026-08-14', current: -250000, source: 'import' }]);
	});
	it('skips a statement balance dated on or after the newest synced balance', () => {
		const f = fixture();
		appendBalance(f.db, f.card, { asOf: '2026-09-08', current: -68691, source: 'sync' });
		// the month-end sample is history; the one that ties the sync would outrank it and move ready-to-assign
		const parsed = file([], { balances: [{ asOf: '2026-08-31', current: -60000 }, { asOf: '2026-09-08', current: -70000 }] });
		expect(importParsed(f.db, f.card, parsed, opts).balances).toBe(1);
		expect(f.db.select().from(accountBalances).where(and(eq(accountBalances.accountId, f.card), eq(accountBalances.source, 'import'))).all())
			.toMatchObject([{ asOf: '2026-08-31', current: -60000 }]);
	});
	it('reduces and redates an existing opening row by the rows created on or before it', () => {
		const f = fixture();
		const recon = systemCategoryId(f.db, 'reconciliation');
		// first sync on 2026-08-15: balance -1000, one synced row -300 → opening -700
		createTransaction(f.db, { accountId: f.card, externalId: 'opening', postedDate: '2026-08-15', amount: -700, payeeRaw: 'Opening balance', source: 'opening', splits: [{ categoryId: recon, amount: -700 }] });
		createTransaction(f.db, { accountId: f.card, externalId: 'p1', postedDate: '2026-08-14', amount: -300, payeeRaw: 'Synced', source: 'sync' });
		expect(ledgerSum(f.db, f.card)).toBe(-1000);
		const r = importParsed(f.db, f.card, file([row('2026-07-20', -400, 'Old purchase'), row('2026-08-13', -300, 'Synced')]), opts);   // second row matches p1
		expect(r).toMatchObject({ created: 1, matched: 1, opening: { from: -700, to: -300, date: '2026-07-19' } });
		expect(ledgerSum(f.db, f.card)).toBe(-1000);
		const o = live(f.db, f.card).find((t) => t.source === 'opening')!;
		expect([o.postedDate, o.amount]).toEqual(['2026-07-19', -300]);
		expect(f.db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, o.id)).all().map((s) => s.amount)).toEqual([-300]);
		expect(importParsed(f.db, f.card, file([row('2026-07-20', -400, 'Old purchase')]), opts).opening).toBeNull();   // re-import: untouched
	});
	it('seeds an opening row from a statement previous balance when the account has none, and later statements do not reseed', () => {
		const f = fixture();
		const st = { opensOn: '2026-07-15', closesOn: '2026-08-14', previousBalance: -2000, newBalance: -2500 };
		const r = importParsed(f.db, f.card, file([row('2026-08-01', -500, 'A')], { statement: st }), opts);
		expect(r).toMatchObject({ opening: { seeded: -2000, date: '2026-07-14' }, previousDelta: 0, closingDelta: 0 });
		expect(ledgerSum(f.db, f.card)).toBe(-2500);
		const next = { opensOn: '2026-08-15', closesOn: '2026-09-14', previousBalance: -2500, newBalance: -2600 };
		const r2 = importParsed(f.db, f.card, file([row('2026-09-01', -100, 'B')], { statement: next }), opts);
		expect(r2).toMatchObject({ opening: null, previousDelta: 0, closingDelta: 0 });   // the later statement's own opening day is already covered
		expect(ledgerSum(f.db, f.card)).toBe(-2600);
	});
	it('keeps the seeded opening row out of transfer detection', () => {
		const f = fixture();
		const st = { opensOn: '2026-07-15', closesOn: '2026-08-14', previousBalance: -2000, newBalance: -2500 };
		importParsed(f.db, f.card, file([row('2026-08-01', -500, 'A')], { statement: st }), opts);
		expect(live(f.db, f.card).find((t) => t.source === 'opening')!.processedAt).not.toBeNull();
	});
	it('gives the same ledger whether an earlier statement arrives before or after a later one', () => {
		const later = file([row('2026-08-01', -500, 'A')], { statement: { opensOn: '2026-07-15', closesOn: '2026-08-14', previousBalance: -2000, newBalance: -2500 } });
		const earlier = file([row('2026-07-01', -1500, 'Z')], { statement: { opensOn: '2026-06-15', closesOn: '2026-07-14', previousBalance: -500, newBalance: -2000 } });
		const a = fixture(); importParsed(a.db, a.card, later, opts); const ra = importParsed(a.db, a.card, earlier, opts);
		const b = fixture(); importParsed(b.db, b.card, earlier, opts); const rb = importParsed(b.db, b.card, later, opts);
		// the plug belongs to the earliest statement either way: the day before it opens, holding its previous balance
		expect(ra).toMatchObject({ opening: { from: -2000, to: -500, date: '2026-06-14' }, previousDelta: 0, closingDelta: 0 });
		expect(rb).toMatchObject({ opening: null, previousDelta: 0, closingDelta: 0 });
		const shape = (x: ReturnType<typeof fixture>) => live(x.db, x.card).map((t) => [t.postedDate, t.amount, t.source]).sort();
		expect(shape(a)).toEqual(shape(b));
		expect(live(a.db, a.card).find((t) => t.source === 'opening')!.amount).toBe(-500);
		expect(live(b.db, b.card).find((t) => t.source === 'opening')!.amount).toBe(-500);
		expect(ledgerSum(a.db, a.card)).toBe(-2500); expect(ledgerSum(b.db, b.card)).toBe(-2500);
	});
	it('reports the gap while a middle statement is missing and closes it when that statement arrives', () => {
		const f = fixture();
		const aug = file([row('2026-08-10', -500, 'Aug')], { statement: { opensOn: '2026-08-01', closesOn: '2026-08-31', previousBalance: -2000, newBalance: -2500 } });
		const jun = file([row('2026-06-10', -1000, 'Jun')], { statement: { opensOn: '2026-06-01', closesOn: '2026-06-30', previousBalance: -500, newBalance: -1500 } });
		const jul = file([row('2026-07-10', -500, 'Jul')], { statement: { opensOn: '2026-07-01', closesOn: '2026-07-31', previousBalance: -1500, newBalance: -2000 } });
		expect(importParsed(f.db, f.card, aug, opts)).toMatchObject({ opening: { seeded: -2000, date: '2026-07-31' }, previousDelta: 0, closingDelta: 0 });
		expect(ledgerSum(f.db, f.card)).toBe(-2500);
		// June takes the plug over: it is now the earliest statement, and its previous balance is the whole history before it
		expect(importParsed(f.db, f.card, jun, opts)).toMatchObject({ opening: { from: -2000, to: -500, date: '2026-05-31' }, previousDelta: 0, closingDelta: 0 });
		expect(ledgerSum(f.db, f.card)).toBe(-2000);   // August's rows are in, July's are not: understated by exactly ΣJuly
		expect(importParsed(f.db, f.card, jul, opts)).toMatchObject({ opening: null, previousDelta: 0, closingDelta: 0 });
		expect(ledgerSum(f.db, f.card)).toBe(-2500);
		// with all three in, every window closes: August's covers the whole ledger, June's and July's their own prefixes
		for (const parsed of [aug, jun, jul]) expect(importParsed(f.db, f.card, parsed, opts)).toMatchObject({ created: 0, duplicates: 1, opening: null, previousDelta: 0, closingDelta: 0 });
		expect(ledgerSum(f.db, f.card)).toBe(-2500);
	});
	it('reports a nonzero previousDelta when the statement claims history the ledger does not have', () => {
		const f = fixture();
		// July alone: nothing before it explains its -1500 previous balance, so the plug takes all of it and the gap is 0…
		const jul = file([row('2026-07-10', -500, 'Jul')], { statement: { opensOn: '2026-07-01', closesOn: '2026-07-31', previousBalance: -1500, newBalance: -2000 } });
		expect(importParsed(f.db, f.card, jul, opts)).toMatchObject({ opening: { seeded: -1500, date: '2026-06-30' }, previousDelta: 0, closingDelta: 0 });
		// …but a September statement that expects August's -800 of rows sees them missing, before its window and inside it
		const sep = file([row('2026-09-05', -100, 'Sep')], { statement: { opensOn: '2026-09-01', closesOn: '2026-09-30', previousBalance: -2800, newBalance: -2900 } });
		expect(importParsed(f.db, f.card, sep, opts)).toMatchObject({ opening: null, previousDelta: 800, closingDelta: 800 });
	});
	it('reports a nonzero closingDelta when the statement window itself does not add up', () => {
		const f = fixture();
		// Plaid posted the same ride twice; the statement has it once, so one of the two is matched and the other stays
		createTransaction(f.db, { accountId: f.card, externalId: 'plaid1', postedDate: '2026-08-19', amount: -1898, payeeRaw: 'Lyft', source: 'sync' });
		createTransaction(f.db, { accountId: f.card, externalId: 'plaid2', postedDate: '2026-08-20', amount: -1898, payeeRaw: 'Lyft', source: 'sync' });
		const aug = file([row('2026-08-19', -1898, 'LYFT *RIDE')], { statement: { opensOn: '2026-08-01', closesOn: '2026-08-31', previousBalance: -1000, newBalance: -2898 } });
		// history before the statement is complete, but its window holds one -1898 too many
		expect(importParsed(f.db, f.card, aug, opts)).toMatchObject({ created: 0, matched: 1, previousDelta: 0, closingDelta: -1898 });
	});
	it('dry run returns the report and leaves every table byte-identical', () => {
		const f = fixture();
		const snapshot = () => JSON.stringify([f.db.select().from(transactions).all(), f.db.select().from(transactionSplits).all(), f.db.select().from(accountBalances).all()]);
		const before = snapshot();
		const parsed = file([row('2026-08-01', -500, 'A')], { statement: { opensOn: '2026-07-15', closesOn: '2026-08-14', previousBalance: -2000, newBalance: -2500 }, balances: [{ asOf: '2026-08-14', current: -2500 }] });
		const r = importParsed(f.db, f.card, parsed, { ...opts, dryRun: true });
		expect(r).toMatchObject({ created: 1, balances: 1, opening: { seeded: -2000, date: '2026-07-14' }, dryRun: true });
		expect(snapshot()).toBe(before);
	});
	it('creates periods back to the earliest row', () => {
		const f = fixture();
		importParsed(f.db, f.card, file([row('2024-09-26', -100, 'old')]), opts);
		expect(live(f.db, f.card)[0].periodId).toBeGreaterThan(0);
	});
});
