# shiso — Phase 2: Debt

**Date:** 2026-09-11
**Status:** Implemented (2026-09-11)
**Scope:** Terms history, promo sub-ledger, payoff planner with manual extras and avalanche/snowball suggestions, payoff projections, debt trend. Builds on the Phase 1 spec (`2026-09-04-shiso-phase1-foundation-design.md`); section references below are to that document unless marked §P2.

## 1. Purpose

The sheet's pay-period tab carried a Debt block (balance, accruing balance, rate, daily/monthly/yearly interest, annual fee, open date) and a Credit Cards block with a Minimum and an Additional column per card. Its trend tab rolled up total debt, accruing debt, paid, and paid as a share of income per pay period, and broke because the rollup was hand-copied. Phase 2 makes those views live from the ledger and balance history, and adds what the sheet could not do: a projection of when each debt is gone under a plan, and a comparison against avalanche and snowball orderings.

Phase 2 is one new page, **Debt**, plus one envelope rule the Phase 1 spec deferred (§12, card-to-card transfers). Nothing else changes for existing screens.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Plan unit | A planned extra per debt account per **period**, stored in `planned_extras` (§4.6) | The sheet's Additional column was per pay period; the budget is per period |
| Projection unit | Calendar months, up to 600 | Interest and minimums are monthly quantities; per-period extras are scaled by periods per month |
| Minimum payment | Latest terms `min_payment`, else the linked bill's expected amount, else none | Terms come from Plaid Liabilities; manual accounts have a bill; a debt with neither is shown as "no minimum" and never pays off in projection |
| Payment level | Fixed: Σ current minimums plus the extra pool, held constant until debt-free; a paid-off debt's minimum rolls into the target | This is the definition of snowball and avalanche; a shrinking-minimum model understates payoff and is what the sheet never modelled |
| Promo balances | A manual sub-ledger row per promotional balance: remaining amount, promo APR, expiry | Statements are the only source; Plaid does not itemise promo balances. `monthly_target` from §4.6 is derived (remaining ÷ months to expiry), not stored |
| Payment application | Minimum goes to the promo balance first, anything above it to the accruing balance first | The CARD Act rule; the approximation is stated in the UI |
| Card-to-card transfer | Moves the transferred amount from the receiving card's payment envelope to the paying card's | §12 deferred this to Phase 2 with exactly this rule |
| Trend source | `account_balances` snapshots at each period end, carried forward; payments and interest from the ledger | The sheet import already wrote period-end snapshots back to late 2024, so the trend has history from day one |
| No new terms editing | Terms are edited on Accounts as today; Debt shows the history read-only | One writer per table |

