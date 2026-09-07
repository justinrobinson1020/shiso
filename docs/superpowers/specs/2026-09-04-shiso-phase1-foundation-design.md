# shiso — Phase 1: Foundation

**Date:** 2026-09-04
**Status:** Approved design, pending implementation plan
**Scope:** Replace the Google Sheet. Bank sync, ledger, bills, envelope budgeting, monthly cash-flow view, spending breakdowns.

## 1. Purpose

shiso is a single-user personal finance dashboard that runs on the homelab and
replaces a Google Sheet used for bill tracking, debt payoff, and spending
tracking. The sheet tracked semi-monthly pay-period snapshots of bills, card
minimums and extra payments, account balances, and per-debt interest. Its
trend rollup broke because derived values were hand-copied between tabs.

The product is built in four phases, each with its own spec, plan, and build:

1. **Foundation** (this spec): sync, ledger, bills and income, envelope
   budgeting on semi-monthly periods, Month view, Spending breakdowns.
2. **Debt**: terms history, promo sub-ledger, planner with manual extras and
   avalanche/snowball suggestions, payoff projections, debt trend.
3. **Spending analytics**: trends, outliers against own history,
   recurring-charge discovery.
4. **Budgeting depth**: targets, goals, and whatever the envelope model turns
   out to need after real use.

Phase 1 must ship with the schema hooks phases 2–4 read, so they are additive
migrations rather than rewrites.

## 2. Decisions and constraints

| Decision | Choice | Why |
|---|---|---|
| Unit of data | Transactions, with balances as append-only history | Spending analysis needs transactions; the sheet's snapshots become a derived view |
| Data source | Live sync, Plaid primary, SimpleFIN and manual behind one interface | Plaid Liabilities returns APR, minimum, and due date; the Trial plan caps Items at 10 and never frees a slot, so not every account will be on Plaid |
| Where it runs | One LXC on the homelab, LAN only, no login | Matches the fleet; Tailscale covers remote; single user |
| Reporting cadence | Monthly | Income is fixed; the pay-period tabs collapsed to a monthly cash view |
| Budgeting model | YNAB-style envelopes on semi-monthly periods | Every dollar assigned per paycheck; envelopes carry forward |
| Bill status | Auto-match from transactions with manual override | Payee strings are stable for most bills; override covers the rest |
| Bills vs subscriptions | Bills are paid from cash accounts; subscriptions charged to cards are spending categories | They behave differently and are tracked differently |
| Extra card payments | A plan input, not just a record | "If I pay X extra on this card, what happens to net cash" is the question |
| Stack | SvelteKit, Drizzle, better-sqlite3 (WAL), node-cron, one Node process | Single process keeps envelope invariants atomic; SQLite file is the backup unit |
| Money | Integer cents, converted at the provider boundary | No float drift |
| Sign convention | From the account's point of view: purchase on a card is negative, payment to the card is positive | YNAB convention; transfers are equal and opposite |

Rejected: a Python API plus separate frontend (two languages and build trees to
buy a pandas option that `pd.read_sql` against the SQLite file already gives),
and building on Actual Budget (calendar-month budgeting only, no Plaid, its
model would fight the pay-period and debt-planner design).

## 3. Architecture and deployment

### 3.1 Host

- A new Debian LXC on the services VLAN (10.10.50.x), alongside grafana and
  homarr. Node LTS installed directly. No Docker; nothing else on the fleet
  uses it.
- shiso runs as a systemd service under a dedicated user, listening on an
  internal port. `Restart=on-failure`, `RestartSec=30`, and a start limit so a
  refused-to-serve migration failure does not become a restart loop.
- Caddy (CT 130) gets a vhost so shiso is reachable by hostname on the LAN.
  Tailscale (CT 123) covers access from outside without app auth.
- PBS backs up the container. In addition, a nightly `VACUUM INTO` writes a
  dated copy of the database into a backup directory inside the container, so
  restore can be whole-container or one file.

### 3.2 Process

- SvelteKit serves pages and API routes from one tree.
- Drizzle over better-sqlite3 in WAL mode owns the schema. Migrations run at
  startup. If pending migrations exist, the process first runs `VACUUM INTO`
  a snapshot named with the timestamp and the target migration, then applies.
  A failed migration leaves the snapshot in place and the process refuses to
  serve.
