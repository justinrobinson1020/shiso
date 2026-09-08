# One-time sheet import (spec §11)

Imports pay-period balances, APR/fee history, and account open dates from the
old Google Sheet budget into shiso.

## 1. Export the sheet

In Google Sheets: File → Download → Microsoft Excel (.xlsx). Export **one
workbook per year** — tab names carry the pay-period identity (`PP 1`, `PP 2`,
… or `4/1 - 4/15` style date ranges) and are only unambiguous within a single
year.

## 2. Build the mapping file

Look up each debt account's id from the Accounts page (`/accounts`), then
write a `mapping.json` next to the workbook mapping each sheet tab name for
that account (as it appears on the "Balances" block, e.g. `Sapphire`) to its
shiso account id:

```json
{ "Sapphire": 4, "Freedom": 5 }
```

Names not present in the mapping are reported as `unmapped` and skipped.

## 3. Dry run

```sh
npx tsx scripts/import-sheet.ts --xlsx ~/Downloads/budget-2025.xlsx --year 2025 --mapping ./mapping.json --dry-run
```

This prints what each tab would import (checking balance and per-debt
balance/APR) without touching the database. No `--db` flag is required for a
dry run. Review the output before running for real.

## 4. Real run

```sh
npx tsx scripts/import-sheet.ts --db ./data/shiso.db --xlsx ~/Downloads/budget-2025.xlsx --year 2025 --mapping ./mapping.json --checking 3
```

`--checking` is the shiso account id for the checking account; omit it to
skip importing the checking balance. Run once per year's workbook.

## Idempotency

Re-running the same workbook is safe: balances and terms already recorded for
a given tab's date are detected and skipped rather than duplicated. The
printed report's `skipped` field shows what was already present.