Rejected: storing projection results (they are a pure function of inputs and cheap); an amortisation-accurate daily-interest model (statement cycles vary per issuer and the sheet's monthly approximation was good enough for its purpose); automatic promo-balance decrement from payments (payment allocation across balances is issuer-specific and the user reads it off the statement anyway).

## 3. Data model

Two tables from §4.6, migrated now.

**planned_extras**
- `account_id`, `period_id`, `extra_amount` (cents, ≥ 0)
- unique on (`account_id`, `period_id`)
- `created_at`, `updated_at`

**promo_balances**
- `account_id`
- `description`
- `original_amount`, `remaining_amount` (cents, owed, positive)
- `apr_bps` (the promotional rate; usually 0)
- `expires_on` (date)
- `closed_at` (nullable; set when remaining reaches zero or the user closes it)
- `created_at`, `updated_at`

Invariants (checked by the debt service, one write path per table): `extra_amount ≥ 0`; `remaining_amount` between 0 and `original_amount`; the account is a debt account; `expires_on` is a date.

The `accounts.opened_on` column added by the sheet import is shown as the age of the account.

## 4. Derived quantities

All money is integer cents; rates are basis points. `owed(X)` is `−current` of the latest balance row for debt account X (zero when none). Definitions are pure functions in `src/lib/server/debt/`.

### 4.1 Per-debt figures (the sheet's Debt block)

- `promo(X)` = Σ `remaining_amount` over open promo balances of X, capped at `owed(X)`.
- `accruing(X)` = `owed(X) − promo(X)`.
- `apr(X)`, `promoApr(X)`, `minimum(X)`, `nextDue(X)`, `annualFee(X)` from the latest terms row; `minimum` falls back to the linked bill's `expected_amount`.
- Interest estimates: `yearly = accruing × apr / 10000 + Σ promo_i × promoApr_i / 10000`; `monthly = yearly / 12`; `daily = yearly / 365`, each rounded to cents. Annual fee is shown but not added to interest.
- Card underfunding (§7.4) stays on the Budget page; the Debt page uses the single `shortfall` measure of §P2 4.2 for cards and loans alike.

### 4.2 Plan for a period

For the selected period P (default: current):

- `extra(X, P)` from `planned_extras`, zero when absent.
- `planned(X, P)` = `minimum(X) + extra(X, P)`.
- `shortfall(X, P)` = `max(0, planned(X, P) − available(c_X, P))`, the amount the payment envelope still needs to hold to make the planned payment.
- `pool(P)` = Σ_X `extra(X, P)`, the extra that is on the table this period.

"Fund" for X sets `assigned(c_X, P)` to `assigned(c_X, P) + shortfall(X, P)` through the Phase 1 `assign` service. Funding twice is a no-op because the shortfall is then zero. Ready-to-assign falls by the same amount; the page shows it so the user sees the trade.

### 4.3 Projection

Input: for each open debt with `owed > 0`: `owed`, `accruing`, promo balances (`remaining`, `aprBps`, `expiresOn`), `aprBps`, `minimum`, `extra` (monthly). A strategy assigns the extra pool:

- **Plan**: each debt gets its own `extra(X, P) × periodsPerMonth`; a paid-off debt's minimum is not rolled.
- **Minimums**: extra is zero everywhere.
- **Avalanche**: the whole pool goes to the open debt with the highest `apr` (ties: larger balance); when it is gone, its minimum joins the pool.
- **Snowball**: the whole pool goes to the open debt with the smallest `owed`; same rollover.

Month step, for each debt in isolation:

1. Promo balances whose `expiresOn` is before the first day of this month fold into `accruing` (their remaining is added to it and they close).
2. Interest: `accruing × apr / 12` plus each promo `remaining × promoApr / 12`, rounded, added to `accruing` (promo interest accrues on the promo balance).
3. Payment = `min(minimum + extra, owed)`. The first `minimum` reduces promo balances (oldest expiry first), then accruing; the remainder reduces accruing, then promo.
4. The debt is paid off when `owed` reaches zero; record the month.

A debt whose payment for the month does not exceed that month's interest is **held flat**: no interest accrues, nothing is paid, and it is marked stalled. Under avalanche and snowball a stalled debt is re-examined every month, because a paid-off debt's minimum can grow the pool enough to reach it. The walk stops when every open debt is stalled, when every debt is paid off, or after 600 months. Output per strategy: per-debt payoff month or null (with a stalled flag), total interest paid, debt-free month or null, and a monthly series of total owed for the chart. A debt with no minimum and no extra therefore stalls in its first month. "Interest saved versus Minimums" is only reported when both the strategy and the Minimums baseline finish.

A provider minimum of zero is treated as unknown (Plaid reports zero for a card with no statement due), so the linked bill's expected amount is used instead.

The projection runs on every page load; with a dozen debts and 600 months it is a few thousand arithmetic steps.

### 4.4 Trend

One row per period from the earliest period with a debt balance snapshot to the current period:

- `total(p)` = Σ_X `owed` from the latest balance with `as_of ≤ p.end_date` (carried forward when a period has no snapshot for X).
- `change(p)` = `total(p) − total(p−1)`.
- `paid(p)` = Σ transfers from cash accounts whose peer is a debt account, plus Σ `debt_payment`-kind splits on cash accounts whose category's account is off-budget, in period p. Positive.
- `interest(p)` = −Σ `interest`-kind splits on debt accounts in period p.
- `income(p)` = Σ `income`-kind splits on cash accounts in period p.
- `paidShare(p)` = `paid / income` when income > 0.

Periods before the first ledger row show balances and change only; the ledger columns are blank rather than zero.

### 4.5 Card-to-card transfers (envelope rule, §7.2 addendum)

A transfer pair where both accounts are on-budget credit accounts: let A be the side with the negative amount (A's balance owed rises) and B the positive side. For the period of the pair, B's payment envelope gets a payment of the amount (its activity falls) and A's payment envelope gets money-in of the amount (its activity rises). Net effect on the sum of envelopes is zero, so §7.3 and §7.5 are unchanged; the property generator gains a `balance_transfer` event and the conservation test must keep passing.

## 5. Screen

**Debt** (`/debt`), in the nav after Budget. Four blocks in reading order, dense tables like Month.

1. **Debts** — one row per open debt account, sorted by APR descending (the avalanche order). Columns: account, owed, accruing, APR (promo APR beneath when present), monthly interest (daily and yearly beneath on desktop, as a subline on phones), minimum, due, annual fee, opened (as age). Totals row: owed, accruing, interest. A row expands to the terms history for that account (as-of, APR, promo APR, minimum, due, statement balance, fee, source).
2. **Plan** — period picker (same as Budget). One row per debt: minimum, extra (inline input, saved on change), planned, envelope available, shortfall, and a Fund button when the shortfall is positive. Totals: minimums, extras, planned. Ready-to-assign shown beside the totals so funding reads as a move.
3. **Payoff** — a strategy table: Plan, Minimums, Avalanche, Snowball × debt-free month, total interest, interest saved versus Minimums, first target. Below it, the projected total-owed line for the selected strategy (default Plan) and a per-debt payoff month list. A note states the approximation (monthly interest, fixed payments, payments applied minimum-to-promo-first).
4. **Promo balances** — table per open promo balance: account, description, original, remaining, promo APR, expires, months left, monthly target (`remaining ÷ months left`, red when the planned payment for that card is below it). Add, edit (remaining, expiry, description), close.
5. **Trend** — the total-owed line per period over the full history, then the table from §P2 4.4 with the most recent period first.

Empty states: no debt accounts → one sentence pointing to Accounts; no balances → the Debts table shows "no balance" per row and projection is skipped.

## 6. Routes

All `POST`, JSON, through `handle` (§9 conventions). Each calls the debt service; nothing writes `planned_extras` or `promo_balances` elsewhere.

- `POST /api/debt/extras` `{ periodId, accountId, extraAmount }` — upsert; `extraAmount` 0 deletes the row.
- `POST /api/debt/fund` `{ periodId, accountId }` — assigns the shortfall (§P2 4.2). Returns `{ assigned }`.
- `POST /api/debt/promos` `{ accountId, description, originalAmount, remainingAmount?, aprBps, expiresOn }` — create; remaining defaults to original.
- `POST /api/debt/promos/[id]` `{ description?, remainingAmount?, aprBps?, expiresOn? }` — update; remaining 0 closes.
- `POST /api/debt/promos/[id]/close` — sets `closed_at`.

Invariant violations (non-debt account, negative amounts, remaining above original) are `InvariantError` → 409; shape errors are 400.

## 7. Files

```
drizzle/0003_debt_plan.sql                     planned_extras, promo_balances
src/lib/server/db/schema.ts                    the two tables
src/lib/server/debt/interest.ts                accruing, estimates (pure)
src/lib/server/debt/projection.ts              strategies, month step, series (pure)
src/lib/server/debt/trend.ts                   per-period rows from balances + splits
src/lib/server/debt/plan.ts                    service: setPlannedExtra, fundShortfall, promo CRUD
src/lib/server/budget/envelope.ts              §P2 4.5 rule
src/lib/server/budget/envelope.property.test.ts balance_transfer event
src/lib/server/read/debt.ts                    debtView
src/routes/debt/+page.server.ts, +page.svelte  the page (+ PromoEditor.svelte)
src/routes/api/debt/**                         the five routes
src/routes/+layout.svelte                      nav link
src/lib/ui/LineChart.svelte                    a labelled line (Sparkline with axes) for payoff and trend
```

## 8. Testing

- **interest.ts**: estimates with and without promo; promo capped at owed; zero APR.
- **projection.ts**: one card pays off in the expected month; avalanche targets the higher APR and snowball the smaller balance on a two-debt fixture; rollover shortens the second payoff; a promo folds into accruing after expiry; no minimum and no extra never pays off; the 600-month cap; total interest under Minimums ≥ under Avalanche.
- **trend.ts**: carry-forward across a period with no snapshot; paid counts cash→card transfers and off-budget loan splits once each; interest from interest-kind splits; blank ledger columns before the first transaction.
- **envelope**: a card-to-card transfer moves envelope activity and leaves ready-to-assign unchanged; property test with the new event.
- **plan.ts**: upsert and delete-on-zero; fund is idempotent; non-debt account rejected; remaining above original rejected.
- **read/debt.ts**: the fixture with a card and a loan produces the four blocks with the expected totals.
- **routes**: one happy path and one invariant violation per route, asserting on the database.

## 9. Out of scope

- Automatic promo decrement from payments or statements.
- Daily-accrual or statement-cycle interest models.
- Editing terms on the Debt page.
- Interest-rate change alerts, payoff goals (Phase 4).
