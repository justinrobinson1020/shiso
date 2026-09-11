# Shiso Plan 4: Targets and goals — Implementation Plan

**Goal:** Category targets with per-period need, progress, and one-click funding, from the Phase 4 spec.

**Spec:** `docs/superpowers/specs/2026-09-11-shiso-phase4-targets-design.md`. Conventions are Plan 1C's.

## Tasks, in order

1. **Schema.** `category_targets` in `schema.ts`; `drizzle/0004_category_targets.sql`; schema test. Commit.
2. **Targets module.** `budget/targets.ts`: pure `targetStatus(target, cell, ctx)` for the three kinds; service `setTarget`, `clearTarget`, `fundTargets` (uses `budgetForPeriod` + `assign`); `periodsThrough(db, periodId, date)`. Tests. Commit.
3. **Read models.** `read/budget.ts` adds `target` per category and `targetsNeeded`; `read/categories.ts` adds `target` per category. Tests. Commit.
4. **Routes.** `api/budget/targets`, `api/budget/targets/[categoryId]/clear`, `api/budget/fund-targets`. Tests. Commit.
5. **Pages.** Budget target column, strip, Fund buttons; Categories target editor. `npm run check`, browser check. Commit.
6. **Docs.** README, spec status. Commit.