- node-cron schedules a nightly full sync and a morning balance refresh. Both
  jobs are plain functions that are also mounted as POST routes (`/api/sync`,
  `/api/sync/[connectionId]`) so they can be triggered from the UI. A
  per-connection mutex serializes manual and scheduled runs.
- A health route reports the last successful `sync_runs` row per connection.

### 3.3 Secrets

- Environment file, readable only by the service user: Plaid client ID and
  secret, Plaid environment, and one application key.
- Per-connection credentials (Plaid access tokens, SimpleFIN access URLs) are
  stored in `connections.credential_enc`, encrypted with the application key.
  A copied database file is not a copied bank login.
- Missing required environment values fail startup with a named message.
- `SHISO_TZ` (default `America/New_York`) names the zone in which calendar
  dates are computed. Period boundaries, the current period, and overdue
  checks use the local calendar date, never UTC, because provider posted
  dates are calendar dates. Timestamps stay UTC.
- `SHISO_MIGRATIONS_DIR` points at the `drizzle/` folder. It defaults to the
  repository's in development and must be set in production, where the
  deploy ships `drizzle/` beside `build/`.

### 3.4 Provider interface

```ts
interface SyncProvider {
  kind: 'plaid' | 'simplefin' | 'manual';
  fetch(connection, sinceCursor): Promise<SyncBatch>;  // async, network only
}
// SyncBatch: { accounts, balances, added, modified, removed, terms, nextCursor }
```

Providers only fetch. Applying a batch to the database is provider-agnostic
and synchronous (see §5). The rest of the app never sees a provider type; it
sees accounts, balances, transactions, and terms, each with a `source` column.

## 4. Data model

All amounts are integer cents. All tables have `id` (integer primary key),
`created_at`, `updated_at` unless noted. Phase 1 creates every table below
except those marked *Phase 2*, whose foreign keys are designed now.

### 4.1 Connections and accounts

**connections**
- `provider` (plaid | simplefin | manual)
- `institution_name`
- `external_item_id` (Plaid item id; null otherwise)
- `credential_enc` (encrypted access token or access URL; null for manual)
- `status` (active | needs_relink | error | disabled)
- `cursor` (Plaid transactions cursor; SimpleFIN last-fetch date)
- `last_success_at`, `last_error`

**accounts**
- `connection_id`
- `external_id` (unique per connection)
- `name`, `official_name`, `mask`
- `type` (checking | savings | cash | credit | loan | investment)
- `on_budget` (bool). Checking, savings, cash, and credit default true; loan
  and investment default false.
- `is_debt` (bool). Credit and loan default true.
- `closed_at`

Ready-to-assign reads only `on_budget = true AND type IN ('checking',
'savings', 'cash')`. Credit accounts are on-budget for categorization and are
never in that sum. The query names the three types explicitly.
A closed account contributes zero cash; its historical transactions still count
toward envelopes.

**account_balances** (append-only)
- `account_id`, `as_of` (date), `current`, `available`, `credit_limit`
- `source` (sync | manual | import)
One row per sync per account. This is the debt trend for Phase 2 and the
import target for the sheet's history.

**account_terms** (append-only, insert on change)
- `account_id`, `as_of`
- `apr_bps` (purchase APR, basis points), `promo_apr_bps`
- `min_payment`, `next_due_date`
- `last_statement_balance`, `last_statement_date`
- `annual_fee`
- `source` (provider | manual)
A sync inserts a row only when at least one value differs from the latest row
for that account. Manual edits always insert.

### 4.2 Ledger

**transactions**
- `account_id`
- `external_id` (unique per account; content hash for manual/CSV and as
  SimpleFIN fallback)
- `pending_external_id` (provider id of the pending row this posted row
  replaces; null otherwise)
