# Shiso Plan 5: Account history import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import two years of bank and card history from CSV exports and PDF statements through the app's per-account import route, without duplicating synced rows, breaking the ledger-equals-balance invariant, or disturbing the live budget.

**Architecture:** Five format parsers produce one `ParsedFile` shape; an import core dedups against synced rows (exact id, then amount within ±3 days), appends statement balances, and corrects the account's opening-balance row; a `budget_start` setting fences envelope math off from history. The route detects the format (PDFs go through `pdftotext` first), and a shell script drives the one-time backfill.

**Tech Stack:** SvelteKit 2 / Svelte 5, better-sqlite3 + drizzle, csv-parse, vitest + fast-check, poppler `pdftotext` on the server.

**Spec:** `docs/superpowers/specs/2026-09-11-shiso-phase5-history-import-design.md`. Conventions are Plan 1C's (`docs/superpowers/plans/2026-09-08-shiso-1c-screens.md` §Conventions).

## Global Constraints

- All amounts are integer cents from the account's point of view: a card purchase is negative, a payment to the card positive; a card's owed balance is stored negative (matching the existing opening rows, e.g. `-1134716`).
- `ParsedStatement.previousBalance` / `newBalance` are account point of view too, so reconciliation is `previousBalance + Σ row.amount === newBalance` in one convention.
- Rows whose amount is 0 are dropped by every parser (Synchrony prints `$0.00` interest lines).
- Error mapping: `ImportError` with code `unknown_format` | `mask_mismatch` | `reconcile` becomes a `ValidationError` (400) in the route; code `pdf` is rethrown (500).
- Every task ends with `npm test` and `npm run check` green and one commit. Commit messages: conventional, single subject line, no reference to AI tooling.
- Never read or print `.env`.
- Use zsh for shell commands.

---

## File structure

```
src/lib/server/import/formats/types.ts        ParsedFile, ParsedRow, ParsedStatement, ImportError
src/lib/server/import/formats/dates.ts        usDateToIso, statementRowDate, dollars
src/lib/server/import/formats/apple.ts        parseAppleCardCsv (moved from sync/import/csv.ts) + APPLE_HEADER
src/lib/server/import/formats/capital-one.ts  parseCapitalOneCsv + CAPITAL_ONE_HEADER
src/lib/server/import/formats/nasa-fcu.ts     parseNasaFcuCsv + NASA_HEADER (row-level reconciliation)
src/lib/server/import/formats/chase.ts        isChaseStatement, parseChaseStatement
src/lib/server/import/formats/synchrony.ts    isSynchronyStatement, parseSynchronyStatement
src/lib/server/import/formats/detect.ts       parseText(text), detectAndParse(bytes)
src/lib/server/import/formats/fixtures/*      test inputs (text)
src/lib/server/import/pdf.ts                  pdfToText(bytes)
src/lib/server/import/statement.ts            importParsed, reconcileStatement, ImportReport
src/lib/server/sync/import/csv.ts             deleted in Task 6
src/lib/server/budget/envelope.ts, load.ts    budgetStart on BudgetInput
src/lib/server/settings.ts                    BUDGET_START_KEY, budgetStart(db)
src/lib/server/startup.ts                     pin budget_start
src/lib/server/ledger/assignments.ts          assertBudgetPeriod
src/lib/server/read/budget.ts                 historyOnly view
src/routes/budget/+page.svelte                history notice
src/routes/api/accounts/[id]/import/+server.ts
src/routes/accounts/+page.svelte
scripts/import-history.sh
docs/deploy.md, README.md, spec status
```

---

### Task 1: Format types, date/money helpers, Apple parser moved

**Files:**
- Create: `src/lib/server/import/formats/types.ts`, `src/lib/server/import/formats/dates.ts`, `src/lib/server/import/formats/dates.test.ts`, `src/lib/server/import/formats/apple.ts`, `src/lib/server/import/formats/apple.test.ts`
- Modify: `src/lib/server/sync/import/csv.ts` (import `parseAppleCardCsv` from the new module; keep `importCsv` until Task 6), `src/lib/server/sync/import/csv.test.ts` (drop the `parseAppleCardCsv` describe block, now in `apple.test.ts`)

**Interfaces produced:**
```ts
// types.ts
export type ImportFormat = 'apple' | 'capital_one' | 'nasa_fcu' | 'chase' | 'synchrony';
export type ParsedRow = { postedDate: string; transactedAt: string | null; amount: number; payeeRaw: string; memo: string | null; providerCategory: string | null; referenceId: string | null };
export type ParsedStatement = { opensOn: string; closesOn: string; previousBalance: number; newBalance: number };
export type ParsedBalance = { asOf: string; current: number };
export type ParsedFile = { format: ImportFormat; mask: string | null; statement: ParsedStatement | null; rows: ParsedRow[]; balances: ParsedBalance[] };
export type ImportErrorCode = 'unknown_format' | 'mask_mismatch' | 'reconcile' | 'pdf';
export class ImportError extends Error { constructor(public readonly code: ImportErrorCode, message: string) { super(message); this.name = 'ImportError'; } }
// dates.ts
export function usDateToIso(s: string): string          // "9/8/2026" | "09/08/2026" | "10/21/25" → "2026-09-08"; throws on anything else
export function statementRowDate(mmdd: string, closesOn: string): string  // "12/05" with closesOn "2025-01-02" → "2024-12-05"
export function dollars(s: string): number              // "-$1,234.56" | "1,234.56" | "$0.00" → cents
// apple.ts
export const APPLE_HEADER: readonly string[];
export function parseAppleCardCsv(text: string): ParsedFile;   // format 'apple', mask null, statement null, balances []
```

- [ ] **Step 1: Write the failing tests** — `dates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { usDateToIso, statementRowDate, dollars } from './dates';
describe('dates', () => {
	it('parses US dates with 2- or 4-digit years and single-digit parts', () => {
		expect(usDateToIso('9/8/2026')).toBe('2026-09-08'); expect(usDateToIso('09/08/2026')).toBe('2026-09-08'); expect(usDateToIso('10/21/25')).toBe('2025-10-21');
		expect(() => usDateToIso('2026-09-08')).toThrow(/date/);
	});
	it('dates statement rows from the closing date with December wraparound', () => {
		expect(statementRowDate('12/05', '2025-01-02')).toBe('2024-12-05'); expect(statementRowDate('01/01', '2025-01-02')).toBe('2025-01-01'); expect(statementRowDate('08/02', '2026-08-02')).toBe('2026-08-02');
	});
	it('reads printed dollar amounts as cents', () => {
		expect(dollars('-$1,234.56')).toBe(-123456); expect(dollars('1,234.56')).toBe(123456); expect(dollars('$0.00')).toBe(0); expect(dollars('-2,466.61')).toBe(-246661);
	});
});
```
`apple.test.ts`: move the existing `parseAppleCardCsv` describe block from `sync/import/csv.test.ts` verbatim, changing the import to `./apple` and the first assertion to expect the row plus `referenceId: null` and the file shape `{ format: 'apple', mask: null, statement: null, balances: [] }` (rows accessed as `parseAppleCardCsv(CSV).rows`).

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/server/import/formats` → fails: modules not found.

- [ ] **Step 3: Implement** — `dates.ts`:

```ts
import { decimalToCents } from '$lib/money';
export function usDateToIso(s: string): string {
	const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s.trim());
	if (!m) throw new Error(`bad date: ${s}`);
	const y = m[3].length === 4 ? +m[3] : 2000 + +m[3];
	return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
