# Shiso Plan 3: Spending analytics — Implementation Plan

**Goal:** Trends, unusual charges, and recurring-charge discovery from the Phase 3 spec, on the Spending page and a Recurring sibling page.

**Spec:** `docs/superpowers/specs/2026-09-11-shiso-phase3-spending-analytics-design.md`. Conventions are Plan 1C's.

## Tasks, in order

1. **Pure modules.** `spending/stats.ts` (median, MAD, robust score), `spending/trends.ts` (monthly series, baselines, deltas), `spending/outliers.ts` (category and merchant scans), `spending/recurring.ts` (cadence detection with coverage callback). Tests per spec §6. Export `patternMatches` from `bills/matching.ts` for the coverage check. Commit.
2. **Read models.** `read/spending.ts` gains `trends` and `outliers` (one history query over the 12 months, partitioned around the range; `transactionId` added to split rows). `read/recurring.ts` builds the recurring page. Tests on the fixture. Commit.
3. **Pages.** Trends and Unusual charges sections on `/spending`; `/spending/recurring` page with a new-only toggle; link between them. `npm run check`, browser check at both widths against the production copy. Commit.
4. **Docs.** README page list; spec status. Commit.