- `posted_date`, `transacted_at`
- `amount` (signed, account's point of view)
- `payee_raw`, `payee` (cleaned), `memo`
- `pending` (bool)
- `provider_category`
- `period_id` (budget period; defaults from posted date, or transacted date
  while pending; user-reassignable)
- `transfer_peer_id` (self-reference; both halves link each other)
- `deleted_at` (set when the provider removes it or the user deletes it;
  never hard-deleted)
- `needs_review` (bool), `review_reason`
- `processed_at` (nullable; set when post-processing has run on the row)
- `source` (sync | manual | import | opening | adjustment)

**transaction_splits**
- `transaction_id`, `category_id`, `amount`, `memo`
Every transaction has at least one split. Splits sum to the transaction
amount (enforced by the ledger service, §10). Category lives only here.

**bill_occurrence_transactions**
- `bill_occurrence_id`, `transaction_id`
Join table; one occurrence can be covered by many transactions (a card
minimum and an extra paid separately).

**payee_rules**
- `pattern` (case-insensitive substring or regex), `payee` (cleaned name),
  `category_id` (nullable default category), `priority`
Learned when the user edits a payee or category and opts to create a rule.
Applied to new transactions before transfer detection and bill matching.

### 4.3 Budget

**category_groups**: `name`, `sort`, `hidden`

**categories**
- `group_id`, `name`, `sort`, `hidden`
- `kind` (spending | bill | debt_payment | interest | fee | income |
  transfer | savings | reconciliation)
- `account_id` (nullable; required when kind is debt_payment; each debt
  account has at most one debt_payment category)

Kinds drive views: Month separates bills from spending; Spending excludes
bill, debt_payment, transfer, income, and reconciliation by default; Phase 2
reads interest and fee for principal-vs-interest without payee regex.

**periods**
- `start_date`, `end_date`, `label`
Generated from the cadence setting. Semi-monthly means the 1st–15th and the
16th–month end. A period is a row so it can be referenced, not recomputed.
Generation back-fills from the earliest transaction or balance date present
(a first Plaid sync can return two years; the sheet import reaches late 2024)
and runs forward through the next period, before any row is assigned a
`period_id`. The cadence is fixed at install. Changing it once periods exist
is unsupported in Phase 1: rows are deduplicated on start date only, so a
switch would leave overlapping periods, and a real change needs a period
rebuild plus reassignment of every transaction and assignment.

**budget_assignments**
- `period_id`, `category_id`, `assigned` (unique on period + category)
Available is computed, never stored (§7).

### 4.4 Bills and income

**bills**
- `name`, `category_id`, `pay_from_account_id`
- `expected_amount`, `tolerance_abs`, `tolerance_pct`
- `cadence` (monthly | semi_monthly | every_n_weeks | yearly), `due_day`,
  `interval`, `anchor_date`
- `autopay` (bool), `match_pattern`
- `linked_debt_account_id` (nullable; set for card and loan payments)
- `active` (bool)

**bill_occurrences**
- `bill_id`, `due_date`, `period_id`
- `expected_amount`, `statement_balance` (nullable; from terms for card bills)
- `status` (pending | paid | overdue | skipped)
- `paid_amount`, `extra_amount` (paid minus expected, floored at zero, for
  debt bills)
- `marked_by` (auto | manual | null)
- `window_start`, `window_end`
Materialized ahead one period at a time. Paid amount is derived from linked
transactions; for card bills the linked set is every transfer to the linked
account inside the window.

**income_sources** and **income_occurrences**: same shape as bills and
occurrences with `deposit_account_id`, positive expected amounts, and no debt
linkage. Occurrences give "cash coming in."

### 4.5 Operations

**sync_runs**
- `connection_id`, `trigger` (cron | manual | startup)
- `started_at`, `finished_at`, `status` (running | ok | error)
- `start_cursor`, `end_cursor`
- `added`, `modified`, `removed`, `balances_written`, `terms_written`
- `error`

**settings**: `key`, `value` (JSON). Cadence, sync hours, grace days,
transfer window, pending convention overrides per account.

### 4.6 Phase 2 tables (designed now, migrated later)

- **planned_extras**: `account_id`, `period_id`, `extra_amount`
- **promo_balances**: `account_id`, `description`, `original_amount`,
  `remaining_amount`, `expires_on`, `monthly_target`

## 5. Sync pipeline

### 5.1 Run shape

1. Acquire the connection mutex. Insert a `sync_runs` row with
   `start_cursor` = the connection's current cursor.
2. **Fetch** (async): the provider fetches every page into memory. Nothing is
   written during fetch.
3. **Apply** (sync, one database transaction): periods ensured for the
   batch's date range (from the minimum over rows of the transacted date and
   posted date, since pending rows take their period from the transacted
   date), accounts upserted, balances appended, terms appended on change,
   transactions added/modified/removed, pending reconciliation, cursor
   written, `sync_runs` closed.
