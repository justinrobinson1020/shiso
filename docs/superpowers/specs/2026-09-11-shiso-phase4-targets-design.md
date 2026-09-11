# shiso — Phase 4: Budgeting depth (targets and goals)

**Date:** 2026-09-11
**Status:** Approved design, pending implementation plan
**Scope:** Category targets (a rule for what each envelope should hold or receive), goal progress, and one-click funding on the Budget page. Section references are to the Phase 1 spec unless marked §P4.

## 1. Purpose

Phase 1's envelopes carry money forward and show what is available, but every period the user re-decides each assignment from memory. The sheet's monthly-budget tab was that memory: a fixed list of amounts per line. A target turns that list into a rule per category: assign this much each month, keep this much on hand, or reach this much by a date. The Budget page then shows what each envelope still needs this period and funds it in one click.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Target kinds | `monthly` (assign X per month), `refill` (keep X available), `by_date` (reach X available by a date) | The three rules that cover fixed bills, variable spending, and savings goals; the same three every envelope tool converges on |
| One target per category | `category_targets.category_id` is unique | A rule is a property of the envelope |
| Per-period arithmetic | Monthly amounts are divided by periods per month (2 on semi-monthly); by-date goals are spread evenly over the periods remaining, the current one included | The budget is per period; the target is stated in the unit the user thinks in |
| Funding | "Fund" sets the assignment to `assigned + needed` through the Phase 1 `assign` service; "Fund all" does it for every category with a positive need | Same write path as inline assignment; ready-to-assign is allowed to go negative and is already shown red |
| No envelope kinds | Targets are rejected for income, transfer, and reconciliation kinds | Those categories have no envelope (§7.2) |
| Editing | On the Categories page beside each category; the Budget page only reads and funds | One page per concern |

Rejected: a "spend by date" or "by date with repeat" kind (YAGNI); auto-funding on period rollover (the user wants to see the trade against ready-to-assign before it happens).

## 3. Data model

**category_targets**
- `category_id` (unique, references categories)
- `kind` (monthly | refill | by_date)
- `amount` (cents, > 0)
- `target_date` (date; required for `by_date`, null otherwise)
- `created_at`, `updated_at`

Invariants (checked by the targets service, the table's only writer): amount positive; the category has an envelope; `target_date` present exactly when the kind is `by_date`.

## 4. Derived quantities (§P4)

For category `c` with target `t` in period `P`, using §7 `assigned(c, P)`, `available(c, P)`, and `periodsPerMonth` (2 for semi-monthly, 1 for monthly):

- **monthly**: `perPeriod = round(amount / periodsPerMonth)`; `needed = max(0, perPeriod − assigned)`; `progress = min(1, assigned / perPeriod)`.
- **refill**: `needed = max(0, amount − available)`; `progress = min(1, max(0, available) / amount)`.
- **by_date**: `remaining = amount − (available − assigned)` (what is still missing before this period's own assignment); `n` = number of periods from `P` through the period containing `target_date`, at least 1 (a date already passed means everything is due now); `share = ceil(remaining / n)`; `needed = max(0, share − assigned)`; `progress = min(1, max(0, available) / amount)`; `periodsLeft = n`.

`needed` is what "Fund" assigns. A category whose need is zero is "on target". The page total is Σ `needed` over visible categories, shown beside ready-to-assign.

## 5. Screens

**Budget** — the envelope table gains a Target column: the rule in words ("$400 / mo", "keep $250", "$3,000 by Mar 2027 · 5 left"), a progress bar, and, when `needed > 0`, the amount with a Fund button. A strip above the table shows "Targets need $X this period" with a Fund all button when X > 0. Phones: the target reads as a subline under the category name; the Fund button stays in the row.

**Categories** — three inputs per category (kind, amount, date shown for by_date) plus clear. Saving posts the target; blank amount clears it.

## 6. Routes

- `POST /api/budget/targets` `{ categoryId, kind, amount, targetDate? }` — upsert.
- `POST /api/budget/targets/[categoryId]/clear` — delete.
- `POST /api/budget/fund-targets` `{ periodId, categoryId? }` — fund one category, or every category with a positive need. Returns `{ funded: [{ categoryId, amount }] }`.

## 7. Files

```
drizzle/0004_category_targets.sql
src/lib/server/db/schema.ts
src/lib/server/budget/targets.ts        needed/progress (pure) + service (setTarget, clearTarget, fundTargets)
src/lib/server/read/budget.ts           target per category, totals
src/lib/server/read/categories.ts       target per category for the editor
src/routes/api/budget/targets/**, fund-targets/
src/routes/budget/+page.svelte, categories/+page.svelte
```

## 8. Testing

- **pure**: each kind's need and progress; monthly halves on semi-monthly; by-date spreads over remaining periods and collapses to one when the date has passed; refill counts what is already available.
- **service**: upsert and clear; kind/date invariants; no-envelope kinds rejected; fund one and fund all assign exactly the need and are idempotent.
- **read model**: budget view carries targets and the total need; categories tree carries targets.
- **routes**: happy path and one invariant per route.

## 9. Out of scope

- Repeating goals, spend-by-date targets, auto-funding at rollover.
