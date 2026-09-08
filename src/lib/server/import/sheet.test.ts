import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { fixture } from '../test/fixture';
import { accounts, accountBalances, accountTerms } from '../db/schema';
import { parseTab, periodEndForTab, importSheet, type Grid } from './sheet';

const header = (offset: number) => { const r: (string | null)[] = Array(offset + 8).fill(null); r[offset + 1] = 'Balance'; r[offset + 2] = 'Int. Charges'; r[offset + 3] = 'Int. Rate'; r[offset + 4] = 'Daily Int.'; r[offset + 5] = 'Monthly Int.'; r[offset + 6] = 'Yearly Int.'; r[offset + 7] = 'Ann. Fee'; return r; };
const debt = (offset: number, name: string, bal: string, rate: string, fee: string, open: string) => { const r: (string | null)[] = Array(offset + 9).fill(null); r[offset] = name; r[offset + 1] = bal; r[offset + 3] = rate; r[offset + 7] = fee; r[offset + 8] = open; return r; };
function tab(offset = 15): Grid {
	return [
		['8', null], [null, 'Pay Period Days', '11'],
		header(offset),
		debt(offset, 'Sweetwater', '$ (419.99)', '34.99%', '$ -', '6/20/14'),
		[null, 'Water', '$ (113.23)', null, null, null, null, null, null, null, null, 'Checking', '$ 3,699.13', ...Array(offset - 13).fill(null), 'Sapphire', '$ (11,179.26)', '$ (11,179.26)', '27.74%', '$ (8.50)', '$ (254.89)', '$ (3,058.65)', '$ 95.00', '7/11/18'],
		debt(offset, 'Apple', '', '26.49%', '', '8/31/07'),
		debt(offset, '[merged] Credit Cards', '', '', '', ''),
		Array(offset + 9).fill(null), Array(offset + 9).fill(null)
	];
}
describe('parseTab', () => {
	it('reads the balances block by header, checking by label, and normalises money, rate, and dates', () => {
		const p = parseTab(tab());
		expect(p.checking).toBe(369913);
		expect(p.debts).toEqual([
			{ name: 'Sweetwater', balance: -41999, aprBps: 3499, annualFee: null, openedOn: '2014-06-20' },
			{ name: 'Sapphire', balance: -1117926, aprBps: 2774, annualFee: 9500, openedOn: '2018-07-11' },
			{ name: 'Apple', balance: 0, aprBps: 2649, annualFee: null, openedOn: '2007-08-31' }
		]);
		expect(parseTab(tab(13)).debts.map((d) => d.name)).toEqual(['Sweetwater', 'Sapphire', 'Apple']);   // column offset differs per tab
	});
});
describe('periodEndForTab', () => {
	it('maps PP numbers and date ranges to semi-monthly period ends', () => {
		expect(periodEndForTab('PP 1', 2026)).toBe('2026-01-15'); expect(periodEndForTab('PP 2', 2026)).toBe('2026-01-31');
		expect(periodEndForTab('PP 4', 2026)).toBe('2026-02-28'); expect(periodEndForTab('4/1 - 4/15', 2026)).toBe('2026-04-15');
		expect(periodEndForTab('7/16-7/31', 2026)).toBe('2026-07-31'); expect(periodEndForTab('Summary', 2026)).toBeNull();
	});
});
describe('importSheet', () => {
	it('writes import balances, manual terms on APR change, opened_on once, and is idempotent', () => {
		const f = fixture();
		const t1 = tab(); const t2 = tab(); t2[3] = debt(15, 'Sweetwater', '$ (361.99)', '34.99%', '$ -', '6/20/14'); t2[4][16] = '$ (11,658.63)'; t2[4][18] = '27.49%';
		const tabs = [{ name: 'PP 2', grid: t2 }, { name: 'PP 1', grid: t1 }, { name: 'Summary', grid: [['x']] }];
		const r = importSheet(f.db, tabs, { year: 2026, mapping: { Sapphire: f.card }, checkingAccountId: f.checking });
		expect(r.ignoredTabs).toEqual(['Summary']); expect(r.unmapped.sort()).toEqual(['Apple', 'Sweetwater']);
		expect(r.tabs.map((t) => [t.name, t.date, t.balances, t.terms])).toEqual([['PP 1', '2026-01-15', 2, 1], ['PP 2', '2026-01-31', 2, 1]]);
		const bals = f.db.select().from(accountBalances).where(eq(accountBalances.accountId, f.card)).all();
		expect(bals.map((b) => [b.asOf, b.current, b.source])).toEqual([['2026-01-15', -1117926, 'import'], ['2026-01-31', -1165863, 'import']]);
		const terms = f.db.select().from(accountTerms).where(eq(accountTerms.accountId, f.card)).all();
		expect(terms.map((t) => [t.asOf, t.aprBps, t.annualFee, t.source])).toEqual([['2026-01-15', 2774, 9500, 'manual'], ['2026-01-31', 2749, 9500, 'manual']]);
		expect(f.db.select().from(accounts).where(eq(accounts.id, f.card)).get()!.openedOn).toBe('2018-07-11');
		expect(f.db.select().from(accountBalances).where(eq(accountBalances.accountId, f.checking)).all().map((b) => b.current)).toEqual([369913, 369913]);
		importSheet(f.db, tabs, { year: 2026, mapping: { Sapphire: f.card }, checkingAccountId: f.checking });
		expect(f.db.select().from(accountBalances).all()).toHaveLength(4); expect(f.db.select().from(accountTerms).all()).toHaveLength(2);
	});
});