4. Post-process (§5.6), generate occurrences (§6.1), run matching (§6.2).
5. Release the mutex.

Post-processing is not batch-scoped. It selects transactions where
`processed_at IS NULL`, whichever run inserted them, and sets `processed_at`
when done. A crash between steps 3 and 4 therefore loses nothing: the next
run, or the startup trigger, picks the rows up. Occurrence generation and
matching are idempotent by construction and run on the same trigger.

Because better-sqlite3 is synchronous and the write transaction opens only
after the last page arrives, no write lock is held across a network call and
the UI never waits on a provider.

### 5.2 Plaid

- **Link**: the server mints a link token; the browser runs Plaid Link from
  the Accounts page; the server exchanges the public token and stores the
  encrypted access token on a new connection. Update mode reuses the same
  page for `needs_relink`.
- **Transactions**: `/transactions/sync` with the stored cursor, paging
  until `has_more` is false. On `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`
  the in-memory buffer is cleared and fetching restarts from `start_cursor`.
- **Balances**: taken from the accounts in the sync response; appended to
  `account_balances`.
- **Liabilities**: `/liabilities/get` once per run per Item; mapped to
  `account_terms` and inserted on change. The per-statement interest charge is
  kept for cross-checking interest-kind splits, not used as a source.
- **Item errors**: `ITEM_LOGIN_REQUIRED` and equivalents set
  `status = needs_relink`. Other errors set `status = error` with the text on
  the run and the connection.

### 5.3 SimpleFIN

- One GET against the access URL with `start-date` a configurable number of
  days before `last_success_at`, so recently changed transactions are
  re-fetched.
- Dedup: `external_id` first, then the content hash (account, date, amount,
  description, ordinal among identical rows).
- No removal events. A pending row we hold that does not reappear in a fetch
  whose window covers it is a candidate for heuristic pending reconciliation.
- No terms.

### 5.4 Manual

- No sync. Balances entered by hand append `account_balances` with
  `source = manual`.
- CSV import (Apple Card format first) creates transactions with the content
  hash as `external_id`, so re-importing an overlapping file is idempotent.
- Terms entered by hand append `account_terms` with `source = manual`.

### 5.5 Pending reconciliation

- **Plaid**: a new posted transaction whose `pending_transaction_id` matches a
  pending row we hold inherits that row's splits, payee, memo, `period_id`,
  transfer link, and bill links; the pending row is soft-deleted with a
  reference to its replacement.
- **SimpleFIN**: a new posted transaction on the same account with the same
  amount within three days of a pending row that was not returned in this
  fetch inherits the same way. Ambiguity (two candidates) leaves both rows and
  flags the new one for review.

### 5.6 Post-processing (rows with `processed_at IS NULL`, in this order)

1. **Opening balance** (first sync of an account only): insert a transaction
   with `source = opening`, amount = provider balance − Σ synced
   transactions, categorized to the reconciliation kind. The ledger sums to
   the balance from day one.
2. **Payee rules**: first matching rule by priority sets `payee` and, if the
   rule has one, the split category.
3. **Transfer detection**: two unlinked transactions on two of the user's
   accounts, opposite signs, equal amounts, at least one on a cash-type
   account, within the configured window. If both accounts are on-budget,
   both get the transfer kind and link as peers (overriding any rule
   category; a transfer is structural). If the far side is off-budget, the
   near side is categorized to the far account's debt_payment category when
   it has one, otherwise flagged. With multiple candidates, prefer the pair
   whose payees look like a payment or transfer; if still tied, leave
   unlinked and flag for review.
4. **Bill and income matching** (§6.2).
5. **Default category**: provider category mapping, else uncategorized.

Modified events from a provider touch only amount, dates, pending flag, and
`payee_raw`. If the amount changes on a single-split transaction the split
follows. On a multi-split transaction the row is flagged for review. User
edits are never overwritten by sync.

### 5.7 Removals

A removed transaction is soft-deleted. Any auto-marked occurrence it covered
is recomputed and returns to pending if nothing else covers it. Its transfer
peer is unlinked and flagged for review. Manual marks are untouched.

### 5.8 Reconciliation and drift

