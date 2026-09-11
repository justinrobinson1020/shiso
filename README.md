# shiso

shiso is a single-user personal finance dashboard that replaces a Google
Sheet used for bill tracking, debt payoff, and spending tracking. It syncs
bank data, tracks a transaction ledger, runs YNAB-style envelope budgeting on
semi-monthly (or monthly) pay periods, and shows monthly cash flow and
spending breakdowns.

## Requirements

- Node 24
- No Docker, no external services beyond the database file — everything
  runs as one process

## Development

```bash
cp .env.example .env
```

Generate a value for `SHISO_APP_KEY` (used to encrypt stored bank
credentials) and put it in `.env`:

```bash
openssl rand -base64 48
```

Then:

```bash
npm install
npm run dev      # dev server
npm test         # vitest
npm run check    # svelte-check
```

## Pages

- **Month** (`/`) — cash on hand, income expected/received, bills paid and
  pending, planned card payments, cash left at month end.
- **Budget** (`/budget`, `/budget/categories`) — envelope grid for the
  selected period (assigned, activity, available), ready-to-assign, card
  underfunding, and category management. Each category can carry a target
  (per month, keep available, or reach an amount by a date); the grid shows
  what each envelope still needs this period with one-click funding.
- **Debt** (`/debt`) — every open card and loan with owed, accruing, APR,
  interest estimates, minimum and due date, with terms history; a per-period
  plan of extra payments with one-click funding of the payment envelope;
  payoff projections under the plan, minimums only, avalanche, and snowball;
  promotional balances with expiry and monthly target; and the debt trend
  per period (owed, change, paid, interest, income, paid as a share of income).
- **Ledger** (`/ledger`) — transactions across accounts or one account,
  inline payee/category editing, splits, period reassignment, and the
  review queue.
- **Spending** (`/spending`) — breakdowns by category and merchant, and
  spending over time, with a shared range picker and compare-to-previous;
  twelve-month trends per category against a usual month; unusual charges
  scored against the user's own history; and a recurring-charges page
  (`/spending/recurring`) that finds payees charging on a schedule and flags
  the ones with no bill yet.
- **Accounts** (`/accounts`) — connections and sync status, relink, manual
  sync, balance drift and adjustment, debt terms, manual balance entry, CSV
  and PDF statement import (Apple Card, Capital One, NASA FCU CSVs; Chase and
  Synchrony statements).
- **Bills** (`/bills`) — bill and income definitions and occurrence history.

## Data model

All amounts are integer cents. Sign convention is from the account's point
of view: a purchase on a card is negative, a payment to the card is
positive; transfers are equal and opposite. Budget periods are generated
rows (semi-monthly or monthly, set at install) rather than computed on the
fly, so every ledger row and assignment references a period by id.
Envelopes (`categories` grouped by `category_groups`) carry an `assigned`
amount per period; `available` is always computed, never stored. See
[the Phase 1 design spec](docs/superpowers/specs/2026-09-04-shiso-phase1-foundation-design.md)
(§4 for the schema, §7 for envelope semantics) for the full model.

History imported from statements lands in real periods for the ledger and spending pages, but envelope math starts at the `budget_start` setting (pinned at first startup to the earliest period), so backfilling never changes the live budget. Imports dedup against synced rows by amount within three days and correct the account's opening-balance row so the ledger keeps summing to the balance.

## Providers

- **Plaid** — primary provider, gives APR/minimum/due-date via Liabilities.
  The account is on the Trial plan: 10 Items max, and a used slot is never
  freed, so not every account can be on Plaid.
- **SimpleFIN** — secondary provider for accounts that don't fit on Plaid.
- **Manual / Apple Card CSV** — manual entry or CSV import; Apple Card is
  CSV-only under any provider.

## Sync schedule

node-cron runs three nightly jobs, each also mountable as a POST route so
they can be triggered from the UI:

| Env var | Default | Job |
|---|---|---|
| `SHISO_SYNC_HOUR` | 3 | Full transaction sync |
| `SHISO_BALANCE_HOUR` | 7 | Balance refresh |
| `SHISO_BACKUP_HOUR` | 4 | `VACUUM INTO` backup |
| `SHISO_BACKUP_KEEP` | 30 | Dated backups retained |

Other relevant env vars: `SHISO_TZ` (zone for calendar-date logic, default
`America/New_York`), `SHISO_CADENCE` (`semi_monthly` or `monthly`, fixed at
install), `SHISO_SCHEDULER` (set `off` to disable all three jobs — tests,
one-off runs), `SHISO_MIGRATIONS_DIR` (where `drizzle/` lives; required in
production). See `.env.example` for every key.

## Operations

- **Health**: `GET /api/health` returns pending-migration count, current
  period, and `lastSync`: an array with one `{ connectionId, finishedAt }`
  entry per connection, its most recent successful sync run (`[]` when none
  have synced yet); 200 when healthy, 503 otherwise. Per-connection sync
  status lives on the Accounts page.
- **Backups**: the nightly backup job writes a dated `VACUUM INTO` copy to
  `SHISO_BACKUP_DIR`, pruning down to `SHISO_BACKUP_KEEP`. Restore by
  stopping the service and copying a backup file over the live database.
- **Migrations**: on startup, if the database already exists and has
  pending migrations, a timestamped snapshot is written to the backup
  directory before they're applied (a brand-new database has nothing to
  snapshot). A failed migration leaves the snapshot in place and the
  process refuses to serve.

## Deployment

See [docs/deploy.md](docs/deploy.md) for the systemd/Caddy runbook (first
install, upgrades, restore, remote access).

## Sheet import

A one-time importer brings in pay-period balances, APR/fee history, and
account open dates from the old Google Sheet. See
[scripts/README-sheet-import.md](scripts/README-sheet-import.md).

## Phase 1 gaps

Out of scope for this phase (spec §12, plus a few carried from planning):

- Card-to-card transfers don't move either card's payment envelope.
- A provider moving a transaction between accounts is treated as a new
  transaction rather than a move.
- `loan` and `line_of_credit` Plaid liabilities aren't read for terms.
- The Ledger has no filter by transaction ids.
- Debt planner, payoff projections, and the promo sub-ledger (Phase 2);
  trends, outliers, and recurring detection (Phase 3); category targets and
  goals (Phase 4).
- No authentication — LAN and Tailscale are the boundary. No multi-user or
  multi-currency support.

## Layout

```
src/lib/server/
  budget/    envelope assignment, periods, ready-to-assign
  ledger/    transactions, splits, payee rules
  sync/      provider interface, connections, crypto, scheduler
  bills/     bill/income definitions, occurrence generation and matching
  read/      read-model queries backing the pages
  import/    one-time sheet import
src/lib/ui/  shared Svelte components
src/routes/
  api/       JSON routes (accounts, bills, budget, connections, health,
             income, occurrences, payee-rules, plaid, simplefin, sync,
             transactions, ...)
  budget/ ledger/ spending/ accounts/ bills/   the six pages (plus `/`)
```
