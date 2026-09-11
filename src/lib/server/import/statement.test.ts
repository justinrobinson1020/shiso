import { describe, it, expect } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { fixture } from '../test/fixture';
import { accounts, accountBalances, transactions, transactionSplits } from '../db/schema';
import { createTransaction } from '../ledger/transactions';
import { systemCategoryId } from '../ledger/categories';
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
		expect(r.opening).toEqual({ seeded: -2000, date: '2026-07-14' });
		expect(ledgerSum(f.db, f.card)).toBe(-2500);
		const next = { opensOn: '2026-08-15', closesOn: '2026-09-14', previousBalance: -2500, newBalance: -2600 };
		expect(importParsed(f.db, f.card, file([row('2026-09-01', -100, 'B')], { statement: next }), opts).opening).toBeNull();
		expect(ledgerSum(f.db, f.card)).toBe(-2600);
	});
	it('gives the same ledger whether an earlier statement arrives before or after a later one', () => {
		const later = file([row('2026-08-01', -500, 'A')], { statement: { opensOn: '2026-07-15', closesOn: '2026-08-14', previousBalance: -2000, newBalance: -2500 } });
		const earlier = file([row('2026-07-01', -1500, 'Z')], { statement: { opensOn: '2026-06-15', closesOn: '2026-07-14', previousBalance: -500, newBalance: -2000 } });
		const a = fixture(); importParsed(a.db, a.card, later, opts); const ra = importParsed(a.db, a.card, earlier, opts);
		const b = fixture(); importParsed(b.db, b.card, earlier, opts); importParsed(b.db, b.card, later, opts);
		expect(ra.opening).toEqual({ from: -2000, to: -500, date: '2026-06-30' });
		// the opening row's date differs by order (day before the earliest row seen at the time); its amount and every other row do not
		const shape = (x: ReturnType<typeof fixture>) => live(x.db, x.card).filter((t) => t.source !== 'opening').map((t) => [t.postedDate, t.amount, t.source]).sort();
		expect(shape(a)).toEqual(shape(b));
		expect(live(a.db, a.card).find((t) => t.source === 'opening')!.amount).toBe(-500);
		expect(live(b.db, b.card).find((t) => t.source === 'opening')!.amount).toBe(-500);
		expect(ledgerSum(a.db, a.card)).toBe(-2500); expect(ledgerSum(b.db, b.card)).toBe(-2500);
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