For every account the Accounts page shows drift = provider balance − Σ
non-deleted transactions, using a per-type pending convention: cash-type
accounts compare against `current` excluding pending transactions; credit
accounts compare including pending. The convention is overridable per
account in settings. Non-zero drift after a sync creates a review-queue item
offering a one-click adjustment transaction (`source = adjustment`,
reconciliation kind).

## 6. Bills and income

### 6.1 Occurrence generation

Runs at the end of every sync and once a day. For each active bill, ensure
occurrences exist through the end of the next period.

- Due date from cadence: monthly on `due_day` with month-end clamping;
  semi-monthly on two days; every N weeks from `anchor_date`; yearly.
- For a bill with a `linked_debt_account_id` whose latest `account_terms`
  row has `next_due_date`, that date wins over the cadence, `expected_amount`
  is the terms' `min_payment`, and `statement_balance` is carried on the
  occurrence.
- Window: for debt bills, `last_statement_date` (or due date − 25 days if
  unknown) through due date + grace. For other bills, due date − 10 days
  through due date + grace. Grace is a setting.

### 6.2 Matching

Candidates are non-deleted transactions on the pay-from account with the
right sign whose posted date is inside the window and which are not already
linked to another occurrence. Occurrences are matched in due-date order, so
when consecutive debt-bill windows overlap (statement date to due date plus
grace), the earlier occurrence claims a payment first and the outcome does
not depend on visit order.

- **Debt bills**: every transfer whose peer is on the linked debt account is
  linked; paid amount is their sum. This signal outranks payee patterns: a
  transfer from checking to Sapphire is the Sapphire payment by definition.
- **Other bills**: amount within tolerance and payee matches
  `match_pattern`. Candidates are ranked by amount distance from expected,
  then by date distance from due; the top candidate is linked. A tie on both
  flags the occurrence for review instead of linking.
- Status becomes paid when paid amount ≥ expected − tolerance, `marked_by =
  auto`. `extra_amount` = max(0, paid − expected) for debt bills.
- Pending occurrences with due date < today − grace become overdue.
- Manual actions: mark paid (with a chosen transaction, or none), unmark,
  skip. Manual marks are never changed by matching or removals.

Income mirrors this with positive amounts on the deposit account.

## 7. Envelope semantics

All quantities are pure functions of ledger rows. Nothing here is stored.

### 7.1 Definitions

For category `c` and period `p`:

- `splits(c, p)` = Σ split amounts for non-deleted transactions with
  `period_id = p` on on-budget accounts (cash-type and credit), category `c`.
- `card_splits(c, p, X)` = the same restricted to account `X`.
- `gross_available(c, p)` = `carried(c, p) + assigned(c, p) + splits(c, p)`
  for non-debt_payment categories.
- `credit_overspend(c, p)` = `min(max(0, −gross_available(c, p)),
  max(0, −Σ_X card_splits(c, p, X)))` for spending-like kinds. The outer
  clamp on the card term matters in a net-refund period, where card splits
  sum positive and would otherwise yield a negative overspend. A shortfall is charged
  to card spending first, capped at that period's card splits; the remainder
  is cash overspend. This is the only place the term is defined.
- `cash_overspend(c, p)` = `max(0, −gross_available(c, p)) −
  credit_overspend(c, p)`.
- `credit_overspend_on_X(c, p)` = `credit_overspend(c, p) ×
  max(0, −card_splits(c, p, X)) / Σ_Y max(0, −card_splits(c, p, Y))`, with
  largest-remainder rounding so the shares sum exactly. When spending in an
  overspent category was split across several cards, the shortfall is
  attributed in proportion to net purchases on each card; a card that netted
  a refund in that category gets no share.
- "Spending-like" means every kind except debt_payment for an on-budget
  credit account, transfer, income, and reconciliation. A loan's
  debt_payment category is spending-like for these definitions, and so is
  the debt_payment category of an off-budget credit account: its purchases
  never moved money out of an envelope, so its payments are budgeted like a
  loan payment.

### 7.2 Available

- **Spending, bill, interest, fee, savings kinds**:
  `available(c, p) = gross_available(c, p)`.
  `carried(c, p) = max(0, available(c, p−1))`. Cash overspend is zeroed at
  rollover; the shortfall reduces ready-to-assign because the cash is gone.
