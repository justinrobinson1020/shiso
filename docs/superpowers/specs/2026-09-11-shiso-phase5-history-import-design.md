# shiso — Phase 5: Account history import

**Date:** 2026-09-11
**Status:** Implemented (2026-09-11)
**Scope:** Importing bank and card history from downloaded CSVs and PDF statements into the ledger, with balances, safe overlap with synced rows, opening-balance correction, and a budget-start boundary so history never disturbs the live budget. Section references are to the Phase 1 spec unless marked §P5.

## 1. Purpose

Plaid delivered about three months of transactions per account when the connections were made in June 2026. Spending trends, unusual-charge scoring, recurring-charge detection, and the debt trend all get better with a longer history, and two active cards (Amazon Store Card and PayPal Credit, both Synchrony) can never be on Plaid and need a standing import path. The user has downloaded about two years of history per account: Capital One and NASA FCU as CSV, Chase and Synchrony as monthly PDF statements.

The import must satisfy three properties: a re-import of any file changes nothing; rows that Plaid already synced are not duplicated even though statement and Plaid dates differ; and the current budget's numbers (ready-to-assign, availables, carry, targets) are identical before and after the backfill.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Where it runs | Through the running app's per-account import route, CSV or PDF | The Synchrony cards need a monthly path; the backfill is that path in a loop |
| PDF text | `pdftotext -layout` on the server (poppler-utils on CT 132) | Layout mode keeps columns aligned so one regex per format reads rows; Mac-side conversion would make the monthly drop two steps |
| Format detection | By content, never by file name or account | Files arrive misnamed (a Capital One export in a folder called chase-discover-it) |
| Overlap with synced rows | Exact external id first, then amount plus a ±3-day date window against live rows on the account, each existing row claimable once | Plaid posts one to two days after the statement's transaction date; the content hash cannot see that |
| History and the budget | A `budget_start` date setting; envelope math ignores periods before it | Card payment envelopes carry without a floor (§7.2); two years of payments with nothing assigned would sink them |
| Opening rows | Reduced by the sum of newly created rows dated on or before them and redated before the earliest such row; seeded from a statement's previous balance when absent | Keeps the ledger summing to the balance (§5.6 step 1) whatever order files arrive in |
| Balances | Statement closing balance appended as an import balance; NASA running balance sampled at month end | Feeds the debt and checking trends and gives every statement a checkpoint |
| Reconciliation | A statement whose rows do not sum from previous to new balance is rejected whole | A partial parse is worse than no parse; the gate is what makes the parser trustworthy |
| Dry run | Runs the whole import inside a transaction and rolls it back | A dry run that commits is a write |
| Scope of statement data | Transactions and closing balances only | APR history comes from the sheet import; promo plans are a later pass on the Phase 2 tables |

Rejected: a one-time direct-database script (no ongoing path, needs an outage); retroactive budgeting of history (weeks of assignments for periods never budgeted); Mac-side PDF conversion (two-step monthly workflow); a date window wider than three days (a monthly subscription charged on the same amount would start matching the wrong month).

## 3. Formats (§P5)

Every parser returns one shape:

```
ParsedFile {
  format: 'apple' | 'capital_one' | 'nasa_fcu' | 'chase' | 'synchrony'
  mask: string | null              // last four printed on the file, when any
  statement: {                     // present for chase, synchrony
    opensOn: string; closesOn: string; previousBalance: number; newBalance: number
  } | null
  rows: ParsedRow[]
  balances: { asOf: string; current: number }[]   // account point of view
}
ParsedRow {
  postedDate: string; transactedAt: string | null
  amount: number                   // cents, account point of view (§4.2 sign convention)
  payeeRaw: string; memo: string | null; providerCategory: string | null
  referenceId: string | null       // issuer's stable id when the source has one
}
```

Balances, including `statement.previousBalance` and `newBalance`, are from the account's point of view: a card's new balance of $686.91 is stored as −68691, matching opening rows. Reconciliation is therefore `previousBalance + Σ row.amount = newBalance` in one convention.

**Detection** (`detect.ts`): bytes beginning `%PDF` go through pdftotext first. Text whose first line is a CSV header is matched against the known header sets (Apple: `Transaction Date,Clearing Date,Description,Merchant,…`; Capital One: `Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit`; NASA FCU: `"Transaction ID","Posting Date",…`). Otherwise statement text containing `chase.com` and `ACCOUNT ACTIVITY` is Chase; text containing `synchrony` is Synchrony. Anything else is `unknown format`.

