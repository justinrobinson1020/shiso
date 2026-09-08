import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, accountBalances, accountTerms } from '../db/schema';
import { appendBalance, latestTerms, updateAccount } from '../sync/connections';
import { decimalToCents } from '$lib/money';
import { endOfMonth } from '$lib/dates';

export type Cell = string | number | null | undefined; export type Grid = Cell[][];
export type TabDebt = { name: string; balance: number; aprBps: number | null; annualFee: number | null; openedOn: string | null };
export type ParsedTab = { checking: number | null; debts: TabDebt[] };
export type ImportReport = { tabs: { name: string; date: string; balances: number; terms: number; skipped: string[] }[]; unmapped: string[]; ignoredTabs: string[] };

const HEADER = ['Balance', 'Int. Charges', 'Int. Rate', 'Daily Int.', 'Monthly Int.', 'Yearly Int.', 'Ann. Fee'];
const text = (c: Cell) => (c == null ? '' : String(c).trim());
/** `$ (1,234.56)` → -123456; `$ -` or empty → null; numbers pass through. */
export function money(c: Cell): number | null {
	if (typeof c === 'number') return decimalToCents(c);
	const s = text(c); if (s === '' || /^\$?\s*-\s*$/.test(s)) return null;
	return decimalToCents(s);
}
export function rateBps(c: Cell): number | null { if (typeof c === 'number') return Math.round(c * 10000); const s = text(c).replace('%', ''); return s === '' ? null : Math.round(parseFloat(s) * 100); }
export function usDate(c: Cell): string | null {
	const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text(c)); if (!m) return null;
	const y = m[3].length === 4 ? +m[3] : +m[3] < 70 ? 2000 + +m[3] : 1900 + +m[3];
	return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
export function parseTab(grid: Grid): ParsedTab {
	let headerRow = -1, balanceCol = -1;
	for (let r = 0; r < grid.length && headerRow < 0; r++) {
		const row = grid[r] ?? [];
		for (let c = 0; c < row.length; c++) if (HEADER.every((h, i) => text(row[c + i]) === h)) { headerRow = r; balanceCol = c; break; }
	}
	const debts: TabDebt[] = [];
	if (headerRow >= 0) {
		const nameCol = balanceCol - 1; let blank = 0;
		for (let r = headerRow + 1; r < grid.length; r++) {
			const row = grid[r] ?? []; const name = text(row[nameCol]);
			if (name === '' && text(row[balanceCol]) === '') { if (++blank >= 2) break; continue; }
			blank = 0;
			if (name === '' || name.startsWith('[merged]') || name.startsWith('\\[merged')) continue;
			debts.push({ name, balance: money(row[balanceCol]) ?? 0, aprBps: rateBps(row[balanceCol + 2]), annualFee: money(row[balanceCol + 6]), openedOn: usDate(row[balanceCol + 7]) });
		}
	}
	let checking: number | null = null;
	outer: for (const row of grid) for (let c = 0; c < (row?.length ?? 0); c++) if (text(row[c]) === 'Checking') { const v = money(row[c + 1]); if (v != null) { checking = v; break outer; } }
	return { checking, debts };
}
export function periodEndForTab(tabName: string, year: number): string | null {
	const pp = /^PP\s*(\d{1,2})$/i.exec(tabName.trim());
	if (pp) { const n = +pp[1]; if (n < 1 || n > 24) return null; const month = String(Math.ceil(n / 2)).padStart(2, '0'); return n % 2 === 1 ? `${year}-${month}-15` : endOfMonth(`${year}-${month}-01`); }
	const range = /(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})/.exec(tabName);
	if (range) return `${year}-${range[3].padStart(2, '0')}-${range[4].padStart(2, '0')}`;
	return null;
}
export function importSheet(db: DbOrTx, tabs: { name: string; grid: Grid }[], opts: { year: number; mapping: Record<string, number>; checkingAccountId: number | null }): ImportReport {
	const dated = tabs.map((t) => ({ ...t, date: periodEndForTab(t.name, opts.year) })).filter((t): t is typeof t & { date: string } => t.date != null).sort((a, b) => a.date.localeCompare(b.date));
	const ignoredTabs = tabs.filter((t) => periodEndForTab(t.name, opts.year) == null).map((t) => t.name);
	const unmapped = new Set<string>(); const lastApr = new Map<number, number | null>(); const report: ImportReport['tabs'] = [];
	const hasBalance = (accountId: number, asOf: string, current: number) => !!db.select({ id: accountBalances.id }).from(accountBalances).where(and(eq(accountBalances.accountId, accountId), eq(accountBalances.asOf, asOf), eq(accountBalances.source, 'import'), eq(accountBalances.current, current))).get();
	const hasTerms = (accountId: number, asOf: string) => !!db.select({ id: accountTerms.id }).from(accountTerms).where(and(eq(accountTerms.accountId, accountId), eq(accountTerms.asOf, asOf), eq(accountTerms.source, 'manual'))).get();
	for (const t of dated) {
		const p = parseTab(t.grid); let balances = 0, terms = 0; const skipped: string[] = [];
		for (const d of p.debts) {
			const accountId = opts.mapping[d.name]; if (accountId == null) { unmapped.add(d.name); continue; }
			if (!hasBalance(accountId, t.date, d.balance)) { appendBalance(db, accountId, { asOf: t.date, current: d.balance, source: 'import' }); balances++; } else skipped.push(`${d.name} balance`);
			const prevApr = lastApr.has(accountId) ? lastApr.get(accountId) : (latestTerms(db, accountId)?.aprBps ?? undefined);
			if (d.aprBps != null && d.aprBps !== prevApr) {
				if (!hasTerms(accountId, t.date)) { db.insert(accountTerms).values({ accountId, asOf: t.date, aprBps: d.aprBps, annualFee: d.annualFee, source: 'manual' }).run(); terms++; } else skipped.push(`${d.name} terms`);
			}
			lastApr.set(accountId, d.aprBps);
			if (d.openedOn && db.select({ o: accounts.openedOn }).from(accounts).where(eq(accounts.id, accountId)).get()?.o == null) updateAccount(db, accountId, { openedOn: d.openedOn });
		}
		if (p.checking != null && opts.checkingAccountId != null) { if (!hasBalance(opts.checkingAccountId, t.date, p.checking)) { appendBalance(db, opts.checkingAccountId, { asOf: t.date, current: p.checking, source: 'import' }); balances++; } else skipped.push('Checking balance'); }
		report.push({ name: t.name, date: t.date, balances, terms, skipped });
	}
	return { tabs: report, unmapped: [...unmapped], ignoredTabs };
}