- **Debt payment category for credit account X**:
  `activity(c, p) = −Σ_{c'} card_splits(c', p, X)` over spending-like
  categories `c'` **minus** `Σ_{c'} credit_overspend_on_X(c', p)` **minus**
  payments made to X in `p` (transfers whose peer is on X, from the envelope's
  point of view).
  `available(c, p) = carried(c, p) + assigned(c, p) + activity(c, p)`.
  `carried(c, p) = available(c, p−1)`, no floor, nothing else. Uncovered
  spending never enters the envelope, so it is not subtracted again at
  rollover.
- **Debt payment category for a loan account**: activity is simply
  `splits(c, p)`; carry floors at zero like a bill.
- **Income, transfer, and reconciliation kinds** have no envelope. Income
  reaches the budget only as cash, through ready-to-assign.

Computed recursively from the first period with memoization. A late
transaction reassigned into a past period changes that period's numbers and
every carry after it, which is correct.

### 7.3 Ready to assign

For the current period `P`:

```
cash        = Σ latest current balance of accounts where on_budget
              AND type IN ('checking','savings','cash')
RTA(P)      = cash − Σ_c max(0, available(c, P)) − Σ_{p > P} Σ_c assigned(c, p)
```

Past periods have history, not a live RTA. Future periods show RTA(P) minus
their own assignments.

### 7.4 Card underfunding

For credit account X with payment category `c`:
`underfunded(X) = max(0, balance_owed(X) − available(c, P))`. This is the
number Phase 2's planner attacks with planned extras, which are assignments
to `c` with a projection attached.

### 7.5 Conservation property

Ready-to-assign computed from balances (§7.3) must equal ready-to-assign
computed from flows on a reconciled ledger:

```
RTA_flows(P) = Σ opening-balance amounts on cash-type on-budget accounts
             + Σ income-kind splits on cash-type on-budget accounts through P
             + Σ adjustment amounts on cash-type on-budget accounts through P
             − Σ_{p ≤ P} Σ_c assigned(c, p)
             − Σ_{p ≤ P} Σ_c cash_overspend(c, p)
             − Σ_{c ∈ card payment envelopes} max(0, −available(c, P))
             − Σ_{p > P} Σ_c assigned(c, p)
```

Why each of the last three terms: cash overspend in the current period has
already left the bank, so §7.3 sees it immediately and the sum must be
inclusive of P. A card payment envelope has no floor and can sit negative
(paying a card above its envelope; a refund landing after a partly uncovered
purchase), and §7.3 ignores negatives, so flows subtract it explicitly. This
is the "cover overspending in the payment category" state and resolves when
money is moved. Future assignments are subtracted in §7.3 and must be here.

Derivation sketch: expand `Σ_c max(0, available(c, P))` as
`Σ_c available(c, P) + Σ_c max(0, −available(c, P))`; unroll the floored
carry for spending-like kinds into `Σ_{p<P} overspend`; the card splits in
spending-like envelopes cancel against the card envelopes' activity; the
credit-overspend terms telescope to `−credit_overspend(P)`, which cancels
against the current period's negative spending-like availables; what remains
is the formula above.

Note the naive form "Σ available + RTA = cash" is false whenever any envelope
is negative. The two-way computation is the non-tautological invariant.

## 8. Screens

Six pages. Everything else is a dialog on one of them.

- **Month** (landing): cash on hand by account; income expected and
  received; bills paid and pending with due dates; planned card payments;
  cash left at month end. Checking balance trend once history exists.
- **Budget**: envelope grid for the selected period, grouped, with assigned,
  activity, available; ready-to-assign at the top; card underfunding strip.
  Inline assignment. Dialogs: move money, category management (create,
  rename, group, hide, set kind and linked account).
- **Ledger**: transactions across accounts or one account; inline payee and
  category editing; split editor; period reassignment; the review queue with
  its count shown in the nav. Editing a payee offers to create a payee rule.
- **Spending**: shared range picker (period, month, quarter, year, custom)
  with compare-to-previous. By category: breakdown with amount and share,
  drill-down to Ledger. By merchant: top cleaned payees with count and total.
  Over time: per-period or per-month stacked bars by category with a total
  line and the previous range ghosted when compare is on. Filters for
  account, category group, and merchant apply to all three. Bill,
  debt_payment, transfer, income, and reconciliation kinds excluded by
  default with a toggle. Phase 3 adds trends, outliers, and recurring
  detection here.