**Apple Card CSV** — the existing parser moved unchanged from `sync/import/csv.ts`. No mask, no statement, no balances.

**Capital One CSV** — `amount = Credit − Debit`; `postedDate` from Posted Date, `transactedAt` from Transaction Date; `payeeRaw` = Description; `providerCategory` = Category; `mask` = Card No. No balances, no statement, no reference id.

**NASA FCU CSV** — `amount` = Amount (already signed from the account's view); `postedDate` = Posting Date, `transactedAt` = Effective Date; `payeeRaw` = Description; `memo` = Extended Description when it differs; `providerCategory` = Transaction Category; `referenceId` = `nasa:` + Transaction ID. Rows are ordered newest first in the file; the parser sorts oldest first. Balances: for each calendar month present, the Balance of the last row (by posting date, then file order) dated within it, `asOf` = that row's posting date. Reconciliation: walking oldest to newest, `balance(i) = balance(i−1) + amount(i)` for every row; the first row is unchecked.

**Chase statement** — page 1 carries `Account Number: XXXX XXXX XXXX 1403` (mask), `Opening/Closing Date MM/DD/YY - MM/DD/YY`, `Previous Balance $x`, `New Balance $x`. Rows live between the `ACCOUNT ACTIVITY` heading and the `Totals Year-to-Date` line and match `^\s*(\d\d)/(\d\d)\s+(.+?)\s+(-?[\d,]+\.\d\d)\s*$`. The current section heading (`PAYMENTS AND OTHER CREDITS`, `PURCHASE`, `FEES CHARGED`, `INTEREST CHARGED`) becomes `providerCategory`. Year: the closing date's year, minus one when the row's month is greater than the closing month. `amount = −printed` (purchases print positive). `postedDate` = the printed date (Chase prints the transaction date; Plaid's posted date lands one to two days later, which is what the fuzzy match absorbs). Lines inside the section that do not match the row pattern (continuation lines, subtotals) are ignored. Balances: one entry, `closesOn`, `−newBalance`.

**Synchrony statement** — two layouts of one parser. Mask: `Account Number ending in 7672` (Amazon) or `Account Number: xxxx xxxx xxxx 8182` (PayPal). Statement: Amazon prints `Previous Balance as of MM/DD/YYYY $x` and `New Balance as of MM/DD/YYYY $x`; PayPal prints `Statement Closing Date: MM/DD/YY`, `Previous Balance $x`, `New Balance $x`, with `opensOn` = closing date minus (`Days in Billing Period` − 1), which PayPal prints on page 1. Rows sit under the headings `Payments` / `PAYMENTS & CREDITS`, `Purchases and Other Debits` / `PURCHASES & ADJUSTMENTS`, `Total Fees Charged This Period` / `FEES`, `Total Interest Charged This Period` / `INTEREST CHARGED`, and a `Year-to-Date` line ends the row area and match `^\s*(\d\d/\d\d(?:/\d\d)?)\s+(?:(\d\d/\d\d(?:/\d\d)?)\s+)?(?:(P[0-9A-Z]{14,})\s+)?(?:(Deferred|Standard)\s+)?(.+?)\s+(-?\$[\d,]+\.\d\d)\s*$`: transaction date, optional posting date, optional reference number, optional plan type, description, amount. `amount = −printed`; `postedDate` = posting date when printed else transaction date; `referenceId` = `syf:` + reference when printed; `providerCategory` = section heading; `memo` = the trailing promo text (`No Interest If Paid In Full`) when present. Year rules as Chase for two-digit dates. Balances: one entry at `closesOn`.

**Reconciliation** (`statement !== null`): `previousBalance + Σ row.amount = newBalance` to the cent. Failure reports the difference and rejects the file. A Chase statement with no `ACCOUNT ACTIVITY` block (a zero-balance month) has zero rows and reconciles when both balances are zero.

## 4. Import core (`import/statement.ts`)

`importParsed(db, accountId, parsed, opts: { cadence, todayIso, dryRun })` → `ImportReport`. All steps run in one transaction; `dryRun` throws a sentinel after computing the report so the transaction rolls back and the report is returned. The route is the only caller besides tests.

1. **Mask check.** If `parsed.mask` and the account's `mask` are both present and differ, reject (`mask mismatch`). Nothing is written.
2. **Reconcile** (§3). Reject on failure.
3. **Periods.** `ensurePeriods` from the earliest row or balance date through the period after today's, as the CSV import does now.
4. **Rows**, oldest first:
   - `externalId` = `referenceId` when present, else the content hash with account key `csv:<accountId>` and the ordinal among identical (date, amount, description) rows in this file, exactly as today.
   - **Exact duplicate**: a row with that `externalId` exists on the account → counted `duplicates`, skipped.
   - **Fuzzy match**: a live (`deleted_at IS NULL`) row on the account with equal `amount`, not yet claimed in this import, where the smallest distance between any of its dates (`posted_date`, `transacted_at`) and any of this row's (`postedDate`, `transactedAt`) is at most 3 days. The closest wins; it is claimed; the row is counted `matched` and skipped. Only rows that existed before this call are candidates: two identical rows in one file are kept apart by the hash ordinal, never matched against each other.
   - Otherwise `createTransaction` with `source = 'import'`, `processedAt` null; counted `created`.
5. **Balances.** Each `parsed.balances` entry is appended with `source = 'import'` unless an import balance with the same `asOf` and `current` already exists on the account (the sheet importer's `hasBalance`); counted `balances`.
6. **Opening balance.** Let `O` be the account's live `source = 'opening'` row, if any, and `C` the rows created in step 4.
   - If `O` exists and any `c ∈ C` has `postedDate ≤ O.postedDate`: `O.amount −= Σ amount(c)` over those rows (its single reconciliation split moves with it); `O.postedDate = min(postedDate(c)) − 1 day`; `O.periodId` follows the new date. Reported as `opening: { from, to, date }`.
   - If `O` does not exist, `parsed.statement` is present, and the account has no live row dated before `statement.opensOn`: insert `O` with `amount = −previousBalance`, `postedDate = opensOn − 1 day`, `externalId = 'opening'`, `source = 'opening'`, reconciliation category. Reported as `opening: { seeded, date }`.
   - Idempotence: only rows created in this call enter the sum, so a re-import (all duplicates or matches) leaves `O` untouched. Order independence: importing an earlier statement after a later one reduces the seeded `O` by the earlier rows and redates it, which is the first rule.
7. **Post-processing.** The route calls `processUnprocessed` as today (payee rules, transfer detection, bill and income matching, category map). Transfer detection links imported card payments to imported checking debits within the window. Bill matching touches only open occurrences, so history matches nothing.

`ImportReport`:
```
{ format, mask, statement: { opensOn, closesOn, previousBalance, newBalance } | null,
  created, duplicates, matched, balances,
  opening: { from, to, date } | { seeded, date } | null,
  processed: number, dryRun: boolean }
```

## 5. Budget start (§P5, amends §7)

- Setting `budget_start` (ISO date). `startup` sets it, when unset and any period exists, to the earliest period's start date. On CT 132 that pins 2026-06-01 before the first backfill; a fresh install with no periods gets it on the startup that creates the first period.
- `loadBudget` passes `budgetStart` to `computeBudget`, which drops every period with `startDate < budgetStart` from `input.periods` and every split and assignment in them before indexing. Carry into the first kept period is zero for every envelope. Card owed (`cardOwedAll`) still sums every split, since it is a balance, not a flow.
- Requesting the Budget page for a period before `budget_start` renders the header and a notice ("Before the budget started on Jun 1, 2026. History only.") instead of the envelope grid; assignment and funding routes reject such periods with 409 (`PERIOD_BEFORE_BUDGET_START`).
- Ready-to-assign (§7.3) is balance-based and unchanged. The conservation property (§7.5) is restated over kept periods only: the flow side gains a first term, the sum of every live cash-account transaction dated before `budget_start` (the cash on hand when the budget began, which is where the redated opening rows now land), and the remaining sums run from `budget_start` through `P`. The property test's flow-side formula changes accordingly.
- Ledger, Spending, Recurring, Debt trend, and Month are untouched: they read transactions and balances by date.

## 6. Route and screen

`POST /api/accounts/[id]/import` — multipart `file` (CSV or PDF, 20 MB cap), optional field `dryRun=1`. Steps: read bytes; detect and parse (§3); `importParsed` (§4); unless dry run, `processUnprocessed`. Returns the `ImportReport`. Errors, all 400 `ValidationError` with the reason in `message` (the http helper's mapping): `unknown format`, `mask mismatch (file 1403, account 5692)`, `does not reconcile: previous 640165 + rows −5788 ≠ new 634377 (diff …)`, `pdf text extraction unavailable` (pdftotext missing or failed; this one is 500). pdftotext runs via `execFile` with a 30 s timeout and the bytes on stdin; the temp-file-free path keeps the release stateless.

`src/lib/server/import/pdf.ts` — `pdfToText(bytes): Promise<string>`; the only place that spawns a process.

**Accounts page** — the per-account file input accepts `.csv,.pdf`; after upload the report reads as one line: "Chase statement Jul 3 – Aug 2 · 2 new, 0 duplicates, 3 matched, balance written" with the opening adjustment appended when present. Errors show the 422 message. A "preview" checkbox beside the input sends `dryRun=1` and shows the same line prefixed "Preview:".

## 7. Backfill procedure (§P5, one-time)

1. Deploy the release that contains this phase (`docs/deploy.md`). Confirm `/api/health` shows zero pending migrations.
2. Install `poppler-utils` on CT 132 (ask first; recorded in `docs/deploy.md` as a runtime requirement).
3. On the Accounts page, add a manual connection "Synchrony" with two accounts: Amazon Store Card (mask 7672) and PayPal Credit (mask 8182), type credit, on budget, debt.
4. `scripts/import-history.sh <dir> <map-file> [--dry-run]` — the map file lists `folder-or-file  accountId` pairs; the script posts every file under each folder to `$SHISO_URL/api/accounts/<id>/import` in directory order (order does not matter, §4 step 6), printing one report line per file and stopping on the first non-2xx. Run with `--dry-run` first; every file must reconcile and the created/matched counts must look right (overlap months should be mostly `matched`). Then run for real.
5. Verify: the Accounts page balances still equal the providers' current balances (the opening recompute keeps the ledger sum); the Budget page for the current period shows the same ready-to-assign and availables as before the run; Spending trends now reach back to 2024.
6. Run `applyProviderCategoryMap` from the Categories page after mapping the new provider categories (Capital One's `Merchandise`, NASA's `Restaurants & Dining`, Chase's `INTEREST CHARGED`, …).

## 8. Files

```
src/lib/server/import/formats/types.ts        ParsedFile, ParsedRow
src/lib/server/import/formats/detect.ts       detectAndParse(bytes) → ParsedFile
src/lib/server/import/formats/apple.ts        moved from sync/import/csv.ts
src/lib/server/import/formats/capital-one.ts
src/lib/server/import/formats/nasa-fcu.ts
src/lib/server/import/formats/chase.ts
src/lib/server/import/formats/synchrony.ts
src/lib/server/import/formats/dates.ts        MM/DD[/YY] with statement-year rule; $ amounts
src/lib/server/import/pdf.ts                  pdfToText
src/lib/server/import/statement.ts            importParsed, reconcile, fuzzy match, opening rule
src/lib/server/sync/import/csv.ts             removed (importCsv callers move to importParsed)
src/lib/server/budget/envelope.ts, load.ts    budgetStart
src/lib/server/settings.ts                    BUDGET_START_KEY
src/lib/server/startup.ts                     pin budget_start
src/routes/api/accounts/[id]/import/+server.ts
src/routes/accounts/+page.svelte
src/routes/budget/+page.server.ts, +page.svelte, assign and fund routes (history guard)
scripts/import-history.sh
docs/deploy.md, README.md
```

No schema migration: `budget_start` is a settings row.

## 9. Testing

- **Parsers**: one fixture per format under `src/lib/server/import/formats/fixtures/`, cut from real files with names and amounts altered but structure intact (a Chase statement spanning December to January; a Synchrony PayPal statement with a deferred-interest row; a NASA CSV slice with a month boundary; a Capital One slice with both debit and credit rows). Tests assert the parsed rows, mask, statement, balances, and that reconciliation passes on the fixture and fails when one amount is altered.
- **Detection**: each fixture detects as itself; a PDF magic prefix routes to `pdfToText` (mocked); junk is `unknown format`.
- **Import core** on the in-memory fixture: synced rows dated one and two days after statement rows are matched, not duplicated; two equal-amount statement rows claim two distinct synced rows; a second import of the same file creates nothing and leaves the opening row untouched; opening recompute gives the same ledger sum whether an earlier statement is imported before or after a later one; seeding from a previous balance; dry run leaves every table byte-identical (row counts and a checksum over transactions and balances).
- **Budget start**: `computeBudget` with a period before the start holding assignments, spending, and card payments returns the same availables, carry, and card underfunding as the input without that period; the property test's flow-side RTA adds the filter and still equals the balance-side RTA.
- **Route**: 422 messages for unknown format, mask mismatch, and reconciliation failure; a dry run returns a report and writes nothing.

## 10. Out of scope

APR and promotional-plan history from statements (later pass on the Phase 2 tables); statements for NASA FCU savings, the line of credit, the NASA Visa, and the SoFi loan (no files); parsing PDFs without a text layer; a UI for choosing the budget start (edit the settings row if ever needed).