/** Chase and Synchrony print MM/DD; the year is the closing date's, one less when the month is later than the closing month. */
export function statementRowDate(mmdd: string, closesOn: string): string {
	const m = /^(\d\d)\/(\d\d)$/.exec(mmdd); if (!m) throw new Error(`bad row date: ${mmdd}`);
	const closeYear = +closesOn.slice(0, 4), closeMonth = +closesOn.slice(5, 7);
	const year = +m[1] > closeMonth ? closeYear - 1 : closeYear;
	return `${year}-${m[1]}-${m[2]}`;
}
export function dollars(s: string): number { return decimalToCents(s.replace(/[$,\s]/g, '')); }
```
`apple.ts`: the body of `parseAppleCardCsv` from `csv.ts`, returning `{ format: 'apple', mask: null, statement: null, rows: records.map(... , referenceId: null), balances: [] }`; export `APPLE_HEADER` = the current `REQUIRED` array. `types.ts` as in Interfaces. In `csv.ts`, delete the local parser and `import { parseAppleCardCsv } from '../../import/formats/apple'`; `importCsv` uses `parseAppleCardCsv(text).rows`.

- [ ] **Step 4: Run** — `npm test` → all green (csv.test.ts `importCsv` tests still pass).
- [ ] **Step 5: Commit** — `git commit -m "refactor: import format types and the Apple Card parser under import/formats"`

---

### Task 2: Capital One and NASA FCU CSV parsers

**Files:** Create `formats/capital-one.ts`, `formats/capital-one.test.ts`, `formats/nasa-fcu.ts`, `formats/nasa-fcu.test.ts`.

**Interfaces produced:**
```ts
export const CAPITAL_ONE_HEADER = ['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit'] as const;
export function parseCapitalOneCsv(text: string): ParsedFile;    // format 'capital_one', mask = Card No., rows oldest first
export const NASA_HEADER = ['Transaction ID', 'Posting Date', 'Effective Date', 'Amount', 'Description', 'Balance'] as const;
export function parseNasaFcuCsv(text: string): ParsedFile;       // format 'nasa_fcu', mask null, referenceId 'nasa:<Transaction ID>', month-end balances, throws ImportError('reconcile') on a running-balance break
```

- [ ] **Step 1: Write the failing tests**

```ts
// capital-one.test.ts
import { describe, it, expect } from 'vitest';
import { parseCapitalOneCsv } from './capital-one';
const CSV = `Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
2026-09-06,2026-09-07,2414,PRISMADICAI,Merchandise,50.00,
2026-08-21,2026-08-21,2414,CAPITAL ONE MOBILE PYMT,Payment/Credit,,72.00
`;
describe('parseCapitalOneCsv', () => {
	it('maps debit and credit columns to signed cents, oldest first, with the card mask', () => {
		const f = parseCapitalOneCsv(CSV);
		expect(f).toMatchObject({ format: 'capital_one', mask: '2414', statement: null, balances: [] });
		expect(f.rows).toEqual([
			{ postedDate: '2026-08-21', transactedAt: '2026-08-21T00:00:00Z', amount: 7200, payeeRaw: 'CAPITAL ONE MOBILE PYMT', memo: null, providerCategory: 'Payment/Credit', referenceId: null },
			{ postedDate: '2026-09-07', transactedAt: '2026-09-06T00:00:00Z', amount: -5000, payeeRaw: 'PRISMADICAI', memo: null, providerCategory: 'Merchandise', referenceId: null }
		]);
	});
	it('rejects an unknown header', () => { expect(() => parseCapitalOneCsv('Date,Amount\n1,2')).toThrow(/header/); });
});
```
```ts
// nasa-fcu.test.ts
import { describe, it, expect } from 'vitest';
import { parseNasaFcuCsv } from './nasa-fcu';
import { ImportError } from './types';
const HEAD = `"Transaction ID","Posting Date","Effective Date","Transaction Type","Posting Status","Amount","Check Number","Reference Number","Description","Transaction Category","Type","Balance","Memo","Extended Description"`;
const CSV = `${HEAD}
"20260902 1","9/2/2026","9/2/2026","Debit","Posted","-21.20000","","1","Transfer to PayPal","Transfers","ACH","2168.92000","","PAYPAL TYPE: PURCHASE"
"20260831 2","8/31/2026","8/30/2026","Credit","Posted","1500.00000","","2","Payroll","Paychecks/Salary","ACH","2190.12000","","Payroll"
"20260830 3","8/30/2026","8/30/2026","Debit","Posted","-60.00000","","3","Withdrawal Zelle","","","690.12000","","Withdrawal Zelle"
"20260815 4","8/15/2026","8/15/2026","Debit","Posted","-10.00000","","4","Coffee","Restaurants & Dining","Card","750.12000","","Coffee"
`;
describe('parseNasaFcuCsv', () => {
	it('reads signed amounts, stable ids, memo only when it adds something, and month-end balances', () => {
		const f = parseNasaFcuCsv(CSV);
		expect(f).toMatchObject({ format: 'nasa_fcu', mask: null, statement: null });
		expect(f.rows.map((r) => [r.postedDate, r.transactedAt, r.amount, r.payeeRaw, r.memo, r.providerCategory, r.referenceId])).toEqual([
			['2026-08-15', '2026-08-15T00:00:00Z', -1000, 'Coffee', null, 'Restaurants & Dining', 'nasa:20260815 4'],
			['2026-08-30', '2026-08-30T00:00:00Z', -6000, 'Withdrawal Zelle', null, null, 'nasa:20260830 3'],
			['2026-08-31', '2026-08-30T00:00:00Z', 150000, 'Payroll', null, 'Paychecks/Salary', 'nasa:20260831 2'],
			['2026-09-02', '2026-09-02T00:00:00Z', -2120, 'Transfer to PayPal', 'PAYPAL TYPE: PURCHASE', 'Transfers', 'nasa:20260902 1']
		]);
		expect(f.balances).toEqual([{ asOf: '2026-08-31', current: 219012 }, { asOf: '2026-09-02', current: 216892 }]);
	});
	it('rejects a running-balance break as a reconciliation error naming the row', () => {
		const broken = CSV.replace('"690.12000"', '"690.13000"');
		expect(() => parseNasaFcuCsv(broken)).toThrow(ImportError);
		expect(() => parseNasaFcuCsv(broken)).toThrow(/8\/31\/2026.*Payroll/);
	});
	it('rejects an unknown header', () => { expect(() => parseNasaFcuCsv('Date,Amount\n1,2')).toThrow(/header/); });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/server/import/formats` → module not found.

- [ ] **Step 3: Implement**

```ts
// capital-one.ts
import { parse } from 'csv-parse/sync';
import type { ParsedFile, ParsedRow } from './types';
import { dollars } from './dates';
export const CAPITAL_ONE_HEADER = ['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit'] as const;
export function parseCapitalOneCsv(text: string): ParsedFile {
	const records = parse(text, { columns: true, skip_empty_lines: true, bom: true, trim: true }) as Record<string, string>[];
	const header = records.length ? Object.keys(records[0]) : (text.split(/\r?\n/)[0]?.split(',') ?? []);
	if (!CAPITAL_ONE_HEADER.every((c) => header.includes(c))) throw new Error('unrecognised CSV header: expected Capital One export columns');
	const rows: ParsedRow[] = records.map((r) => ({
		postedDate: r['Posted Date'], transactedAt: r['Transaction Date'] ? `${r['Transaction Date']}T00:00:00Z` : null,
		amount: dollars(r['Credit'] || '0') - dollars(r['Debit'] || '0'),
		payeeRaw: r['Description'], memo: null, providerCategory: r['Category'] || null, referenceId: null
	})).filter((r) => r.amount !== 0).reverse();
	return { format: 'capital_one', mask: records[0]?.['Card No.'] || null, statement: null, rows, balances: [] };
}
```
```ts
// nasa-fcu.ts
import { parse } from 'csv-parse/sync';
import { ImportError, type ParsedBalance, type ParsedFile, type ParsedRow } from './types';
import { dollars, usDateToIso } from './dates';
export const NASA_HEADER = ['Transaction ID', 'Posting Date', 'Effective Date', 'Amount', 'Description', 'Balance'] as const;
export function parseNasaFcuCsv(text: string): ParsedFile {
	const records = parse(text, { columns: true, skip_empty_lines: true, bom: true, trim: true }) as Record<string, string>[];
	const header = records.length ? Object.keys(records[0]) : (text.split(/\r?\n/)[0]?.replace(/"/g, '').split(',') ?? []);
	if (!NASA_HEADER.every((c) => header.includes(c))) throw new Error('unrecognised CSV header: expected NASA FCU export columns');
	// File order is newest first; each row's Balance is the balance after it.
	const parsed = records.map((r) => ({
		postedDate: usDateToIso(r['Posting Date']), transactedAt: r['Effective Date'] ? `${usDateToIso(r['Effective Date'])}T00:00:00Z` : null,
		amount: dollars(r['Amount']), balance: dollars(r['Balance']), payeeRaw: r['Description'],
		memo: r['Extended Description'] && r['Extended Description'] !== r['Description'] ? r['Extended Description'] : null,
		providerCategory: r['Transaction Category'] || null, referenceId: `nasa:${r['Transaction ID']}`, raw: r
	}));
	for (let i = 0; i + 1 < parsed.length; i++) {
		const cur = parsed[i], prev = parsed[i + 1];
		if (prev.balance + cur.amount !== cur.balance)
			throw new ImportError('reconcile', `does not reconcile at ${cur.raw['Posting Date']} ${cur.payeeRaw}: balance ${cur.balance} ≠ previous ${prev.balance} + amount ${cur.amount}`);
	}
	const balances: ParsedBalance[] = []; const months = new Set<string>();
	for (const p of parsed) { const ym = p.postedDate.slice(0, 7); if (!months.has(ym)) { months.add(ym); balances.push({ asOf: p.postedDate, current: p.balance }); } }
	const rows: ParsedRow[] = parsed.filter((p) => p.amount !== 0).map(({ balance: _b, raw: _r, ...row }) => row).reverse();
	return { format: 'nasa_fcu', mask: null, statement: null, rows, balances: balances.reverse() };
}
```

- [ ] **Step 4: Run** — `npx vitest run src/lib/server/import/formats` → green.
- [ ] **Step 5: Commit** — `git commit -m "feat: Capital One and NASA FCU CSV parsers"`

---

### Task 3: Chase statement parser

**Files:** Create `formats/chase.ts`, `formats/chase.test.ts`, `formats/fixtures/chase-dec-jan.txt`, `formats/fixtures/chase-empty.txt`.

**Interfaces produced:**
```ts
export function isChaseStatement(text: string): boolean;        // /chase\.com/i && /Opening\/Closing Date/
export function parseChaseStatement(text: string): ParsedFile;  // format 'chase'; mask from "Account Number: XXXX XXXX XXXX 1403"; statement + one closing balance
```

- [ ] **Step 1: Fixtures** — `fixtures/chase-dec-jan.txt` (spaces, not tabs; the layout matters only in that every row is `MM/DD`, description, amount on one line):

```
                                          Manage your account online at:  www.chase.com/cardhelp
    Account Number: XXXX XXXX XXXX 1403
    Previous Balance                                                               $2,314.39
    Payment, Credits                                                              -$2,466.61
    Purchases                                                                     +$2,051.88
    New Balance                                                                    $1,899.66
    Opening/Closing Date                                               12/03/24 - 01/02/25
 ACCOUNT ACTIVITY
    Date of
  Transaction                     Merchant Name or Transaction Description                        $ Amount
 PAYMENTS AND OTHER CREDITS
  12/17                     Payment Thank You Bill Pay Service                                    -2,466.61
 PURCHASE
  12/05                     UBER *EATS HELP.UBER.COM CA                                               95.26
  12/05                     UBER *EATS HELP.UBER.COM CA                                               95.26
  12/28                     TST*KYOJIN SUSHI Washington DC                                           363.68
  01/01                     COSTCO WHSE #1120 WASHINGTON DC                                        1,497.68
                            Order Number 112-1234567-1234567
                                                             2025 Totals Year-to-Date
                                        Total fees charged in 2025                              $0.00
 INTEREST CHARGES
   Purchases                                         27.49%(v)(d)              -                 $4,052.09               $91.56
```
`fixtures/chase-empty.txt`:
```
                                          Manage your account online at:  www.chase.com/cardhelp
    Account Number: XXXX XXXX XXXX 0856
    Previous Balance                                                           $0.00
    New Balance                                                                $0.00
    Opening/Closing Date                                      12/18/24 - 01/17/25
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isChaseStatement, parseChaseStatement } from './chase';
const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
describe('parseChaseStatement', () => {
	it('reads mask, dates, balances, and every activity row with the year from the closing date', () => {
		const f = parseChaseStatement(fx('chase-dec-jan.txt'));
		expect(isChaseStatement(fx('chase-dec-jan.txt'))).toBe(true);
		expect(f.format).toBe('chase'); expect(f.mask).toBe('1403');
		expect(f.statement).toEqual({ opensOn: '2024-12-03', closesOn: '2025-01-02', previousBalance: -231439, newBalance: -189966 });
		expect(f.balances).toEqual([{ asOf: '2025-01-02', current: -189966 }]);
		expect(f.rows.map((r) => [r.postedDate, r.amount, r.payeeRaw, r.providerCategory])).toEqual([
			['2024-12-17', 246661, 'Payment Thank You Bill Pay Service', 'PAYMENTS AND OTHER CREDITS'],
			['2024-12-05', -9526, 'UBER *EATS HELP.UBER.COM CA', 'PURCHASE'],
			['2024-12-05', -9526, 'UBER *EATS HELP.UBER.COM CA', 'PURCHASE'],
			['2024-12-28', -36368, 'TST*KYOJIN SUSHI Washington DC', 'PURCHASE'],
			['2025-01-01', -149768, 'COSTCO WHSE #1120 WASHINGTON DC', 'PURCHASE']
		]);
		expect(f.rows.every((r) => r.transactedAt === null && r.memo === null && r.referenceId === null)).toBe(true);
		// the fixture reconciles: previous + Σ rows = new
		expect(f.statement!.previousBalance + f.rows.reduce((s, r) => s + r.amount, 0)).toBe(f.statement!.newBalance);
	});
	it('treats a statement with no activity block as zero rows', () => {
		const f = parseChaseStatement(fx('chase-empty.txt'));
		expect(f.rows).toEqual([]); expect(f.mask).toBe('0856');
		expect(f.statement).toEqual({ opensOn: '2024-12-18', closesOn: '2025-01-17', previousBalance: 0, newBalance: 0 });
		expect(f.balances).toEqual([{ asOf: '2025-01-17', current: 0 }]);
	});
	it('fails loudly without an opening/closing date', () => { expect(() => parseChaseStatement('chase.com\nnothing here')).toThrow(/Opening\/Closing/); });
});
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run src/lib/server/import/formats/chase` → module not found.

- [ ] **Step 4: Implement**

```ts
import type { ParsedFile, ParsedRow } from './types';
import { dollars, statementRowDate, usDateToIso } from './dates';
const ROW = /^\s*(\d\d\/\d\d)\s+(.+?)\s+(-?[\d,]+\.\d\d)\s*$/;
const SECTIONS = new Set(['PAYMENTS AND OTHER CREDITS', 'PURCHASE', 'FEES CHARGED', 'INTEREST CHARGED']);
export function isChaseStatement(text: string): boolean { return /chase\.com/i.test(text) && /Opening\/Closing Date/.test(text); }
function money(re: RegExp, text: string, what: string): number { const m = re.exec(text); if (!m) throw new Error(`chase statement: no ${what}`); return dollars(m[1]); }
export function parseChaseStatement(text: string): ParsedFile {
	const oc = /Opening\/Closing Date[ \t]+(\d\d\/\d\d\/\d\d)[ \t]*-[ \t]*(\d\d\/\d\d\/\d\d)/.exec(text);
	if (!oc) throw new Error('chase statement: no Opening/Closing Date');
	const opensOn = usDateToIso(oc[1]), closesOn = usDateToIso(oc[2]);
	const previousBalance = -money(/^[ \t]*Previous Balance[ \t]+(-?\$[\d,]+\.\d\d)/m, text, 'Previous Balance');
	const newBalance = -money(/^[ \t]*New Balance[ \t]+(-?\$[\d,]+\.\d\d)[ \t]*$/m, text, 'New Balance');
	const mask = /Account Number:[ \t]+(?:X{4}[ \t]+){3}(\d{4})/.exec(text)?.[1] ?? null;
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((l) => l.includes('ACCOUNT ACTIVITY'));
	const rows: ParsedRow[] = [];
	if (start >= 0) {
		let section: string | null = null;
		for (let i = start + 1; i < lines.length; i++) {
			const line = lines[i]; if (line.includes('Totals Year-to-Date')) break;
			const t = line.trim(); if (SECTIONS.has(t)) { section = t; continue; }
			const m = ROW.exec(line); if (!m) continue;
			const amount = -dollars(m[3]); if (amount === 0) continue;
			rows.push({ postedDate: statementRowDate(m[1], closesOn), transactedAt: null, amount, payeeRaw: m[2].replace(/\s+/g, ' ').trim(), memo: null, providerCategory: section, referenceId: null });
		}
	}
	return { format: 'chase', mask, statement: { opensOn, closesOn, previousBalance, newBalance }, rows, balances: [{ asOf: closesOn, current: newBalance }] };
}
```
`[ \t]` rather than `\s` in the balance patterns: "New Balance" also appears alone on a line in the page-1 summary box with the amount two lines later; `\s+` would jump the newline.

- [ ] **Step 5: Run** — green. Then sanity-check against the real files (not committed): `for f in account-history/chase-*/*.pdf; do pdftotext -layout "$f" - ; done | wc -l` is enough to confirm pdftotext works; the reconciliation over all 82 statements is exercised in Task 9's dry run.
- [ ] **Step 6: Commit** — `git commit -m "feat: Chase statement parser"`

---

### Task 4: Synchrony statement parser (Amazon Store Card and PayPal Credit layouts)

**Files:** Create `formats/synchrony.ts`, `formats/synchrony.test.ts`, `formats/fixtures/synchrony-amazon.txt`, `formats/fixtures/synchrony-paypal.txt`.

**Interfaces produced:**
```ts
export function isSynchronyStatement(text: string): boolean;        // /synchrony|SYNCB/i
export function parseSynchronyStatement(text: string): ParsedFile;  // format 'synchrony'
```

- [ ] **Step 1: Fixtures** — `synchrony-amazon.txt`:
```
                                                    Account Number ending in 7672
Previous Balance as of 10/22/2025                                                   $857.25         Credit Limit   $2,800
New Balance as of 11/20/2025                                                        $568.64
Payments                                                                          -$288.61
11/04    P9342009M00XS6H11                  ONLINE PYMT-THANK YOU ATLANTA               GA          -$288.61
10/25    P9342009BEHM6S9PZ                  AMAZON RETAIL SEATTLE WA                                 -$26.48
Purchases and Other Debits                                                                             $26.48
10/21    P93420097EHM6S9PT                  AMAZON RETAIL SEATTLE WA                                  $26.48
Total Fees Charged This Period                                                                          $0.00
Total Interest Charged This Period                                                                      $0.00
11/20                                       INTEREST CHARGE ON PURCHASES                              $0.00
                                                                2025 Year-to-Date Fees and Interest
Interest Charge Calculation
Purchases                                     N/A                   29.49% (v)                      $144.19                          $3.61
12 EQUAL MONTHLY PAYMENTS 0%             Until Paid Off              0.00%                             $9.43                         $0.00
Manage your account online at synchrony.com/amazon.
```
`synchrony-paypal.txt`:
```
Statement Closing Date: 10/27/25                                       View your account online at paypal.com
Days in Billing Period: 31
Account Number: xxxx xxxx xxxx 8182
ACCOUNT SUMMARY
Previous Balance                                                                  $1,681.27
- Payments & Credits                                                                $789.37
+ Purchases & Adjustments                                                         $3,083.39
+ Fees                                                                                $2.00
= New Balance                                                                     $3,977.29
PAYMENTS & CREDITS
Tran Date                Posting Date   Reference Number                 Description                                     Amount
10/21/25                 10/21/25       P928300970122QF2N                Online Payment Thank You                      -$789.37
                                                                         Alpharetta Ga
PURCHASES & ADJUSTMENTS
Tran Date                Posting Date   Reference Number          Type           Description                            Amount
10/01/25                 10/03/25       P9283008KEHM6QAA9         Deferred       CHANGWANGWE            No Interest If Paid In Full     $398.99
10/08/25                 10/08/25       P9283008SEHM6B0MN         Deferred       TICKETMASTER           No Interest If Paid In Full   $2,684.40
FEES
Tran Date                Posting Date   Description                                                                     Amount
10/27/25                 10/27/25       Minimum Interest Charge                                                           $2.00
2025 Totals Year-To-Date
Purchases                                     N/A                   29.99% (v)                        $0.00
PAYPAL CREDIT/SYNCB
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isSynchronyStatement, parseSynchronyStatement } from './synchrony';
const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const sum = (f: { rows: { amount: number }[] }) => f.rows.reduce((s, r) => s + r.amount, 0);
describe('parseSynchronyStatement', () => {
	it('reads the Amazon Store Card layout: mask, dated balances, reference ids, zero interest row dropped', () => {
		const text = fx('synchrony-amazon.txt'); expect(isSynchronyStatement(text)).toBe(true);
		const f = parseSynchronyStatement(text);
		expect(f.format).toBe('synchrony'); expect(f.mask).toBe('7672');
		expect(f.statement).toEqual({ opensOn: '2025-10-23', closesOn: '2025-11-20', previousBalance: -85725, newBalance: -56864 });
		expect(f.balances).toEqual([{ asOf: '2025-11-20', current: -56864 }]);
		expect(f.rows.map((r) => [r.postedDate, r.amount, r.payeeRaw, r.providerCategory, r.referenceId, r.memo])).toEqual([
			['2025-11-04', 28861, 'ONLINE PYMT-THANK YOU ATLANTA GA', 'PAYMENTS', 'syf:P9342009M00XS6H11', null],
			['2025-10-25', 2648, 'AMAZON RETAIL SEATTLE WA', 'PAYMENTS', 'syf:P9342009BEHM6S9PZ', null],
			['2025-10-21', -2648, 'AMAZON RETAIL SEATTLE WA', 'PURCHASES', 'syf:P93420097EHM6S9PT', null]
		]);
		expect(f.statement!.previousBalance + sum(f)).toBe(f.statement!.newBalance);
	});
	it('reads the PayPal Credit layout: full dates, posting date, plan type stripped, promo text as memo, fee row', () => {
		const text = fx('synchrony-paypal.txt'); expect(isSynchronyStatement(text)).toBe(true);
		const f = parseSynchronyStatement(text);
		expect(f.mask).toBe('8182');
		expect(f.statement).toEqual({ opensOn: '2025-09-27', closesOn: '2025-10-27', previousBalance: -168127, newBalance: -397729 });
		expect(f.rows.map((r) => [r.postedDate, r.transactedAt, r.amount, r.payeeRaw, r.providerCategory, r.referenceId, r.memo])).toEqual([
			['2025-10-21', '2025-10-21T00:00:00Z', 78937, 'Online Payment Thank You', 'PAYMENTS', 'syf:P928300970122QF2N', null],
			['2025-10-03', '2025-10-01T00:00:00Z', -39899, 'CHANGWANGWE', 'PURCHASES', 'syf:P9283008KEHM6QAA9', 'No Interest If Paid In Full'],
			['2025-10-08', '2025-10-08T00:00:00Z', -268440, 'TICKETMASTER', 'PURCHASES', 'syf:P9283008SEHM6B0MN', 'No Interest If Paid In Full'],
			['2025-10-27', '2025-10-27T00:00:00Z', -200, 'Minimum Interest Charge', 'FEES', null, null]
		]);
		expect(f.statement!.previousBalance + sum(f)).toBe(f.statement!.newBalance);
	});
});
```

- [ ] **Step 3: Run to verify failure.**

- [ ] **Step 4: Implement**

```ts
import type { ParsedFile, ParsedRow } from './types';
import { dollars, statementRowDate, usDateToIso } from './dates';
import { addDays } from '$lib/dates';
const ROW = /^\s*(\d\d\/\d\d(?:\/\d\d)?)\s+(?:(\d\d\/\d\d(?:\/\d\d)?)\s+)?(?:(P[0-9A-Z]{14,})\s+)?(?:(?:Deferred|Standard)\s+)?(.+?)\s+(-?\$[\d,]+\.\d\d)\s*$/;
const HEADINGS: [RegExp, string][] = [
	[/^Payments\b/, 'PAYMENTS'], [/^Purchases( and Other Debits)?\s*$|^Purchases and Other Debits\b/, 'PURCHASES'],
	[/^Total Fees Charged This Period\b/, 'FEES'], [/^Total Interest Charged This Period\b/, 'INTEREST'],
	[/^PAYMENTS & CREDITS\s*$/, 'PAYMENTS'], [/^PURCHASES & ADJUSTMENTS\s*$/, 'PURCHASES'], [/^FEES\s*$/, 'FEES'], [/^INTEREST CHARGED\s*$/, 'INTEREST']
];
const END = /Year-to-Date Fees and Interest|Totals Year-To-Date/i;
export function isSynchronyStatement(text: string): boolean { return /synchrony|SYNCB/i.test(text); }
function need(re: RegExp, text: string, what: string): RegExpExecArray { const m = re.exec(text); if (!m) throw new Error(`synchrony statement: no ${what}`); return m; }
export function parseSynchronyStatement(text: string): ParsedFile {
	const paypal = /Statement Closing Date:/.test(text);
	let opensOn: string, closesOn: string, previousBalance: number, newBalance: number, mask: string | null;
	if (paypal) {
		closesOn = usDateToIso(need(/Statement Closing Date:[ \t]+(\d\d\/\d\d\/\d\d)/, text, 'closing date')[1]);
		const days = +need(/Days in Billing Period:[ \t]+(\d+)/, text, 'days in period')[1];
		opensOn = addDays(closesOn, -(days - 1));
		previousBalance = -dollars(need(/^Previous Balance[ \t]+(-?\$[\d,]+\.\d\d)/m, text, 'previous balance')[1]);
		newBalance = -dollars(need(/^= New Balance[ \t]+(-?\$[\d,]+\.\d\d)/m, text, 'new balance')[1]);
		mask = /Account Number:[ \t]+(?:x{4}[ \t]+){3}(\d{4})/i.exec(text)?.[1] ?? null;
	} else {
		const prev = need(/Previous Balance as of (\d\d\/\d\d\/\d{4})[ \t]+(-?\$[\d,]+\.\d\d)/, text, 'previous balance');
		const nb = need(/New Balance as of (\d\d\/\d\d\/\d{4})[ \t]+(-?\$[\d,]+\.\d\d)/, text, 'new balance');
		opensOn = addDays(usDateToIso(prev[1]), 1); closesOn = usDateToIso(nb[1]);
		previousBalance = -dollars(prev[2]); newBalance = -dollars(nb[2]);
		mask = /Account Number ending in (\d{4})/.exec(text)?.[1] ?? null;
	}
	const rows: ParsedRow[] = []; let section: string | null = null;
	for (const line of text.split(/\r?\n/)) {
		if (END.test(line)) { section = null; continue; }
		const h = HEADINGS.find(([re]) => re.test(line)); if (h) { section = h[1]; continue; }
		if (!section) continue;
		const m = ROW.exec(line); if (!m) continue;
		const amount = -dollars(m[5]); if (amount === 0) continue;
		const toIso = (d: string) => (d.length === 8 ? usDateToIso(d) : statementRowDate(d, closesOn));
		const tran = toIso(m[1]); const posted = m[2] ? toIso(m[2]) : tran;
		const desc = m[4].replace(/\s+/g, ' ').trim();
		const promo = /^(.*?)\s+(No Interest If Paid In Full.*)$/i.exec(desc);
		rows.push({ postedDate: posted, transactedAt: paypal ? `${tran}T00:00:00Z` : null, amount, payeeRaw: promo ? promo[1] : desc, memo: promo ? promo[2] : null, providerCategory: section, referenceId: m[3] ? `syf:${m[3]}` : null });
	}
	return { format: 'synchrony', mask, statement: { opensOn, closesOn, previousBalance, newBalance }, rows, balances: [{ asOf: closesOn, current: newBalance }] };
}
```
Notes for the implementer: the Amazon layout prints MM/DD only and no posting date, so `transactedAt` stays null there; PayPal prints MM/DD/YY for both, and `usDateToIso` handles the two-digit year. The promo tables print `MM/DD/YYYY` dates, which `ROW` cannot match (four-digit year is not followed by whitespace), and they sit after the `END` marker anyway. The continuation line `Alpharetta Ga` has no date and is skipped.

- [ ] **Step 5: Run** — green.
- [ ] **Step 6: Commit** — `git commit -m "feat: Synchrony statement parser for Amazon Store Card and PayPal Credit"`

---

### Task 5: Detection and PDF text extraction

**Files:** Create `formats/detect.ts`, `formats/detect.test.ts`, `src/lib/server/import/pdf.ts`, `src/lib/server/import/pdf.test.ts`, `formats/fixtures/tiny.pdf` (bytes below).

**Interfaces produced:**
```ts
// pdf.ts
export function pdfToText(bytes: Uint8Array): Promise<string>;   // rejects with ImportError('pdf', ...) when pdftotext is missing or fails
// detect.ts
export function parseText(text: string): ParsedFile;              // throws ImportError('unknown_format') 
export async function detectAndParse(bytes: Uint8Array): Promise<ParsedFile>;  // %PDF → pdfToText → parseText; else utf-8 decode → parseText
```

- [ ] **Step 1: Fixture** — write `fixtures/tiny.pdf` with this exact content (pdftotext repairs the missing xref table and only warns on stderr):

```
%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 60 >> stream
BT /F1 12 Tf 72 720 Td (Hello statement 12/05 UBER 95.26) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
```

- [ ] **Step 2: Write the failing tests**

```ts
// pdf.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pdfToText } from './pdf';
const have = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
describe.skipIf(!have)('pdfToText', () => {
	it('extracts layout text from a PDF given on stdin', async () => {
		const text = await pdfToText(readFileSync(new URL('./formats/fixtures/tiny.pdf', import.meta.url)));
		expect(text).toContain('Hello statement 12/05 UBER 95.26');
	});
});
```
```ts
// detect.test.ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ImportError } from './types';
vi.mock('../pdf', () => ({ pdfToText: vi.fn(async () => readFileSync(new URL('./fixtures/chase-dec-jan.txt', import.meta.url), 'utf8')) }));
import { parseText, detectAndParse } from './detect';
import { pdfToText } from '../pdf';
const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
describe('parseText', () => {
	it('routes each format by content', () => {
		expect(parseText('Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By\n').format).toBe('apple');
		expect(parseText('Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit\n').format).toBe('capital_one');
		expect(parseText('"Transaction ID","Posting Date","Effective Date","Transaction Type","Posting Status","Amount","Check Number","Reference Number","Description","Transaction Category","Type","Balance","Memo","Extended Description"\n').format).toBe('nasa_fcu');
		expect(parseText(fx('chase-dec-jan.txt')).format).toBe('chase');
		expect(parseText(fx('synchrony-paypal.txt')).format).toBe('synchrony');
	});
	it('rejects unknown content with an ImportError', () => {
		expect(() => parseText('hello\nworld')).toThrow(ImportError);
		try { parseText('hello'); } catch (e) { expect((e as ImportError).code).toBe('unknown_format'); }
	});
});
describe('detectAndParse', () => {
	it('sends %PDF bytes through pdftotext and everything else through the text decoder', async () => {
		const pdf = await detectAndParse(new TextEncoder().encode('%PDF-1.4 fake'));
		expect(pdf.format).toBe('chase'); expect(pdfToText).toHaveBeenCalledTimes(1);
		const csv = await detectAndParse(new TextEncoder().encode('Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit\n'));
		expect(csv.format).toBe('capital_one'); expect(pdfToText).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 3: Run to verify failure.**

- [ ] **Step 4: Implement**

```ts
// pdf.ts
import { execFile } from 'node:child_process';
import { ImportError } from './formats/types';
/** The only place shiso spawns a process. poppler-utils must be installed on the host (docs/deploy.md §2). */
export function pdfToText(bytes: Uint8Array): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile('pdftotext', ['-layout', '-', '-'], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
			if (err) reject(new ImportError('pdf', (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'pdftotext is not installed' : `pdftotext failed: ${err.message}`));
			else resolve(stdout);
		});
		child.stdin!.on('error', () => { /* pdftotext exited early; the callback carries the error */ });
		child.stdin!.end(Buffer.from(bytes));
	});
}
```
```ts
// detect.ts
import { parse } from 'csv-parse/sync';
import { ImportError, type ParsedFile } from './types';
import { APPLE_HEADER, parseAppleCardCsv } from './apple';
import { CAPITAL_ONE_HEADER, parseCapitalOneCsv } from './capital-one';
import { NASA_HEADER, parseNasaFcuCsv } from './nasa-fcu';
import { isChaseStatement, parseChaseStatement } from './chase';
import { isSynchronyStatement, parseSynchronyStatement } from './synchrony';
import { pdfToText } from '../pdf';
function headerHas(firstLine: string, required: readonly string[]): boolean {
	try { const cols = (parse(firstLine, { bom: true, trim: true }) as string[][])[0] ?? []; return required.every((c) => cols.includes(c)); } catch { return false; }
}
export function parseText(text: string): ParsedFile {
	const first = text.split(/\r?\n/, 1)[0] ?? '';
	if (headerHas(first, APPLE_HEADER)) return parseAppleCardCsv(text);
	if (headerHas(first, CAPITAL_ONE_HEADER)) return parseCapitalOneCsv(text);
	if (headerHas(first, NASA_HEADER)) return parseNasaFcuCsv(text);
	if (isChaseStatement(text)) return parseChaseStatement(text);
	if (isSynchronyStatement(text)) return parseSynchronyStatement(text);
	throw new ImportError('unknown_format', 'unknown format: expected an Apple Card, Capital One, or NASA FCU CSV, or a Chase or Synchrony statement');
}
export async function detectAndParse(bytes: Uint8Array): Promise<ParsedFile> {
	const isPdf = bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
	return parseText(isPdf ? await pdfToText(bytes) : new TextDecoder().decode(bytes));
}
```
Order matters: the CSV header checks come first so a CSV that happens to mention "chase" is not misrouted.

- [ ] **Step 5: Run** — `npx vitest run src/lib/server/import` → green (the pdf test runs on the Mac, where pdftotext is installed, and skips elsewhere).
- [ ] **Step 6: Commit** — `git commit -m "feat: import format detection and pdftotext wrapper"`

---

### Task 6: Import core — dedup, balances, opening balance, dry run

**Files:**
- Create: `src/lib/server/import/statement.ts`, `src/lib/server/import/statement.test.ts`
- Delete: `src/lib/server/sync/import/csv.ts`, `src/lib/server/sync/import/csv.test.ts` (its `importCsv` cases move here)
- Modify: `src/routes/api/accounts/[id]/import/+server.ts` (minimal: call `importParsed(db, id, parseText(text), …)` so the build stays green; the full route is Task 8)

**Interfaces produced:**
```ts
export type ImportReport = {
	format: ImportFormat; mask: string | null; statement: ParsedStatement | null;
	created: number; duplicates: number; matched: number; balances: number;
	opening: { from: number; to: number; date: string } | { seeded: number; date: string } | null;
	processed: number; dryRun: boolean;
};
export function reconcileStatement(parsed: ParsedFile): void;   // throws ImportError('reconcile') when statement && previous + Σ rows ≠ new
export function importParsed(db: Db, accountId: number, parsed: ParsedFile, opts: { cadence: Cadence; todayIso: string; dryRun?: boolean }): ImportReport;  // processed is always 0 here; the route fills it
```

- [ ] **Step 1: Write the failing tests** (in `statement.test.ts`; use `fixture()` from `../test/fixture` — its periods run 2026-07-01 to 2026-10-31, `today` is 2026-09-08, `card` is a credit account with mask null, `checking` a cash account):

```ts
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
		const shape = (x: ReturnType<typeof fixture>) => live(x.db, x.card).map((t) => [t.postedDate, t.amount, t.source]).sort();
		expect(shape(a)).toEqual(shape(b));
		expect(ledgerSum(a.db, a.card)).toBe(-2500);
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
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/server/import/statement`.

- [ ] **Step 3: Implement**

```ts
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
		throw new ImportError('reconcile', `does not reconcile: previous ${parsed.statement.previousBalance} + rows ${sum} ≠ new ${parsed.statement.newBalance} (off by ${parsed.statement.newBalance - expected})`);
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
```
Then delete `sync/import/csv.ts` and its test, and make the route compile: replace the `importCsv` call with `importParsed(db, id, parseText(text), { cadence: config.cadence, todayIso: today })` (imports from `$lib/server/import/statement` and `$lib/server/import/formats/detect`), mapping `ImportError` to `ValidationError`. The route's existing test, if any, keeps passing because Apple CSV still routes through `parseText`.

Seeding uses `existing` (rows that were live before this call), so a row in this very statement dated before `opensOn` (a purchase that posted in the next cycle) cannot block the seed. A seeded opening's amount includes only what the issuer had posted at the previous close, which is exactly `previousBalance`.

- [ ] **Step 4: Run** — `npm test` → green; `npm run check` → clean.
- [ ] **Step 5: Commit** — `git commit -m "feat: statement import core with fuzzy dedup, balances, and opening-balance correction"`

---

### Task 7: Budget start boundary

**Files:**
- Modify: `src/lib/server/settings.ts`, `src/lib/server/startup.ts`, `src/lib/server/startup.test.ts`, `src/lib/server/budget/envelope.ts`, `src/lib/server/budget/envelope.test.ts`, `src/lib/server/budget/envelope.property.test.ts`, `src/lib/server/budget/load.ts`, `src/lib/server/ledger/assignments.ts`, `src/lib/server/ledger/assignments.test.ts`, `src/lib/server/read/budget.ts`, `src/lib/server/read/budget.test.ts`, `src/routes/budget/+page.svelte`

**Interfaces produced:**
```ts
// settings.ts
export const BUDGET_START_KEY = 'budget_start';
export function budgetStart(db: DbOrTx): string | null;   // getSetting(db, BUDGET_START_KEY, null)
// envelope.ts — BudgetInput gains `budgetStart?: string | null`; periods with startDate < budgetStart, and their splits/assignments, are excluded from envelope math; readyToAssignFromFlows gains startingCash
// assignments.ts
export function assertBudgetPeriod(db: DbOrTx, periodId: number): void;  // InvariantError('PERIOD_BEFORE_BUDGET_START') when the period starts before budget_start
// read/budget.ts — BudgetView gains `historyOnly: boolean; budgetStart: string | null`
```

- [ ] **Step 1: Write the failing tests**

`envelope.test.ts`, appended describe:
```ts
describe('budget start', () => {
	it('ignores periods before budgetStart: no carry, no activity, no assignments reach the kept periods', () => {
		const base = skeleton(3);   // reuse this file's existing helper that builds accounts/categories/periods 1..n; if it has another name, use that
		const withHistory: BudgetInput = { ...base, splits: [...base.splits,
			{ transactionId: 901, accountId: CHECKING, periodId: 1, categoryId: GROCERIES, amount: -80000, transferPeerAccountId: null, source: 'import' },
			{ transactionId: 902, accountId: CHECKING, periodId: 1, categoryId: TRANSFER, amount: -50000, transferPeerAccountId: CARD, source: 'import' },
			{ transactionId: 903, accountId: CARD, periodId: 1, categoryId: TRANSFER, amount: 50000, transferPeerAccountId: CHECKING, source: 'import' }
		], assignments: [...base.assignments, { periodId: 1, categoryId: GROCERIES, assigned: 12345 }], budgetStart: base.periods[1].startDate };
		const without: BudgetInput = { ...base, periods: base.periods.slice(1), budgetStart: null };
		const a = computeBudget(withHistory, base.periods[2].id), b = computeBudget(without, base.periods[2].id);
		expect(a.byPeriod.get(base.periods[2].id)).toEqual(b.byPeriod.get(base.periods[2].id));
		expect(a.byPeriod.has(base.periods[0].id)).toBe(false);
		expect(a.underfunded).toEqual(b.underfunded);
		expect(a.readyToAssign).toBe(b.readyToAssign);
	});
});
```
(Adapt the constant names `CHECKING`, `CARD`, `GROCERIES`, `TRANSFER` and the skeleton helper to what `envelope.test.ts` already defines; the property test file defines the same set.)

`envelope.property.test.ts`: the `ledger` arbitrary gains a budget-start offset — `fc.tuple(n, opening, fc.integer({ min: 1, max: 6 }))`, `build` sets `input.budgetStart = input.periods[Math.min(k, n) - 1].startDate`; the existing assertion `readyToAssign === readyToAssignFromFlows` for every `P >= k` must still hold. Skip periods before `k` in the loop over `P`.

`assignments.test.ts`:
```ts
it('refuses assignments in a period before budget_start', () => {
	const f = fixture(); setSetting(f.db, BUDGET_START_KEY, '2026-08-01');
	const july = periodIdForDate(f.db, '2026-07-05');
	expect(() => assign(f.db, july, f.groceries, 100)).toThrow(InvariantError);
	expect(() => moveMoney(f.db, july, f.groceries, f.rent, 100)).toThrow(/PERIOD_BEFORE_BUDGET_START/);
});
```
`startup.test.ts`:
```ts
it('pins budget_start to the earliest period on first run and never moves it', () => {
	startup(cfg(dir), '2026-09-04');
	expect(getSetting(getDb(), BUDGET_START_KEY, null)).toBe('2026-09-01');
	resetForTests();
	ensurePeriods(getDb(), 'semi_monthly', '2024-09-01', '2024-09-30');   // history arrives later
	startup(cfg(dir), '2026-09-20');
	expect(getSetting(getDb(), BUDGET_START_KEY, null)).toBe('2026-09-01');
});
```
(`ensurePeriods` between the two startups needs a live db handle: open it with `startup`, insert, `resetForTests`, start again; or insert directly after the second `startup` and assert on a third. Either sequence proves the pin does not move.)

`read/budget.test.ts`:
```ts
it('marks a period before budget_start as history only', () => {
	const f = fixture(); setSetting(f.db, BUDGET_START_KEY, '2026-08-01');
	const v = budgetView(f.db, { periodId: periodIdForDate(f.db, '2026-07-05'), todayIso: f.today, cadence: 'semi_monthly' });
	expect(v.historyOnly).toBe(true); expect(v.budgetStart).toBe('2026-08-01'); expect(v.groups.every((g) => g.categories.every((c) => c.available === 0 && c.assigned === 0))).toBe(true);
	expect(budgetView(f.db, { periodId: null, todayIso: f.today, cadence: 'semi_monthly' }).historyOnly).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`settings.ts`:
```ts
export const BUDGET_START_KEY = 'budget_start';
/** §P5: the first period the envelope math covers. Null only before the first startup ever created a period. */
export function budgetStart(db: DbOrTx): string | null { return getSetting<string | null>(db, BUDGET_START_KEY, null); }
```
`startup.ts`, after the `ensurePeriods` call:
```ts
if (getSetting<string | null>(db, BUDGET_START_KEY, null) == null) {
	const pin = firstPeriod ?? periodRange(db)?.first ?? null;   // the earliest period that existed before this startup, else the one just created
	if (pin) setSetting(db, BUDGET_START_KEY, pin);
}
```
`envelope.ts`: add `budgetStart?: string | null` to `BudgetInput`. At the top of `computeBudget`:
```ts
const start = input.budgetStart ?? null;
const periods = [...input.periods].filter((p) => start == null || p.startDate >= start).sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
const kept = new Set(periods.map((p) => p.id));
```
In the split-indexing loop, before anything else, `cardOwedAll` still sums every card split; then `if (!kept.has(s.periodId)) { if (cashIds.has(s.accountId)) startingCash += s.amount; continue; }` where `let startingCash = 0` is declared beside `cashInflowsByP`. The assignment loop skips `!kept.has(a.periodId)`. `readyToAssignFromFlows = startingCash + inflows - assignedThrough - cashOsThrough - negativeCardEnvelopes - futureAssigned`. `currentPeriodId` not in `periodIndex` still throws, so callers guard first.

`load.ts`: `loadBudgetInput` returns `budgetStart: budgetStart(db)`.

`assignments.ts`:
```ts
export function assertBudgetPeriod(db: DbOrTx, periodId: number): void {
	const start = budgetStart(db); if (start == null) return;
	const p = db.select({ s: periods.startDate }).from(periods).where(eq(periods.id, periodId)).get();
	if (p && p.s < start) throw new InvariantError('PERIOD_BEFORE_BUDGET_START', `period starts before the budget start ${start}`);
}
```
Call it first in `assign` and `moveMoney` (check `InvariantError`'s constructor signature in `ledger/errors.ts` and add the code to its code union if it has one). `fundTargets` reaches `assign` and is covered.

`read/budget.ts`: compute `const start = budgetStart(db); const historyOnly = start != null && period.startDate < start;`. When `historyOnly`, call `budgetForPeriod(db, currentId)` instead (for ready-to-assign and underfunding, which are current-period facts) and build the groups with the `zero` cell for every category and `targets` as an empty map; return `{ ...view, historyOnly, budgetStart: start }`. Otherwise unchanged plus the two new fields.

`+page.svelte`: after the toolbar,
```svelte
{#if v.historyOnly}
	<p class="muted">Before the budget started on {shortDate(v.budgetStart!)}. History only: the ledger and spending pages cover this period, the envelopes do not.</p>
{:else}
	…existing lead, strips, and table…
{/if}
```
(import `shortDate` from `$lib/dates`).

- [ ] **Step 4: Run** — `npm test` (the property test included) and `npm run check` → green.
- [ ] **Step 5: Commit** — `git commit -m "feat: budget_start setting fences envelope math off from imported history"`

---

### Task 8: Import route and Accounts page

**Files:**
- Modify: `src/routes/api/accounts/[id]/import/+server.ts`, `src/routes/accounts/+page.svelte`, `src/lib/ui/api.ts` (only if `upload` does not already pass `FormData` through unchanged)
- Create: `src/routes/api/accounts/import.test.ts`

**Interfaces produced:** `POST /api/accounts/[id]/import` — multipart `file` (CSV or PDF, ≤ 20 MB) and optional `dryRun=1`; returns `ImportReport`; 400 with the `ImportError` message for unknown format, mask mismatch, reconciliation failure; 500 when pdftotext is unavailable.

- [ ] **Step 1: Write the failing test** (`import.test.ts`, the `startup` temp-dir harness from `src/routes/api/budget/budget.test.ts`):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startup, resetForTests } from '$lib/server/startup';
import { setConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { transactions, accounts } from '$lib/server/db/schema';
import { createConnection, upsertAccount } from '$lib/server/sync/connections';
import { POST } from './[id]/import/+server';
import { eq } from 'drizzle-orm';
let dir: string; let card: number;
const cfg = (d: string) => ({ dbPath: join(d, 'shiso.db'), backupDir: join(d, 'backups'), appKey: 'k'.repeat(40), timeZone: 'America/New_York', migrationsDir: 'drizzle', cadence: 'semi_monthly' as const, syncHour: 3, balanceHour: 7, backupHour: 4, backupKeep: 30, plaid: { clientId: null, secret: null, env: 'sandbox' as const }, schedulerEnabled: false, plaidClientName: 'shiso' });
const fx = (n: string) => readFileSync(new URL(`../../../lib/server/import/formats/fixtures/${n}`, import.meta.url), 'utf8');
const req = (text: string, name: string, dryRun = false) => { const fd = new FormData(); fd.set('file', new File([text], name)); if (dryRun) fd.set('dryRun', '1'); return { request: new Request('http://localhost/x', { method: 'POST', body: fd }), params: { id: String(card) } } as never; };
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'shiso-import-')); const c = cfg(dir); setConfig(c); startup(c, '2026-09-08');
	const db = getDb(); const conn = createConnection(db, { provider: 'manual', institutionName: 'Chase', appKey: c.appKey });
	card = upsertAccount(db, conn, { externalId: 'x', name: 'Freedom', type: 'credit', mask: '1403' }).id;
});
afterEach(() => { resetForTests(); rmSync(dir, { recursive: true, force: true }); });
describe('POST /api/accounts/[id]/import', () => {
	it('imports a statement, seeds the opening row, and post-processes', async () => {
		const res = await POST(req(fx('chase-dec-jan.txt'), 's.txt')); expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ format: 'chase', created: 5, duplicates: 0, matched: 0, balances: 1, opening: { seeded: -231439, date: '2024-12-02' }, dryRun: false });
		expect(body.processed).toBe(6);
		expect(getDb().select().from(transactions).where(eq(transactions.accountId, card)).all().filter((t) => t.processedAt == null)).toHaveLength(0);
	});
	it('dry run reports without writing', async () => {
		const body = await (await POST(req(fx('chase-dec-jan.txt'), 's.txt', true))).json();
		expect(body).toMatchObject({ created: 5, dryRun: true, processed: 0 });
		expect(getDb().select().from(transactions).where(eq(transactions.accountId, card)).all()).toHaveLength(0);
	});
	it('rejects a mask mismatch, an unreconciled statement, and unknown content with 400', async () => {
		getDb().update(accounts).set({ mask: '5692' }).where(eq(accounts.id, card)).run();
		expect((await POST(req(fx('chase-dec-jan.txt'), 's.txt'))).status).toBe(400);
		getDb().update(accounts).set({ mask: '1403' }).where(eq(accounts.id, card)).run();
		const r = await POST(req(fx('chase-dec-jan.txt').replace('$1,899.66', '$1,899.67'), 's.txt'));
		expect(r.status).toBe(400); expect((await r.json()).error).toMatch(/does not reconcile/);
		expect((await POST(req('hello', 'x.txt'))).status).toBe(400);
	});
});
```
(`upsertAccount` may not accept `mask`; if not, set it with a direct update as the third test does. `processed` counts the five rows plus the seeded opening row.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement the route**

```ts
import { handle, intParam, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { getSetting } from '$lib/server/settings';
import { detectAndParse } from '$lib/server/import/formats/detect';
import { ImportError } from '$lib/server/import/formats/types';
import { importParsed } from '$lib/server/import/statement';
import { processUnprocessed } from '$lib/server/sync/postprocess';
import { todayIso } from '$lib/dates';
const MAX_BYTES = 20 * 1024 * 1024;
export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id');
	const form = await request.formData().catch(() => null);
	const file = form?.get('file');
	if (!(file instanceof File)) throw new ValidationError('file is required');
	if (file.size > MAX_BYTES) throw new ValidationError('file is larger than 20 MB');
	const dryRun = form!.get('dryRun') === '1';
	const config = getConfig(); const db = getDb(); const today = todayIso(config.timeZone);
	try {
		const parsed = await detectAndParse(new Uint8Array(await file.arrayBuffer()));
		const report = importParsed(db, id, parsed, { cadence: config.cadence, todayIso: today, dryRun });
		if (dryRun) return report;
		const processed = processUnprocessed(db, { todayIso: today, graceDays: getSetting(db, 'grace_days', 3), transferWindowDays: getSetting(db, 'transfer_window_days', 4) });
		return { ...report, processed: processed.processed };
	} catch (err) {
		if (err instanceof ImportError && err.code !== 'pdf') throw new ValidationError(err.message);
		if (err instanceof Error && /header/i.test(err.message)) throw new ValidationError(err.message);
		throw err;
	}
});
```

- [ ] **Step 4: Accounts page** — in `+page.svelte`: add `let preview = $state(false);` and replace `importCsv` with:
```ts
type Report = { format: string; statement: { opensOn: string; closesOn: string } | null; created: number; duplicates: number; matched: number; balances: number; opening: { from: number; to: number; date: string } | { seeded: number; date: string } | null; dryRun: boolean };
const FORMAT = { apple: 'Apple Card CSV', capital_one: 'Capital One CSV', nasa_fcu: 'NASA FCU CSV', chase: 'Chase statement', synchrony: 'Synchrony statement' } as Record<string, string>;
function reportLine(r: Report): string {
	const head = r.statement ? `${FORMAT[r.format]} ${shortDate(r.statement.opensOn)} to ${shortDate(r.statement.closesOn)}` : FORMAT[r.format] ?? r.format;
	const parts = [`${r.created} new`, `${r.duplicates} duplicates`, `${r.matched} matched`];
	if (r.balances) parts.push(r.balances === 1 ? 'balance written' : `${r.balances} balances written`);
	if (r.opening) parts.push('seeded' in r.opening ? `opening seeded at ${formatCents(r.opening.seeded)} on ${shortDate(r.opening.date)}` : `opening ${formatCents(r.opening.from)} to ${formatCents(r.opening.to)} on ${shortDate(r.opening.date)}`);
	return `${r.dryRun ? 'Preview: ' : ''}${head} · ${parts.join(', ')}`;
}
async function importFile(accountId: number, input: HTMLInputElement) {
	const file = input.files?.[0]; if (!file) return;
	const fd = new FormData(); fd.set('file', file); if (preview) fd.set('dryRun', '1');
	await run(`import-${accountId}`, async () => { error = reportLine(await upload<Report>(`/api/accounts/${accountId}/import`, fd)); });
	input.value = '';
}
```
(import `formatCents` from `$lib/money`). The file input becomes `<label class="small">import <input type="file" accept=".csv,.pdf,text/csv,application/pdf" hidden onchange={(e) => importFile(a.id, e.currentTarget)} /></label>` and the toolbar gains `<label class="small"><input type="checkbox" bind:checked={preview} /> preview imports</label>`.

- [ ] **Step 5: Run** — `npm test`, `npm run check`. Then the browser check per the `dev-against-prod-copy` memory: copy CT 132's database to the scratchpad, run `vite dev --port 5199` against it with `SHISO_SCHEDULER=off`, upload one Chase PDF for account 3 with preview on, and confirm the report line reads correctly at 1280 and 390 wide. Delete the copy afterwards.
- [ ] **Step 6: Commit** — `git commit -m "feat: import route accepts CSV or PDF statements with format detection and preview"`

---

### Task 9: Backfill script and docs

**Files:** Create `scripts/import-history.sh`; modify `docs/deploy.md` (§2), `README.md` (Accounts bullet, new "History import" paragraph under Data model), spec status line.

- [ ] **Step 1: Script**

```sh
#!/usr/bin/env zsh
# Backfill account history through the running app.
# usage: SHISO_URL=https://shiso.home.local scripts/import-history.sh <dir> <map-file> [--dry-run]
# map-file lines: "<file-or-folder relative to dir> <accountId>"; blank lines and # comments ignored.
# Posts every file to /api/accounts/<id>/import, one report line per file, and stops at the first non-2xx.
# Order does not matter (spec §4 step 6); files are posted in directory order. CURL_OPTS adds flags, e.g. --cacert.
set -euo pipefail
dir=$1; map=$2; dry=${3:-}
: "${SHISO_URL:?set SHISO_URL, e.g. https://shiso.home.local}"
while read -r entry account; do
	[[ -z "$entry" || "$entry" == \#* ]] && continue
	files=()
	if [[ -d "$dir/$entry" ]]; then files=("$dir/$entry"/*(N.)); else files=("$dir/$entry"); fi
	for f in "${files[@]}"; do
		[[ "$f:t" == .* ]] && continue
		out=$(curl -sS ${CURL_OPTS:-} -w '\n%{http_code}' -F "file=@$f" ${dry:+-F dryRun=1} "$SHISO_URL/api/accounts/$account/import")
		code=${out##*$'\n'}; body=${out%$'\n'*}
		printf '%s\t%s\t%s\n' "$code" "$f" "$body"
		[[ $code == 2* ]] || { echo "stopped: $f returned $code" >&2; exit 1; }
	done
done < "$map"
```
`chmod +x scripts/import-history.sh`. Add to `package.json` scripts: `"import:history": "zsh scripts/import-history.sh"`.

- [ ] **Step 2: Docs** — `docs/deploy.md` §2: add `poppler-utils` to the apt line and a sentence: "`poppler-utils` provides `pdftotext`, which the Accounts page uses to read PDF statements; without it PDF imports fail with a 500 and CSV imports still work." README Accounts bullet: "…manual balance entry, CSV and PDF statement import (Apple Card, Capital One, NASA FCU CSVs; Chase and Synchrony statements)." README, after the Data model paragraph: "History imported from statements lands in real periods for the ledger and spending pages, but envelope math starts at the `budget_start` setting (pinned at first startup to the earliest period), so backfilling never changes the live budget. Imports dedup against synced rows by amount within three days and correct the account's opening-balance row so the ledger keeps summing to the balance." Spec status → `Implemented (date)`. Also add `docs/deploy.md` a short "History backfill" subsection pointing at the script and the map-file format, and noting the Synchrony accounts are created as a manual connection on the Accounts page.

- [ ] **Step 3: Run** — `npm test`, `npm run check`; `zsh -n scripts/import-history.sh`.
- [ ] **Step 4: Commit** — `git commit -m "feat: history backfill script; deploy and README notes"`

---

### Task 10: Deploy and run the backfill (operator steps, not code)

Run by the operator with the user present for the two confirmations. Not a subagent task.

- [ ] `npm run release`; check `/api/health` on CT 132 for pending migrations before and after `install.sh` (the production copy taken 2026-09-11 lacked `promo_balances`; resolve that first).
- [ ] With the user's confirmation: `apt-get install -y poppler-utils` on CT 132.
- [ ] On the Accounts page: manual connection "Synchrony", accounts "Amazon Store Card" (credit, mask 7672, on budget, debt) and "PayPal Credit" (credit, mask 8182, on budget, debt). Note their ids.
- [ ] Write `account-history/map.txt`:
```
chase-sapphire 1
chase-amazon-prime 2
chase-freedom 3
nasa-fcu.csv 4
capital-one-quicksilver 8
chase-discover-it 9
capital-one-savor 10
amazon-store <id>
paypal <id>
```
- [ ] `SHISO_URL=https://shiso.home.local npm run import:history -- account-history account-history/map.txt --dry-run | tee scratchpad/dry-run.tsv`. Every line 200; overlap months (June to September 2026) mostly `matched`; each Chase/Synchrony line shows `balance written`; the first file per Plaid account shows the opening adjustment.
- [ ] Before the real run, record the Budget page's ready-to-assign and every available for the current period, and each account's balance on the Accounts page.
- [ ] Real run without `--dry-run`. Then compare: budget numbers unchanged; Accounts balances unchanged; Spending trends reach back to 2024; Debt trend shows per-statement balances.
- [ ] Map the new provider categories on the Categories page and apply.
- [ ] Delete `account-history/map.txt` if it holds nothing worth keeping; the statement folder stays untracked (it is already gitignored? verify — if not, add `account-history/` to `.gitignore` in Task 9).

## Self-review notes

- Spec §3 formats → Tasks 1–5; §3 reconciliation → Task 2 (NASA, row-level) and Task 6 (`reconcileStatement`); §4 import core → Task 6; §5 budget start → Task 7; §6 route and UI → Task 8; §7 backfill → Tasks 9–10; §9 testing → each task's step 1 plus the property test change in Task 7.
- The spec's 422 status is the http helper's 400 for `ValidationError`; the spec is amended to say 400.
- Names used across tasks: `ParsedFile`, `ParsedRow`, `ParsedStatement`, `ParsedBalance`, `ImportError`, `parseText`, `detectAndParse`, `pdfToText`, `importParsed`, `reconcileStatement`, `ImportReport`, `BUDGET_START_KEY`, `budgetStart`, `assertBudgetPeriod`, `historyOnly`.