- **Accounts**: connections and status; last sync and last error per
  connection; relink and manual sync; drift per account with the adjustment
  action; terms per debt account with source shown and manual edit; manual
  balance entry; CSV import.
- **Bills**: bill and income definitions; occurrence history per bill.

## 9. Error handling

- **Sync failures are per connection and visible.** One connection failing
  never aborts another. Every failure lands in `sync_runs` with the provider
  error text; the Accounts page shows last success and last error.
  `needs_relink` is a status with a button, not an error string.
- **Sync never guesses.** Ambiguous cases (multi-split amount change, transfer
  with tied candidates, removal that unmatched a bill, ambiguous pending
  reconciliation, non-zero drift) go to the review queue.
- **Envelope invariants live in one place.** A ledger service owns every
  write to transactions, splits, assignments, links, and occurrences. Each
  operation runs in one database transaction and checks: splits sum to the
  transaction amount; a debt_payment category has an account and is unique
  per account; transfer peers are equal and opposite; an occurrence's linked
  transactions are on its pay-from account. Routes call the service; nothing
  writes those tables directly.
- **Startup is conservative.** Missing secrets fail startup by name. A failed
  migration leaves the pre-migration snapshot and refuses to serve; systemd
  backs off rather than looping.

## 10. Testing

- **Envelope math**: pure functions from ledger rows to numbers. Hand-built
  scenarios: the $80 grocery on Sapphire with $50 available; cash and card
  overspend in the same period; a late transaction reassigned into a past
  period; a loan payment; a card paid in two transfers; a period with no
  assignments.
- **Conservation property**: RTA from balances equals RTA from flows (§7.5),
  as a property test over randomly generated reconciled ledgers.
- **Sync**: recorded fixture batches per provider covering added, modified,
  removed, pending-to-posted (explicit and heuristic), the mutation error,
  and the opening-balance insert, applied to an in-memory database. No test
  touches a live provider; Plaid Sandbox is for manual smoke tests.
- **Matching**: table tests for bill, income, and transfer detection,
  including refund-versus-payment within the window, a card paid in pieces,
  and a payment inside two overlapping debt-bill windows.
- **Periods**: a fixture whose earliest transaction predates the first
  configured period by two years, asserting back-fill and assignment.
- **Recovery**: a fixture that applies a batch and crashes before
  post-processing, asserting the next run processes the rows.
- **Routes**: one happy path and one invariant violation per mutating route,
  asserting on the database.

## 11. Sheet import

A one-time script, not a feature. It reads the pay-period tabs of the Google
Sheet export and writes:

- `account_balances` rows dated at each period boundary for every debt
  account and for Checking, `source = import`.
- `account_terms` rows for each tab where a debt account's APR differs from
  the previous tab, dated at that period's boundary, with the open date from
  the tab, `source = manual`. Phase 2 then has the rate in force for each
  balance snapshot.

Bills, subscriptions, and income sources are created by hand during setup.

## 12. Out of scope for Phase 1

- Debt planner, payoff projections, promo sub-ledger (Phase 2).
- Trends, outliers, recurring detection (Phase 3).
- Category targets and goals (Phase 4).
- Any authentication. LAN and Tailscale are the boundary.
- Multi-user, multi-currency.
- **Card-to-card transfers touch no envelope.** A balance transfer from one
  card to another is a transfer-kind pair; §7.2 counts only cash-to-card
  transfers as payments and only spending-like splits as money in, so
  neither card's payment envelope moves. The conservation identity still
  holds (no cash moved, no envelope changed) but the paying card's
  underfunding drops and the receiving card's rises with no budget event.
  Phase 2's promo sub-ledger is exactly this case and will add the rule
  (move the amount from the paying card's envelope to the receiving card's)
  and a `balance_transfer` event to the property generator.

## 13. Open items to confirm during setup

- ~~Liabilities on the Trial plan~~ Closed: Plaid's help center lists
  Liabilities among the Trial plan's eight bundled products (the billing docs
  page contradicts this; the help center is the newer source). The 10-Item
  cap and non-recoverable slots stand.
- Institution count against the 10-Item cap, especially whether the
  Synchrony cards (Amazon Store, Sweetwater, PayPal Credit) share one login.
  Highest-value institutions go on Plaid first; store cards go on SimpleFIN
  or manual.
- The checking bank, which is unnamed in the sheet.
- Apple Card is CSV-only under any provider.
