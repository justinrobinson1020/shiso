# shiso — Phase 3: Spending analytics

**Date:** 2026-09-11
**Status:** Implemented (2026-09-11)
**Scope:** Trends, outliers against the user's own history, and recurring-charge discovery, on the Spending page (Phase 1 spec §8: "Phase 3 adds trends, outliers, and recurring detection here"). Section references are to the Phase 1 spec unless marked §P3.

## 1. Purpose

Phase 1's Spending page answers "what did I spend, on what, versus last time". Phase 3 answers three follow-ups the sheet never could: is this category drifting up over months, which single charges are out of line with my own history, and which merchants charge me on a schedule that I have not set up as a bill or noticed as a subscription.

All three are read-only derivations from the ledger. No new tables, no writes, no new provider calls.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| History window | The 12 calendar months ending with the month that contains the selected range's end | Long enough for yearly charges and seasonal categories; short enough to reflect current habits |
| Trend baseline | Mean of the category's monthly totals over the history window, excluding the current month | A per-category "normal month" the user can read at a glance |
| Outlier test | Robust z-score: `(amount − median) / (1.4826 × MAD)` over the category's history transactions, flagged above 3 with at least 8 history rows and a $25 floor | Median and median absolute deviation resist the outliers being hunted; the floor keeps a $6 coffee out of the list |
| Recurring detection | Group by cleaned payee; a candidate has ≥ 3 charges, a stable interval (weekly, biweekly, monthly, quarterly, yearly, within tolerance) and amounts within 15 % of the median | Matches how subscriptions and utilities actually post; tolerance covers tax and rate changes |
| Already-known filter | A candidate whose payee matches an active bill's `match_pattern` or name is shown as covered, not as a discovery | The point is to find what is missing from Bills |
| Scope kinds | Spending-like kinds only (Phase 1's default exclusion of bill, debt_payment, transfer, income, reconciliation applies); the "include" toggle carries over | Bills already have their own tracking |
| Placement | Trends and Unusual charges join the Spending page under the existing sections; Recurring is `/spending/recurring`, a sibling page | Recurring does not depend on the range picker and its table is long |

Rejected: a learned model for outliers (a robust score over the user's own data is explainable and has no training step); day-of-month pattern matching for recurring detection (interval regularity is enough and survives weekends and holidays).

## 3. Derived quantities

All money in cents; spending amounts are positive numbers (−Σ split amount, as on the Spending page). Definitions live in pure functions under `src/lib/server/spending/`.

### 3.1 Trends

For the selected range `R` with end month `M` and history months `M−11 … M`:

- `monthly(c, m)` = spending in category `c` in calendar month `m` (all splits with the page's filter applied).
- `baseline(c)` = mean of `monthly(c, m)` over `m ∈ M−11 … M−1` that lie inside the ledger (months before the first ledger row are excluded, not zero).
- `current(c)` = spending in `c` over `R`, scaled to a month when `R` is not a month: `current × 30 / days(R)`. The scaling is shown ("per month equivalent").
- `delta(c)` = `current(c) − baseline(c)`; `deltaPct` when the baseline is positive.
- The page shows the top categories by current spending with their 12-month sparkline, baseline, and delta, sorted by delta descending so the biggest movers lead. A category with a baseline below $10 is shown without a percentage.
- Total row: the same for all spending.

### 3.2 Unusual charges

For each transaction split in `R` (after the filter) with category `c` and amount `a`:

- History `H(c)` = amounts of spending splits in `c` over the 12 history months excluding `R` itself, at least 8 rows.
- `median`, `MAD = median(|h − median|)`; when `MAD = 0` use `0.1 × median` as the scale so a category of identical charges still flags a real jump.
- `score = (a − median) / (1.4826 × scale)`; flag when `score ≥ 3` and `a ≥ 2500`.
- The same test runs per merchant (payee) with `H(payee)`; a charge is listed once, with the reason that fired first (category, then merchant) and the multiple over the median ("4.2× your usual").

Output: date, payee, category, amount, usual (median), multiple, reason, with a link to the transaction in the Ledger.

### 3.3 Recurring charges

Over the 12 history months plus `R`, spending splits grouped by cleaned payee (across accounts):

- Sort charges by date. Intervals `d_i` between consecutive charges. A cadence matches when at least 75 % of intervals fall within its band: weekly 6–8 days, biweekly 13–15, monthly 27–33, quarterly 85–95, yearly 355–375. Pick the cadence with the most matching intervals; require ≥ 3 charges (≥ 2 for yearly).
- Amount stability: at least 75 % of amounts within 15 % of the median amount.
- `typical` = median amount; `last` = last charge date; `next` = last + cadence days; `overdue` when `next < today − 5 days`.
- `covered` = an active bill whose `match_pattern` matches the payee (through the same `patternMatches` as bill matching) or whose name equals the payee case-insensitively; otherwise `new`.
- Monthly cost = `typical × charges per year / 12`, so the table can total what recurring spending costs per month.

Output sorted: new first, then by monthly cost descending. Each row links to the Ledger filtered by the payee.

## 4. Screens

**Spending** gains, after "By merchant":

- **Trends** — a line of the 12 monthly totals (LineChart), then the category table: category, current (per-month equivalent when scaled), baseline, Δ, Δ%, sparkline. The range picker and filters apply.
- **Unusual charges** — the outlier table; an empty state says nothing stood out in this range against the last 12 months.

**Recurring** (`/spending/recurring`, linked from the Spending page heading and reachable from the nav's Spending item): the recurring table with a "new only" toggle, a totals line (recurring per month, and how much of it is not yet a bill), and a note on the detection rule.

Phones: Trends hides the sparkline column and shows Δ under the category name; Unusual hides "usual"; Recurring hides the cadence and last-charge columns behind sublines.

## 5. Files

```
src/lib/server/spending/stats.ts          median, MAD, robust score (pure)
src/lib/server/spending/trends.ts         monthly series and baselines from split rows (pure)
src/lib/server/spending/outliers.ts       outlier scan (pure)
src/lib/server/spending/recurring.ts      cadence detection (pure)
src/lib/server/read/spending.ts           trends and outliers added to SpendingView; history rows query
src/lib/server/read/recurring.ts          recurringView
src/routes/spending/+page.svelte          two sections
src/routes/spending/recurring/+page.server.ts, +page.svelte
```

## 6. Testing

- **stats**: median of odd and even lists; MAD; the zero-MAD scale rule.
- **trends**: baseline excludes the current month and months before the first ledger row; scaling for a period range; sort by delta.
- **outliers**: a 6× grocery charge flags with reason category; a merchant with a stable amount flags a doubled charge by merchant; nothing flags with fewer than 8 history rows; the $25 floor.
- **recurring**: a monthly subscription with one skipped month still matches; weekly coffee at varying amounts fails the stability test; a yearly charge with two occurrences matches; an active bill marks the payee covered; overdue flag.
- **read models**: the fixture produces the new sections and the recurring page.

## 7. Out of scope

- Writing rules or bills from a recurring row (a link to Bills prefilled is a Phase 4 candidate).
- Forecasting; seasonal adjustment.
