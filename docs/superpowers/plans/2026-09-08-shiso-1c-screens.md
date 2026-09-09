# Shiso Plan 1C: Screens, Deployment, Sheet Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the six spec §8 screens on top of the 1A/1B services, make the process deployable on the homelab LXC (backup job, clean shutdown, systemd, Caddy), and ship the one-time Google Sheet import.

**Architecture:** Read models in `src/lib/server/read/` turn ledger rows into plain JSON for pages; every mutation is a JSON `POST` route under `src/routes/api/` that calls a 1A/1B service (nothing writes tables directly, spec §9) and maps `InvariantError` to 409. Pages are thin: `+page.server.ts` calls a read model, `+page.svelte` renders it, and client actions `fetch` an API route then `invalidateAll()`. No component library, no chart library: one stylesheet, inline SVG.

**Tech Stack:** SvelteKit 2 (Svelte 5 runes, adapter-node), Drizzle + better-sqlite3, vitest (node environment: read models and routes are tested; Svelte components are validated by `npm run check` and `npm run build`), node-cron, `xlsx` + `tsx` for the sheet script.

**Spec:** `docs/superpowers/specs/2026-09-04-shiso-phase1-foundation-design.md` (§3 deployment, §8 screens, §9 errors, §10 testing, §11 sheet import). Plan 1B's handoff is at the bottom of `docs/superpowers/plans/2026-09-08-shiso-1b-sync.md`.

## Global Constraints

- Node 24, SvelteKit 2, Svelte 5 (runes: `$props`, `$state`, `$derived`), TypeScript strict. `npm run check` must be 0 errors at every commit.
- Money is integer cents everywhere on the server and on the wire. The UI converts typed dollars with `decimalToCents` from `$lib/money` (client-safe) and renders with `formatCents`.
- Calendar dates come from `todayIso(config.timeZone)`; timestamps from `nowIso()`. Never `new Date().toISOString().slice(0,10)` for a calendar date.
- No Drizzle relational API (`db.query.*`). Use `db.select()...get()/all()`.
- Nothing writes `transactions`, `transaction_splits`, `budget_assignments`, transfer links, or occurrences except the ledger services (spec §9). Routes call services.
- Sync sign convention: from the account's point of view. Spending amounts shown as positive numbers are `−Σ split.amount`.
- Read models return plain objects and arrays (no `Map`), so `load` data serialises.
- Every mutating route: one happy-path test and one invariant-violation test asserting on the database (spec §10), using the `startup` temp-dir pattern from `src/routes/api/sync/sync.test.ts`.
- Commit messages: conventional, single subject line, no trailer, no reference to AI tooling.
- Never read or print `.env`. `.env.example` is the only env file edited.
- Excluded from spending by default (§8): kinds `bill`, `debt_payment`, `transfer`, `income`, `reconciliation`.

## File structure

```
src/app.css                                   tokens, layout, tables, forms, badges (one file)
src/routes/+layout.svelte                     nav with review-queue count; imports app.css
src/routes/+layout.server.ts                  load → { nav: { reviewCount } }
src/routes/+page.server.ts, +page.svelte      Month
src/routes/budget/…                           Budget (+ CategoryManager dialog)
src/routes/ledger/…                           Ledger (+ SplitEditor dialog)
src/routes/spending/…                         Spending (+ RangePicker, StackedBars)
src/routes/accounts/…                         Accounts (Plaid Link, SimpleFIN, manual, CSV)
src/routes/bills/…                            Bills (+ BillForm dialog)
src/routes/api/**/+server.ts                  JSON mutation routes (one folder per resource)
src/lib/server/http.ts                        handle(), readJson(), ValidationError, intParam()
src/lib/server/read/{nav,month,budget,categories,ledger,spending,accounts,bills}.ts
src/lib/server/test/fixture.ts                shared in-memory fixture for read-model tests
src/lib/server/backup.ts                      nightly VACUUM INTO + prune
src/lib/server/import/sheet.ts                pure sheet-tab parser + importer
src/lib/ui/api.ts                             post(path, body) → json or throws ApiError
src/lib/ui/{Money,Dialog,RangePicker,StackedBars,Sparkline}.svelte
scripts/import-sheet.ts, scripts/release.sh
deploy/{shiso.service,shiso.env.example,Caddyfile.snippet,install.sh}
docs/deploy.md, README.md
drizzle/0002_account_opened_on.sql
```

## Conventions every task follows

**Route shape.** Each `+server.ts` exports `POST` (or `GET`) built with `handle` from `src/lib/server/http.ts`:

```ts
import { handle, readJson, intParam, ValidationError } from '$lib/server/http';
export const POST = handle(async ({ request, params }) => {
	const body = await readJson<{ amount: number }>(request);
	if (!Number.isInteger(body.amount)) throw new ValidationError('amount must be integer cents');
	// call a service with getDb()
	return { ok: true };
});
```
`handle` returns `json(result)`; maps `ValidationError` → 400 `{ error }`, `InvariantError` → 409 `{ error, code }`, any `Error` whose message contains `not found` → 404 `{ error }`, everything else rethrown (SvelteKit returns 500).

**Page shape.** `+page.server.ts`:
```ts
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { todayIso } from '$lib/dates';
export const load: PageServerLoad = ({ url }) => {
	const config = getConfig();
	return { view: someView(getDb(), { todayIso: todayIso(config.timeZone), cadence: config.cadence, /* url params */ }) };
};
```
`+page.svelte` reads `let { data } = $props();` and calls `api.post(...)` then `await invalidateAll()` after each mutation. Errors from `api.post` are shown in a `<p class="error">` bound to a `$state` string.

**Tests for `load`.** Route and page-load tests use this harness (copy it; do not import it from `sync.test.ts`):
```ts
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { startup, resetForTests } from '$lib/server/startup'; import { setConfig } from '$lib/server/config';
let dir: string;
const cfg = (d: string) => ({
	dbPath: join(d, 'shiso.db'), backupDir: join(d, 'backups'), appKey: 'k'.repeat(40), timeZone: 'America/New_York', migrationsDir: 'drizzle',
	cadence: 'semi_monthly' as const, syncHour: 3, balanceHour: 7, backupHour: 4, plaid: { clientId: null, secret: null, env: 'sandbox' as const },
	schedulerEnabled: false, plaidClientName: 'shiso'
});
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shiso-1c-')); const c = cfg(dir); setConfig(c); startup(c, '2026-09-08'); });
afterEach(() => { resetForTests(); rmSync(dir, { recursive: true, force: true }); });
const req = (body: unknown) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
```
(`backupHour` is added to `Config` in Task 14; until then omit it from `cfg()`. Task 14 updates every `cfg()` literal in the repo.)

---

### Task 1: HTTP helpers, layout with nav, shared test fixture

**Files:**
- Create: `src/lib/server/http.ts`, `src/lib/server/http.test.ts`, `src/lib/server/read/nav.ts`, `src/lib/server/read/nav.test.ts`, `src/lib/server/test/fixture.ts`, `src/lib/ui/api.ts`, `src/lib/ui/Money.svelte`, `src/lib/ui/Dialog.svelte`, `src/app.css`, `src/routes/+layout.server.ts`
- Modify: `src/routes/+layout.svelte`

**Interfaces:**
- Produces:
  - `handle(fn: (event: RequestEvent) => unknown | Promise<unknown>): RequestHandler`
  - `readJson<T>(request: Request): Promise<T>` — 400 `ValidationError('body must be JSON')` on parse failure
  - `intParam(v: string | undefined | null, name: string): number` — throws `ValidationError` unless a non-negative integer string
  - `class ValidationError extends Error`
  - `reviewCount(db: DbOrTx): number` — live rows with `needs_review = 1` plus accounts whose drift is non-zero (`driftReport`)
  - `fixture(): { db, conn, checking, card, savings, groceries, rent, cardPay, income, uncategorized, groups: { bills, spending, debt, savings }, today: '2026-09-08' }` — in-memory DB with periods 2026-07-01 … 2026-10-31, one manual connection, three accounts, categories
  - `api.post<T>(path: string, body?: unknown): Promise<T>` — throws `ApiError { status, message, code? }`
  - `<Money cents={number} />` renders `formatCents`, class `neg` when negative
  - `<Dialog open={boolean} title={string} onclose={() => void}>{children}</Dialog>` — native `<dialog>`, closes on Escape and backdrop click

- [ ] **Step 1: Failing tests for http.ts**

`src/lib/server/http.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { handle, readJson, intParam, ValidationError } from './http';
import { InvariantError } from './ledger/errors';

const call = (fn: Parameters<typeof handle>[0], body?: unknown) =>
	handle(fn)({ request: new Request('http://x', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } }), params: {} } as never);

describe('handle', () => {
	it('returns json 200 for a value', async () => {
		const res = await call(() => ({ ok: 1 }));
		expect(res.status).toBe(200); expect(await res.json()).toEqual({ ok: 1 });
	});
	it('maps ValidationError to 400, InvariantError to 409, not-found to 404', async () => {
		expect((await call(() => { throw new ValidationError('bad'); })).status).toBe(400);
		const inv = await call(() => { throw new InvariantError('SPLITS_DO_NOT_SUM'); });
		expect(inv.status).toBe(409); expect((await inv.json()).code).toBe('SPLITS_DO_NOT_SUM');
		expect((await call(() => { throw new Error('transaction 9 not found'); })).status).toBe(404);
	});
	it('rethrows unknown errors', async () => {
		await expect(call(() => { throw new Error('boom'); })).rejects.toThrow('boom');
	});
	it('readJson rejects a non-JSON body; intParam parses ids', async () => {
		await expect(readJson(new Request('http://x', { method: 'POST', body: 'nope' }))).rejects.toBeInstanceOf(ValidationError);
		expect(intParam('12', 'id')).toBe(12);
		expect(() => intParam('x', 'id')).toThrow(ValidationError);
		expect(() => intParam(undefined, 'id')).toThrow(ValidationError);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/server/http.test.ts`
Expected: FAIL, "Cannot find module './http'"

- [ ] **Step 3: Implement http.ts**

```ts
import { json, type RequestEvent, type RequestHandler } from '@sveltejs/kit';
import { InvariantError } from './ledger/errors';

export class ValidationError extends Error {
	constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

/** Wrap a route: return a value → 200 json; throw ValidationError → 400; InvariantError → 409; "not found" → 404; else rethrow. */
export function handle(fn: (event: RequestEvent) => unknown | Promise<unknown>): RequestHandler {
	return async (event) => {
		try {
			return json(await fn(event));
		} catch (err) {
			if (err instanceof ValidationError) return json({ error: err.message }, { status: 400 });
			if (err instanceof InvariantError) return json({ error: err.message, code: err.code }, { status: 409 });
			if (err instanceof Error && /not found/i.test(err.message)) return json({ error: err.message }, { status: 404 });
			throw err;
		}
	};
}

export async function readJson<T>(request: Request): Promise<T> {
	try { return (await request.json()) as T; }
	catch { throw new ValidationError('body must be JSON'); }
}

export function intParam(v: string | undefined | null, name: string): number {
	if (v == null || !/^\d+$/.test(v)) throw new ValidationError(`${name} must be an integer`);
	return Number(v);
}

/** Integer cents from a JSON body field. */
export function cents(v: unknown, name: string): number {
	if (typeof v !== 'number' || !Number.isInteger(v)) throw new ValidationError(`${name} must be integer cents`);
	return v;
}

/** ISO calendar date from a JSON body field. */
export function isoDate(v: unknown, name: string): string {
	if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ValidationError(`${name} must be YYYY-MM-DD`);
	return v;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/server/http.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Shared fixture**

`src/lib/server/test/fixture.ts`:
```ts
import { eq } from 'drizzle-orm';
import { openMemoryDatabase, type Db } from '../db';
import { categoryGroups } from '../db/schema';
import { seedDefaultCategories, createCategory, systemCategoryId, uncategorizedId } from '../ledger/categories';
import { ensurePeriods } from '../budget/periods';
import { createConnection, upsertAccount } from '../sync/connections';

export const KEY = 'k'.repeat(44);
export const TODAY = '2026-09-08';

export function fixture() {
	const db: Db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-07-01', '2026-10-31');
	const group = (name: string) => db.select({ id: categoryGroups.id }).from(categoryGroups).where(eq(categoryGroups.name, name)).get()!.id;
	const groups = { bills: group('Bills'), spending: group('Spending'), debt: group('Debt Payments'), savings: group('Savings') };
	const conn = createConnection(db, { provider: 'manual', institutionName: 'Test Bank', appKey: KEY });
	const checking = upsertAccount(db, conn, { externalId: 'chk', name: 'Checking', type: 'checking' }).id;
	const savings = upsertAccount(db, conn, { externalId: 'sav', name: 'Savings', type: 'savings' }).id;
	const card = upsertAccount(db, conn, { externalId: 'card', name: 'Sapphire', type: 'credit' }).id;
	const groceries = createCategory(db, { groupId: groups.spending, name: 'Groceries', kind: 'spending' });
	const rent = createCategory(db, { groupId: groups.bills, name: 'Rent', kind: 'bill' });
	const cardPay = createCategory(db, { groupId: groups.debt, name: 'Sapphire', kind: 'debt_payment', accountId: card });
	return {
		db, conn, checking, savings, card, groceries, rent, cardPay, groups,
		income: systemCategoryId(db, 'income'), uncategorized: uncategorizedId(db), today: TODAY
	};
}
```

- [ ] **Step 6: Failing test for reviewCount**

`src/lib/server/read/nav.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { createTransaction, flagForReview } from '../ledger/transactions';
import { appendBalance } from '../sync/connections';
import { reviewCount } from './nav';

describe('reviewCount', () => {
	it('counts flagged rows plus accounts with drift', () => {
		const f = fixture();
		expect(reviewCount(f.db)).toBe(0);
		const id = createTransaction(f.db, { accountId: f.checking, externalId: 't1', postedDate: '2026-09-02', amount: -1000, payeeRaw: 'X', source: 'manual' });
		flagForReview(f.db, id, 'transfer_unlinked');
		expect(reviewCount(f.db)).toBe(1);
		appendBalance(f.db, f.checking, { asOf: '2026-09-08', current: 500, source: 'manual' }); // ledger says -1000
		expect(reviewCount(f.db)).toBe(2);
	});
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `npx vitest run src/lib/server/read/nav.test.ts` — Expected: FAIL, cannot find module './nav'

- [ ] **Step 8: Implement nav.ts**

```ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { transactions } from '../db/schema';
import { driftReport } from '../reconcile';

/** §8 Ledger: the review queue is flagged live rows plus accounts whose provider balance disagrees with the ledger. */
export function reviewCount(db: DbOrTx): number {
	const flagged = db.select({ n: sql<number>`count(*)` }).from(transactions)
		.where(and(eq(transactions.needsReview, true), isNull(transactions.deletedAt))).get()?.n ?? 0;
	const drifted = driftReport(db).filter((d) => d.drift != null && d.drift !== 0).length;
	return flagged + drifted;
}
```

- [ ] **Step 9: Run to verify it passes**

Run: `npx vitest run src/lib/server/read/nav.test.ts` — Expected: PASS

- [ ] **Step 10: Layout, stylesheet, UI helpers**

`src/routes/+layout.server.ts`:
```ts
import type { LayoutServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { reviewCount } from '$lib/server/read/nav';

export const load: LayoutServerLoad = () => ({ nav: { reviewCount: reviewCount(getDb()) } });
```

`src/routes/+layout.svelte`:
```svelte
<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	let { data, children } = $props();
	const links = [
		{ href: '/', label: 'Month' }, { href: '/budget', label: 'Budget' }, { href: '/ledger', label: 'Ledger' },
		{ href: '/spending', label: 'Spending' }, { href: '/accounts', label: 'Accounts' }, { href: '/bills', label: 'Bills' }
	];
	const active = (href: string) => (href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href));
</script>

<svelte:head><link rel="icon" href={favicon} /><title>shiso</title></svelte:head>

<nav class="topnav">
	<span class="brand">shiso</span>
	{#each links as l}
		<a href={l.href} class:active={active(l.href)}>
			{l.label}{#if l.href === '/ledger' && data.nav.reviewCount > 0}<span class="badge">{data.nav.reviewCount}</span>{/if}
		</a>
	{/each}
</nav>
<main>{@render children()}</main>
```

`src/app.css` (complete file):
```css
:root {
	--bg: #fafaf7; --fg: #1d1d1b; --muted: #6b6b66; --line: #e2e2dc; --card: #ffffff;
	--accent: #2f6f4e; --neg: #b3261e; --pos: #1e6b3a; --warn: #8a5a00; --badge: #b3261e;
	font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 15px; color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
	:root { --bg: #141412; --fg: #ecece6; --muted: #a2a29a; --line: #2c2c28; --card: #1c1c19; --accent: #79c29a; --neg: #ff6b62; --pos: #7fd39a; --warn: #f0b64a; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); }
main { max-width: 1200px; margin: 0 auto; padding: 1rem 1.25rem 3rem; }
.topnav { display: flex; gap: 1rem; align-items: center; padding: .6rem 1.25rem; border-bottom: 1px solid var(--line); background: var(--card); }
.topnav .brand { font-weight: 700; margin-right: .5rem; }
.topnav a { color: var(--fg); text-decoration: none; padding: .25rem .5rem; border-radius: .4rem; }
.topnav a.active { background: var(--accent); color: #fff; }
.badge { display: inline-block; min-width: 1.2em; padding: 0 .35em; margin-left: .35em; border-radius: 1em; background: var(--badge); color: #fff; font-size: .75em; text-align: center; }
h1 { font-size: 1.4rem; margin: .5rem 0 1rem; } h2 { font-size: 1.1rem; margin: 1.25rem 0 .5rem; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: .75rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: .6rem; padding: .75rem 1rem; }
.card .label { color: var(--muted); font-size: .85rem; } .card .value { font-size: 1.4rem; font-weight: 600; }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: .6rem; overflow: hidden; }
th, td { padding: .45rem .6rem; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
th { color: var(--muted); font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.group td { background: var(--bg); font-weight: 600; }
.money.neg { color: var(--neg); } .money.pos { color: var(--pos); }
.status { font-size: .75rem; padding: .1rem .45rem; border-radius: 1em; border: 1px solid var(--line); }
.status.paid { color: var(--pos); } .status.overdue, .status.error, .status.needs_relink { color: var(--neg); } .status.pending { color: var(--warn); }
.toolbar { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: .5rem 0 1rem; }
input, select, button, textarea { font: inherit; color: inherit; background: var(--card); border: 1px solid var(--line); border-radius: .4rem; padding: .35rem .5rem; }
input.inline { border-color: transparent; background: transparent; width: 100%; } input.inline:focus { border-color: var(--line); background: var(--card); }
input.num { text-align: right; width: 7em; font-variant-numeric: tabular-nums; }
button.primary { background: var(--accent); color: #fff; border-color: transparent; } button.danger { color: var(--neg); }
button:disabled { opacity: .5; }
.error { color: var(--neg); } .muted { color: var(--muted); } .small { font-size: .85rem; }
dialog { border: 1px solid var(--line); border-radius: .6rem; background: var(--card); color: var(--fg); padding: 1rem 1.25rem; min-width: 320px; max-width: 90vw; }
dialog::backdrop { background: rgba(0,0,0,.35); }
dialog form.grid { display: grid; grid-template-columns: max-content 1fr; gap: .5rem .75rem; align-items: center; }
.actions { display: flex; gap: .5rem; justify-content: flex-end; margin-top: .75rem; }
.strip { display: flex; gap: .75rem; flex-wrap: wrap; padding: .5rem .75rem; border: 1px solid var(--line); border-radius: .6rem; background: var(--card); margin-bottom: 1rem; }
.chart { width: 100%; height: auto; background: var(--card); border: 1px solid var(--line); border-radius: .6rem; }
.legend { display: flex; flex-wrap: wrap; gap: .5rem 1rem; font-size: .85rem; margin-top: .5rem; } .legend i { display: inline-block; width: .8em; height: .8em; border-radius: .2em; margin-right: .3em; }
```

`src/lib/ui/api.ts`:
```ts
export class ApiError extends Error {
	constructor(public readonly status: number, message: string, public readonly code?: string) { super(message); this.name = 'ApiError'; }
}
/** POST JSON to an API route; resolve with the parsed body or throw ApiError with the server's message. */
export async function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
	const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data.code);
	return data as T;
}
/** Multipart upload (CSV import). */
export async function upload<T = unknown>(path: string, form: FormData): Promise<T> {
	const res = await fetch(path, { method: 'POST', body: form });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data.code);
	return data as T;
}
```

`src/lib/ui/Money.svelte`:
```svelte
<script lang="ts">
	import { formatCents } from '$lib/money';
	let { cents, signed = false }: { cents: number; signed?: boolean } = $props();
</script>
<span class="money" class:neg={cents < 0} class:pos={signed && cents > 0}>{formatCents(cents)}</span>
```

`src/lib/ui/Dialog.svelte`:
```svelte
<script lang="ts">
	import type { Snippet } from 'svelte';
	let { open, title, onclose, children }: { open: boolean; title: string; onclose: () => void; children: Snippet } = $props();
	let el: HTMLDialogElement | undefined = $state();
	$effect(() => { if (!el) return; if (open && !el.open) el.showModal(); if (!open && el.open) el.close(); });
</script>
<dialog bind:this={el} onclose={onclose} onclick={(e) => { if (e.target === el) onclose(); }}>
	<h2 style="margin-top:0">{title}</h2>
	{@render children()}
</dialog>
```

- [ ] **Step 11: Verify**

Run: `npm run check` → 0 errors. Run: `npx vitest run` → all pass. Run: `SHISO_SCHEDULER=off SHISO_DB_PATH=/tmp/shiso-1c.db SHISO_BACKUP_DIR=/tmp/shiso-1c-bk npm run dev -- --port 5173` in the background, `curl -s localhost:5173/ | grep -c topnav` → `1`, then stop it.

- [ ] **Step 12: Commit**

```bash
git add src/app.css src/routes/+layout.svelte src/routes/+layout.server.ts src/lib/server/http.ts src/lib/server/http.test.ts src/lib/server/read src/lib/server/test src/lib/ui
git commit -m "feat: http helpers, app shell with review count, shared read-model fixture"
```

---

### Task 2: Service gaps — account edits, category edits, manual transactions

**Files:**
- Modify: `src/lib/server/sync/connections.ts`, `src/lib/server/ledger/categories.ts`, `src/lib/server/ledger/transactions.ts`
- Test: `src/lib/server/sync/connections.test.ts` (append), `src/lib/server/ledger/categories.test.ts` (append), `src/lib/server/ledger/transactions.test.ts` (append)

**Interfaces:**
- Produces:
  - `updateAccount(db, id, patch: { name?: string; type?: AccountType; onBudget?: boolean; closedAt?: string | null }): void` — changing `type` recomputes `isDebt` (`credit`/`loan`); throws `InvariantError('ACCOUNT_HAS_PAYMENT_CATEGORY')` when `type` leaves the debt set while a `debt_payment` category points at the account.
  - `updateCategory(db, id, patch: { name?: string; kind?: CategoryKind; accountId?: number | null; hidden?: boolean; groupId?: number; sort?: number }): void` — `kind: 'debt_payment'` requires `accountId` on a debt account and enforces uniqueness (same codes as `createCategory`); any other kind sets `accountId` to null; system categories reject `kind` changes with `InvariantError('SYSTEM_CATEGORY_KIND')`.
  - `createManualTransaction(db, input: { accountId: number; postedDate: string; amount: number; payee: string; memo?: string | null; categoryId?: number | null }): number` — `source: 'manual'`, `externalId: manual:<uuid>`, `payeeRaw = payee`, single split to `categoryId ?? uncategorized`, left unprocessed (post-processing runs at the next maintenance).
  - `deleteUserTransaction(db, id): void` — `softDelete(db, id, 'user_deleted')` only for `source in ('manual','import')`; otherwise `InvariantError('NOT_USER_ROW')`.

- [ ] **Step 1: Failing tests**

Append to `src/lib/server/sync/connections.test.ts` (reuse its existing `db`/setup; if it has none at module level, build one with `openMemoryDatabase` + `seedDefaultCategories` + `createConnection` inside the test):
```ts
describe('updateAccount', () => {
	it('renames, closes, and recomputes isDebt on a type change', () => {
		const db = openMemoryDatabase().db; seedDefaultCategories(db);
		const conn = createConnection(db, { provider: 'manual', institutionName: 'T', appKey: 'k'.repeat(44) });
		const id = upsertAccount(db, conn, { externalId: 'a', name: 'A', type: 'checking' }).id;
		updateAccount(db, id, { name: 'Main', closedAt: '2026-09-01' });
		let row = db.select().from(accounts).where(eq(accounts.id, id)).get()!;
		expect(row.name).toBe('Main'); expect(row.closedAt).toBe('2026-09-01'); expect(row.isDebt).toBe(false);
		updateAccount(db, id, { type: 'loan', closedAt: null });
		row = db.select().from(accounts).where(eq(accounts.id, id)).get()!;
		expect(row.type).toBe('loan'); expect(row.isDebt).toBe(true); expect(row.closedAt).toBeNull();
	});
	it('refuses to make a debt account non-debt while a payment category points at it', () => {
		const db = openMemoryDatabase().db; seedDefaultCategories(db);
		const conn = createConnection(db, { provider: 'manual', institutionName: 'T', appKey: 'k'.repeat(44) });
		const card = upsertAccount(db, conn, { externalId: 'c', name: 'C', type: 'credit' }).id;
		const group = createGroup(db, 'Debt', 9);
		createCategory(db, { groupId: group, name: 'C', kind: 'debt_payment', accountId: card });
		expect(() => updateAccount(db, card, { type: 'checking' })).toThrow(InvariantError);
	});
});
```
Append to `src/lib/server/ledger/categories.test.ts`:
```ts
describe('updateCategory', () => {
	it('changes kind to debt_payment with an account, and clears the account when leaving it', () => {
		const db = openMemoryDatabase().db; seedDefaultCategories(db);
		const conn = createConnection(db, { provider: 'manual', institutionName: 'T', appKey: 'k'.repeat(44) });
		const card = upsertAccount(db, conn, { externalId: 'c', name: 'C', type: 'credit' }).id;
		const group = createGroup(db, 'G', 9);
		const id = createCategory(db, { groupId: group, name: 'Card', kind: 'spending' });
		updateCategory(db, id, { kind: 'debt_payment', accountId: card });
		expect(paymentCategoryForAccount(db, card)).toBe(id);
		updateCategory(db, id, { kind: 'spending' });
		expect(paymentCategoryForAccount(db, card)).toBeNull();
		expect(() => updateCategory(db, id, { kind: 'debt_payment' })).toThrow(InvariantError);
		expect(() => updateCategory(db, systemCategoryId(db, 'income'), { kind: 'spending' })).toThrow(InvariantError);
	});
});
```
Append to `src/lib/server/ledger/transactions.test.ts`:
```ts
describe('manual transactions', () => {
	it('creates an unprocessed manual row with one split and deletes only user rows', () => {
		const f = fixture();
		const id = createManualTransaction(f.db, { accountId: f.checking, postedDate: '2026-09-03', amount: -2500, payee: 'Farmers Market', categoryId: f.groceries });
		const t = getTransaction(f.db, id);
		expect(t.source).toBe('manual'); expect(t.externalId.startsWith('manual:')).toBe(true);
		expect(t.processedAt).toBeNull(); expect(t.splits).toHaveLength(1); expect(t.splits[0].categoryId).toBe(f.groceries);
		deleteUserTransaction(f.db, id);
		expect(getTransaction(f.db, id).deletedAt).not.toBeNull();
		const synced = createTransaction(f.db, { accountId: f.checking, externalId: 's1', postedDate: '2026-09-03', amount: -1, payeeRaw: 'X', source: 'sync' });
		expect(() => deleteUserTransaction(f.db, synced)).toThrow(InvariantError);
	});
});
```
(Import `fixture` from `../test/fixture` and the new functions; add `import { eq } from 'drizzle-orm'` and schema imports where the test file lacks them.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/server/sync/connections.test.ts src/lib/server/ledger` — Expected: FAIL on the missing exports.

- [ ] **Step 3: Implement**

In `connections.ts` (import `InvariantError` from `../ledger/errors` and `categories` from the schema):
```ts
const DEBT_TYPES: readonly string[] = ['credit', 'loan'];

export function updateAccount(db: DbOrTx, id: number, patch: { name?: string; type?: AccountType; onBudget?: boolean; closedAt?: string | null }): void {
	const row = db.select().from(accounts).where(eq(accounts.id, id)).get();
	if (!row) throw new Error(`account ${id} not found`);
	const set: Partial<typeof accounts.$inferInsert> = { ...touch() };
	if (patch.name !== undefined) set.name = patch.name;
	if (patch.onBudget !== undefined) set.onBudget = patch.onBudget;
	if (patch.closedAt !== undefined) set.closedAt = patch.closedAt;
	if (patch.type !== undefined) {
		const isDebt = DEBT_TYPES.includes(patch.type);
		if (!isDebt && row.isDebt) {
			const cat = db.select({ id: categories.id }).from(categories).where(and(eq(categories.kind, 'debt_payment'), eq(categories.accountId, id))).get();
			if (cat) throw new InvariantError('ACCOUNT_HAS_PAYMENT_CATEGORY', 'reassign or delete the payment category first');
		}
		set.type = patch.type; set.isDebt = isDebt;
	}
	db.update(accounts).set(set).where(eq(accounts.id, id)).run();
}
```
In `categories.ts`:
```ts
export function updateCategory(db: DbOrTx, id: number, patch: {
	name?: string; kind?: CategoryKind; accountId?: number | null; hidden?: boolean; groupId?: number; sort?: number;
}): void {
	const row = db.select().from(categories).where(eq(categories.id, id)).get();
	if (!row) throw new Error(`category ${id} not found`);
	const set: Partial<typeof categories.$inferInsert> = { ...touch() };
	if (patch.name !== undefined) set.name = patch.name;
	if (patch.hidden !== undefined) set.hidden = patch.hidden;
	if (patch.groupId !== undefined) set.groupId = patch.groupId;
	if (patch.sort !== undefined) set.sort = patch.sort;
	if (patch.kind !== undefined || patch.accountId !== undefined) {
		const kind = patch.kind ?? row.kind;
		if (row.isSystem && kind !== row.kind) throw new InvariantError('SYSTEM_CATEGORY_KIND');
		if (kind === 'debt_payment') {
			const accountId = patch.accountId === undefined ? row.accountId : patch.accountId;
			if (accountId == null) throw new InvariantError('DEBT_CATEGORY_NEEDS_ACCOUNT');
			const acct = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
			if (!acct) throw new InvariantError('DEBT_CATEGORY_NEEDS_ACCOUNT', `account ${accountId} not found`);
			if (!acct.isDebt) throw new InvariantError('DEBT_CATEGORY_ACCOUNT_NOT_DEBT');
			const other = paymentCategoryForAccount(db, accountId);
			if (other != null && other !== id) throw new InvariantError('DEBT_CATEGORY_DUPLICATE');
			set.kind = kind; set.accountId = accountId;
		} else {
			set.kind = kind; set.accountId = null;
		}
	}
	db.update(categories).set(set).where(eq(categories.id, id)).run();
}
```
In `transactions.ts` (import `randomUUID` from `node:crypto`):
```ts
export function createManualTransaction(db: DbOrTx, input: {
	accountId: number; postedDate: string; amount: number; payee: string; memo?: string | null; categoryId?: number | null;
}): number {
	const categoryId = input.categoryId ?? uncategorizedId(db);
	return createTransaction(db, {
		accountId: input.accountId, externalId: `manual:${randomUUID()}`, postedDate: input.postedDate, amount: input.amount,
		payeeRaw: input.payee, payee: input.payee, memo: input.memo ?? null, source: 'manual',
		splits: [{ categoryId, amount: input.amount }]
	});
}

/** Only rows the user created (manual entry or CSV import) can be deleted by the user; synced rows are the provider's. */
export function deleteUserTransaction(db: DbOrTx, id: number): void {
	const row = db.select({ source: transactions.source }).from(transactions).where(eq(transactions.id, id)).get();
	if (!row) throw new Error(`transaction ${id} not found`);
	if (row.source !== 'manual' && row.source !== 'import') throw new InvariantError('NOT_USER_ROW');
	softDelete(db, id, 'user_deleted');
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run` — Expected: all pass. `npm run check` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/sync/connections.ts src/lib/server/sync/connections.test.ts src/lib/server/ledger
git commit -m "feat: account and category edits, manual transaction entry and deletion"
```

---

### Task 3: Month page

**Files:**
- Create: `src/lib/server/read/month.ts`, `src/lib/server/read/month.test.ts`, `src/routes/+page.server.ts`, `src/routes/month.test.ts`, `src/lib/ui/Sparkline.svelte`
- Modify: `src/routes/+page.svelte` (replace the SvelteKit welcome page)

**Interfaces:**
- Consumes: `fixture`, `createBill`, `createIncomeSource`, `generateOccurrences`, `markOccurrencePaid`, `appendBalance`.
- Produces: `monthView(db, opts: { month: string /* YYYY-MM */; todayIso: string; cadence: Cadence }): MonthView` where
```ts
export type MonthView = {
	month: string; label: string; prev: string; next: string; today: string;
	cash: { accounts: { id: number; name: string; type: string; current: number; asOf: string | null }[]; total: number };
	income: { expected: number; received: number; remaining: number; occurrences: { id: number; name: string; dueDate: string; expected: number; received: number; status: string }[] };
	bills: { paid: number; pending: number; occurrences: { id: number; name: string; dueDate: string; expected: number; paid: number; status: string; isDebt: boolean }[] };
	cardPayments: { planned: number; paid: number; extra: number };
	cashLeft: number;
	trend: { asOf: string; current: number }[];
};
```
Rules: the month spans calendar days `YYYY-MM-01 … end of month`. `cash.accounts` are on-budget, unclosed accounts of type checking/savings/cash with their latest balance row (`latestBalance`), `current = 0` when none. Income rows are `income_occurrences` whose `due_date` is in the month, joined to `income_sources.name`; `expected = Σ expected_amount` over non-skipped rows, `received = Σ received_amount`, `remaining = Σ expected_amount of pending/overdue rows`. Bill rows are `bill_occurrences` in the month joined to `bills`; `paid = Σ paid_amount`, `pending = Σ expected_amount of pending/overdue rows`. `cardPayments` covers bill rows where `bills.linked_debt_account_id IS NOT NULL`: `planned = Σ expected_amount` of pending/overdue, `paid = Σ paid_amount`, `extra = Σ extra_amount`. `cashLeft = cash.total + income.remaining − bills.pending` (bills.pending already includes debt occurrences). `trend` is every `account_balances` row of checking-type accounts in the 90 days ending `todayIso`, ordered by `as_of`, summed per `as_of` across checking accounts. `prev`/`next` are the adjacent `YYYY-MM` strings.

- [ ] **Step 1: Failing read-model test**

`src/lib/server/read/month.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { appendBalance } from '../sync/connections';
import { createBill, createIncomeSource } from '../bills/bills';
import { generateOccurrences } from '../bills/schedule';
import { markOccurrencePaid } from '../bills/matching';
import { billOccurrences } from '../db/schema';
import { monthView } from './month';

describe('monthView', () => {
	it('sums cash, income, bills and card payments for the calendar month', () => {
		const f = fixture();
		appendBalance(f.db, f.checking, { asOf: '2026-09-01', current: 300000, source: 'manual' });
		appendBalance(f.db, f.checking, { asOf: '2026-09-07', current: 250000, source: 'manual' });
		appendBalance(f.db, f.savings, { asOf: '2026-09-07', current: 100000, source: 'manual' });
		appendBalance(f.db, f.card, { asOf: '2026-09-07', current: -80000, source: 'manual' });
		createBill(f.db, { name: 'Rent', categoryId: f.rent, payFromAccountId: f.checking, expectedAmount: 227445, cadence: 'monthly', dueDay: 1 });
		createBill(f.db, { name: 'Sapphire', categoryId: f.cardPay, payFromAccountId: f.checking, expectedAmount: 3500, cadence: 'monthly', dueDay: 25, linkedDebtAccountId: f.card });
		createIncomeSource(f.db, { name: 'Salary', categoryId: f.income, depositAccountId: f.checking, expectedAmount: 275000, cadence: 'semi_monthly', dueDay: 15, dueDay2: 30 });
		generateOccurrences(f.db, { todayIso: '2026-09-08', cadence: 'semi_monthly', graceDays: 3 });
		const rent = f.db.select().from(billOccurrences).all().find((o) => o.expectedAmount === 227445 && o.dueDate === '2026-09-01')!;
		markOccurrencePaid(f.db, rent.id);

		const v = monthView(f.db, { month: '2026-09', todayIso: '2026-09-08', cadence: 'semi_monthly' });
		expect(v.label).toBe('September 2026'); expect(v.prev).toBe('2026-08'); expect(v.next).toBe('2026-10');
		expect(v.cash.total).toBe(350000);
		expect(v.cash.accounts.map((a) => a.name)).toEqual(['Checking', 'Savings']);
		expect(v.income.expected).toBe(550000); expect(v.income.received).toBe(0); expect(v.income.remaining).toBe(550000);
		expect(v.bills.paid).toBe(227445); expect(v.bills.pending).toBe(3500);
		expect(v.cardPayments).toEqual({ planned: 3500, paid: 0, extra: 0 });
		expect(v.cashLeft).toBe(350000 + 550000 - 3500);
		expect(v.trend).toEqual([{ asOf: '2026-09-01', current: 300000 }, { asOf: '2026-09-07', current: 250000 }]);
	});
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/server/read/month.test.ts` → cannot find module './month'

- [ ] **Step 3: Implement month.ts**

```ts
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, accountBalances, billOccurrences, bills, incomeOccurrences, incomeSources, CASH_TYPES } from '../db/schema';
import { latestBalance } from '../sync/connections';
import type { Cadence } from '../budget/periods';
import { addDays, endOfMonth } from '$lib/dates';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const shiftMonth = (month: string, by: number) => { const y = +month.slice(0, 4), m = +month.slice(5, 7) - 1 + by; const d = new Date(Date.UTC(y, m, 1)); return d.toISOString().slice(0, 7); };
const OPEN = ['pending', 'overdue'] as const;

export type MonthView = { /* as in Interfaces */ };

export function monthView(db: DbOrTx, opts: { month: string; todayIso: string; cadence: Cadence }): MonthView {
	const start = `${opts.month}-01`, end = endOfMonth(start);
	const cashRows = db.select().from(accounts)
		.where(and(inArray(accounts.type, [...CASH_TYPES]), eq(accounts.onBudget, true), isNull(accounts.closedAt))).orderBy(asc(accounts.id)).all();
	const cashAccounts = cashRows.map((a) => { const b = latestBalance(db, a.id); return { id: a.id, name: a.name, type: a.type, current: b?.current ?? 0, asOf: b?.asOf ?? null }; });

	const inc = db.select({ o: incomeOccurrences, name: incomeSources.name }).from(incomeOccurrences)
		.innerJoin(incomeSources, eq(incomeOccurrences.incomeSourceId, incomeSources.id))
		.where(and(gte(incomeOccurrences.dueDate, start), lte(incomeOccurrences.dueDate, end))).orderBy(asc(incomeOccurrences.dueDate)).all();
	const incomeOcc = inc.map(({ o, name }) => ({ id: o.id, name, dueDate: o.dueDate, expected: o.expectedAmount, received: o.receivedAmount, status: o.status }));
	const live = incomeOcc.filter((o) => o.status !== 'skipped');

	const bl = db.select({ o: billOccurrences, b: bills }).from(billOccurrences).innerJoin(bills, eq(billOccurrences.billId, bills.id))
		.where(and(gte(billOccurrences.dueDate, start), lte(billOccurrences.dueDate, end))).orderBy(asc(billOccurrences.dueDate)).all();
	const billOcc = bl.map(({ o, b }) => ({ id: o.id, name: b.name, dueDate: o.dueDate, expected: o.expectedAmount, paid: o.paidAmount, extra: o.extraAmount, status: o.status, isDebt: b.linkedDebtAccountId != null }));
	const open = (s: string) => (OPEN as readonly string[]).includes(s);
	const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
	const debt = billOcc.filter((o) => o.isDebt);

	const checkingIds = cashRows.filter((a) => a.type === 'checking').map((a) => a.id);
	const trendRows = checkingIds.length === 0 ? [] : db.select({ asOf: accountBalances.asOf, total: sql<number>`sum(${accountBalances.current})` })
		.from(accountBalances).where(and(inArray(accountBalances.accountId, checkingIds), gte(accountBalances.asOf, addDays(opts.todayIso, -90)), lte(accountBalances.asOf, opts.todayIso)))
		.groupBy(accountBalances.asOf).orderBy(asc(accountBalances.asOf)).all();

	const cashTotal = sum(cashAccounts, (a) => a.current);
	const incomeRemaining = sum(live.filter((o) => open(o.status)), (o) => o.expected);
	const billsPending = sum(billOcc.filter((o) => open(o.status)), (o) => o.expected);
	return {
		month: opts.month, label: `${MONTHS[+opts.month.slice(5, 7) - 1]} ${opts.month.slice(0, 4)}`, prev: shiftMonth(opts.month, -1), next: shiftMonth(opts.month, 1), today: opts.todayIso,
		cash: { accounts: cashAccounts, total: cashTotal },
		income: { expected: sum(live, (o) => o.expected), received: sum(live, (o) => o.received), remaining: incomeRemaining, occurrences: incomeOcc },
		bills: { paid: sum(billOcc, (o) => o.paid), pending: billsPending, occurrences: billOcc.map(({ extra: _e, ...o }) => o) },
		cardPayments: { planned: sum(debt.filter((o) => open(o.status)), (o) => o.expected), paid: sum(debt, (o) => o.paid), extra: sum(debt, (o) => o.extra) },
		cashLeft: cashTotal + incomeRemaining - billsPending,
		trend: trendRows.map((r) => ({ asOf: r.asOf, current: r.total }))
	};
}
```
Write the `MonthView` type out in full (copy from Interfaces); `/* as in Interfaces */` is a placeholder for this document only.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/lib/server/read/month.test.ts`

- [ ] **Step 5: Page load, its test, and the page**

`src/routes/+page.server.ts`:
```ts
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { monthView } from '$lib/server/read/month';
import { todayIso } from '$lib/dates';

export const load: PageServerLoad = ({ url }) => {
	const config = getConfig();
	const today = todayIso(config.timeZone);
	const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') ?? '') ? url.searchParams.get('month')! : today.slice(0, 7);
	return { view: monthView(getDb(), { month, todayIso: today, cadence: config.cadence }) };
};
```
`src/routes/month.test.ts` (use the harness from Conventions):
```ts
import { load } from './+page.server';
describe('month page load', () => {
	it('defaults to the current month and honours ?month', async () => {
		const a = (await load({ url: new URL('http://localhost/') } as never)) as { view: { month: string } };
		expect(a.view.month).toMatch(/^\d{4}-\d{2}$/);
		const b = (await load({ url: new URL('http://localhost/?month=2026-07') } as never)) as { view: { month: string; label: string } };
		expect(b.view.month).toBe('2026-07'); expect(b.view.label).toBe('July 2026');
	});
});
```
`src/lib/ui/Sparkline.svelte`:
```svelte
<script lang="ts">
	let { points, height = 60 }: { points: { asOf: string; current: number }[]; height?: number } = $props();
	const w = 320;
	const d = $derived.by(() => {
		if (points.length < 2) return '';
		const ys = points.map((p) => p.current); const min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
		return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / (points.length - 1)) * w},${height - 4 - ((p.current - min) / span) * (height - 8)}`).join(' ');
	});
</script>
{#if points.length >= 2}
	<svg class="chart" viewBox="0 0 {w} {height}" preserveAspectRatio="none"><path d={d} fill="none" stroke="var(--accent)" stroke-width="2" /></svg>
{:else}<p class="muted small">Trend appears once two balance snapshots exist.</p>{/if}
```
`src/routes/+page.svelte`:
```svelte
<script lang="ts">
	import Money from '$lib/ui/Money.svelte';
	import Sparkline from '$lib/ui/Sparkline.svelte';
	let { data } = $props();
	const v = $derived(data.view);
</script>

<div class="toolbar">
	<a href="/?month={v.prev}">← {v.prev}</a>
	<h1 style="margin:0">{v.label}</h1>
	<a href="/?month={v.next}">{v.next} →</a>
</div>

<div class="cards">
	<div class="card"><div class="label">Cash on hand</div><div class="value"><Money cents={v.cash.total} /></div>
		{#each v.cash.accounts as a}<div class="small">{a.name} <Money cents={a.current} /> <span class="muted">{a.asOf ?? 'no balance'}</span></div>{/each}</div>
	<div class="card"><div class="label">Income received / expected</div><div class="value"><Money cents={v.income.received} /> <span class="muted">/ <Money cents={v.income.expected} /></span></div></div>
	<div class="card"><div class="label">Bills paid / pending</div><div class="value"><Money cents={v.bills.paid} /> <span class="muted">/ <Money cents={v.bills.pending} /></span></div></div>
	<div class="card"><div class="label">Card payments planned</div><div class="value"><Money cents={v.cardPayments.planned} /></div><div class="small">paid <Money cents={v.cardPayments.paid} />, extra <Money cents={v.cardPayments.extra} /></div></div>
	<div class="card"><div class="label">Cash left at month end</div><div class="value"><Money cents={v.cashLeft} signed /></div></div>
</div>

<h2>Checking balance, last 90 days</h2>
<Sparkline points={v.trend} />

<h2>Bills</h2>
<table><thead><tr><th>Bill</th><th>Due</th><th class="num">Expected</th><th class="num">Paid</th><th>Status</th></tr></thead>
<tbody>{#each v.bills.occurrences as o}<tr><td>{o.name}{#if o.isDebt} <span class="muted small">card</span>{/if}</td><td>{o.dueDate}</td><td class="num"><Money cents={o.expected} /></td><td class="num"><Money cents={o.paid} /></td><td><span class="status {o.status}">{o.status}</span></td></tr>{:else}<tr><td colspan="5" class="muted">No bill occurrences this month.</td></tr>{/each}</tbody></table>

<h2>Income</h2>
<table><thead><tr><th>Source</th><th>Expected on</th><th class="num">Expected</th><th class="num">Received</th><th>Status</th></tr></thead>
<tbody>{#each v.income.occurrences as o}<tr><td>{o.name}</td><td>{o.dueDate}</td><td class="num"><Money cents={o.expected} /></td><td class="num"><Money cents={o.received} /></td><td><span class="status {o.status}">{o.status}</span></td></tr>{:else}<tr><td colspan="5" class="muted">No income occurrences this month.</td></tr>{/each}</tbody></table>
```

- [ ] **Step 6: Verify** — `npx vitest run` all pass; `npm run check` 0 errors; dev-server smoke `curl -s localhost:5173/ | grep -c 'Cash on hand'` → `1`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/read/month.ts src/lib/server/read/month.test.ts src/routes/+page.server.ts src/routes/+page.svelte src/routes/month.test.ts src/lib/ui/Sparkline.svelte
git commit -m "feat: month page with cash, income, bills, card payments and checking trend"
```

---

### Task 4: Budget page — envelope grid, ready-to-assign, underfunding, assign and move

**Files:**
- Create: `src/lib/server/read/budget.ts`, `src/lib/server/read/budget.test.ts`, `src/routes/api/budget/assign/+server.ts`, `src/routes/api/budget/move/+server.ts`, `src/routes/api/budget/budget.test.ts`, `src/routes/budget/+page.server.ts`, `src/routes/budget/+page.svelte`

**Interfaces:**
- Consumes: `budgetForPeriod`, `currentPeriodId`, `assign`, `moveMoney`, `paymentCategoryForAccount`.
- Produces:
```ts
export type BudgetView = {
	period: { id: number; label: string; startDate: string; endDate: string; isCurrent: boolean };
	periods: { id: number; label: string }[];                       // all periods, ascending
	readyToAssign: number;
	groups: { id: number; name: string; categories: { id: number; name: string; kind: string; accountId: number | null; hidden: boolean;
		carried: number; assigned: number; activity: number; available: number; creditOverspend: number; cashOverspend: number }[] }[];
	underfunded: { accountId: number; accountName: string; owed: number; available: number; underfunded: number }[];
};
export function budgetView(db: DbOrTx, opts: { periodId: number | null; todayIso: string; cadence: Cadence }): BudgetView
```
Rules: `periodId: null` means the current period (`currentPeriodId`). Groups ordered by `sort, id`; categories by `sort, id`; hidden categories included with `hidden: true` (the page hides them behind a toggle). Kinds in `NO_ENVELOPE_KINDS` are omitted from `groups`. Numbers come from `budgetForPeriod(db, periodId).byPeriod.get(periodId)`, missing entries are zeros. `underfunded` lists every unclosed credit account with a payment category: `owed = cardBalanceOwed.get(accountId) ?? 0`, `available` = that category's available, `underfunded = result.underfunded.get(accountId) ?? 0`; include only rows with `owed > 0`.
- Routes: `POST /api/budget/assign { periodId, categoryId, assigned }` → `{ ok: true }`; `POST /api/budget/move { periodId, fromCategoryId, toCategoryId, amount }` → `{ ok: true }`. Both validate integers with `cents`/`intParam`-style checks (`ValidationError`).

- [ ] **Step 1: Failing read-model test**

`src/lib/server/read/budget.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { createTransaction } from '../ledger/transactions';
import { assign } from '../ledger/assignments';
import { appendBalance } from '../sync/connections';
import { periodIdForDate } from '../budget/periods';
import { budgetView } from './budget';

describe('budgetView', () => {
	it('lays out groups with envelope numbers, RTA, and the card strip', () => {
		const f = fixture();
		const p = periodIdForDate(f.db, '2026-09-08');
		appendBalance(f.db, f.checking, { asOf: '2026-09-08', current: 100000, source: 'manual' });
		appendBalance(f.db, f.card, { asOf: '2026-09-08', current: -8000, source: 'manual' });
		assign(f.db, p, f.groceries, 5000);
		createTransaction(f.db, { accountId: f.card, externalId: 'c1', postedDate: '2026-09-03', amount: -8000, payeeRaw: 'WF', source: 'sync', splits: [{ categoryId: f.groceries, amount: -8000 }] });
		const v = budgetView(f.db, { periodId: null, todayIso: '2026-09-08', cadence: 'semi_monthly' });
		expect(v.period.id).toBe(p); expect(v.period.isCurrent).toBe(true);
		const spending = v.groups.find((g) => g.name === 'Spending')!;
		const g = spending.categories.find((c) => c.id === f.groceries)!;
		expect(g).toMatchObject({ assigned: 5000, activity: -8000, available: 0, creditOverspend: 3000 });
		expect(v.groups.some((g) => g.name === 'System')).toBe(false);
		const card = v.underfunded.find((u) => u.accountId === f.card)!;
		expect(card.owed).toBe(8000); expect(card.available).toBe(5000); expect(card.underfunded).toBe(3000);
		expect(v.readyToAssign).toBe(100000 - 5000);
		expect(v.periods.length).toBeGreaterThan(4);
	});
});
```
(The §7 scenario: $80 on the card with $50 available → $50 moves to the card envelope, $30 is credit overspend, RTA = cash − Σ positive available = 100000 − 5000.) If the numbers disagree with `envelope.ts`, the test is wrong, not the engine: read `envelope.test.ts` for the canonical scenario and adjust the assertion, noting the change in your report.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/server/read/budget.test.ts`

- [ ] **Step 3: Implement budget.ts**

```ts
import { asc, eq, isNull, and } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, categories, categoryGroups, periods } from '../db/schema';
import { budgetForPeriod } from '../budget/load';
import { NO_ENVELOPE_KINDS } from '../budget/envelope';
import { currentPeriodId, type Cadence } from '../budget/periods';

export type BudgetView = { /* copy from Interfaces */ };

export function budgetView(db: DbOrTx, opts: { periodId: number | null; todayIso: string; cadence: Cadence }): BudgetView {
	const currentId = currentPeriodId(db, opts.cadence, opts.todayIso);
	const periodId = opts.periodId ?? currentId;
	const period = db.select().from(periods).where(eq(periods.id, periodId)).get();
	if (!period) throw new Error(`period ${periodId} not found`);
	const all = db.select({ id: periods.id, label: periods.label }).from(periods).orderBy(asc(periods.startDate)).all();
	const result = budgetForPeriod(db, periodId);
	const cells = result.byPeriod.get(periodId) ?? new Map();
	const zero = { carried: 0, assigned: 0, activity: 0, available: 0, creditOverspend: 0, cashOverspend: 0 };
	const groupRows = db.select().from(categoryGroups).orderBy(asc(categoryGroups.sort), asc(categoryGroups.id)).all();
	const catRows = db.select().from(categories).orderBy(asc(categories.sort), asc(categories.id)).all();
	const groups = groupRows.map((g) => ({
		id: g.id, name: g.name,
		categories: catRows.filter((c) => c.groupId === g.id && !NO_ENVELOPE_KINDS.has(c.kind)).map((c) => ({
			id: c.id, name: c.name, kind: c.kind, accountId: c.accountId, hidden: c.hidden, ...(cells.get(c.id) ?? zero)
		}))
	})).filter((g) => g.categories.length > 0);
	const cards = db.select().from(accounts).where(and(eq(accounts.type, 'credit'), isNull(accounts.closedAt))).all();
	const underfunded = cards.flatMap((a) => {
		const cat = catRows.find((c) => c.kind === 'debt_payment' && c.accountId === a.id);
		const owed = result.cardBalanceOwed.get(a.id) ?? 0;
		if (!cat || owed <= 0) return [];
		return [{ accountId: a.id, accountName: a.name, owed, available: (cells.get(cat.id) ?? zero).available, underfunded: result.underfunded.get(a.id) ?? 0 }];
	});
	return {
		period: { id: period.id, label: period.label, startDate: period.startDate, endDate: period.endDate, isCurrent: period.id === currentId },
		periods: all, readyToAssign: result.readyToAssign, groups, underfunded
	};
}
```
`cardBalanceOwed` and `underfunded` are keyed by account id (`envelope.ts:188-189`).

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Failing route tests**

`src/routes/api/budget/budget.test.ts` (harness from Conventions, plus):
```ts
import { getDb } from '$lib/server/db/instance';
import { budgetAssignments, categoryGroups } from '$lib/server/db/schema';
import { createCategory, systemCategoryId } from '$lib/server/ledger/categories';
import { currentPeriodId } from '$lib/server/budget/periods';
import { POST as assignRoute } from './assign/+server';
import { POST as moveRoute } from './move/+server';
import { eq } from 'drizzle-orm';

describe('budget routes', () => {
	it('assigns and moves money', async () => {
		const db = getDb(); const p = currentPeriodId(db, 'semi_monthly', '2026-09-08');
		const group = db.select().from(categoryGroups).where(eq(categoryGroups.name, 'Spending')).get()!.id;
		const a = createCategory(db, { groupId: group, name: 'A', kind: 'spending' }); const b = createCategory(db, { groupId: group, name: 'B', kind: 'spending' });
		expect((await assignRoute({ request: req({ periodId: p, categoryId: a, assigned: 5000 }) } as never)).status).toBe(200);
		expect((await moveRoute({ request: req({ periodId: p, fromCategoryId: a, toCategoryId: b, amount: 2000 }) } as never)).status).toBe(200);
		const rows = db.select().from(budgetAssignments).where(eq(budgetAssignments.periodId, p)).all();
		expect(Object.fromEntries(rows.map((r) => [r.categoryId, r.assigned]))).toEqual({ [a]: 3000, [b]: 2000 });
	});
	it('rejects assigning to a category with no envelope (409) and a non-integer amount (400)', async () => {
		const db = getDb(); const p = currentPeriodId(db, 'semi_monthly', '2026-09-08');
		const res = await assignRoute({ request: req({ periodId: p, categoryId: systemCategoryId(db, 'income'), assigned: 1 }) } as never);
		expect(res.status).toBe(409); expect((await res.json()).code).toBe('ASSIGN_NO_ENVELOPE');
		expect((await assignRoute({ request: req({ periodId: p, categoryId: 1, assigned: 1.5 }) } as never)).status).toBe(400);
		expect(db.select().from(budgetAssignments).all()).toHaveLength(0);
	});
});
```

- [ ] **Step 6: Run to verify they fail**, then implement the routes

`src/routes/api/budget/assign/+server.ts`:
```ts
import { handle, readJson, cents } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { assign } from '$lib/server/ledger/assignments';
export const POST = handle(async ({ request }) => {
	const b = await readJson<{ periodId: unknown; categoryId: unknown; assigned: unknown }>(request);
	assign(getDb(), cents(b.periodId, 'periodId'), cents(b.categoryId, 'categoryId'), cents(b.assigned, 'assigned'));
	return { ok: true };
});
```
`src/routes/api/budget/move/+server.ts`:
```ts
import { handle, readJson, cents } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { moveMoney } from '$lib/server/ledger/assignments';
export const POST = handle(async ({ request }) => {
	const b = await readJson<{ periodId: unknown; fromCategoryId: unknown; toCategoryId: unknown; amount: unknown }>(request);
	moveMoney(getDb(), cents(b.periodId, 'periodId'), cents(b.fromCategoryId, 'fromCategoryId'), cents(b.toCategoryId, 'toCategoryId'), cents(b.amount, 'amount'));
	return { ok: true };
});
```
(`cents` is the integer check; ids are integers too. Rename it in your head as `integer` if that reads better, but keep one helper.)

- [ ] **Step 7: Page load and page**

`src/routes/budget/+page.server.ts`:
```ts
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { budgetView } from '$lib/server/read/budget';
import { todayIso } from '$lib/dates';
export const load: PageServerLoad = ({ url }) => {
	const config = getConfig();
	const raw = url.searchParams.get('period');
	return { view: budgetView(getDb(), { periodId: raw && /^\d+$/.test(raw) ? Number(raw) : null, todayIso: todayIso(config.timeZone), cadence: config.cadence }) };
};
```
`src/routes/budget/+page.svelte`:
```svelte
<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import Money from '$lib/ui/Money.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import { post } from '$lib/ui/api';
	import { decimalToCents, formatCents } from '$lib/money';
	let { data } = $props();
	const v = $derived(data.view);
	let error = $state(''); let showHidden = $state(false);
	let move = $state<{ from: number; to: number | null; amount: string } | null>(null);
	const allCats = $derived(v.groups.flatMap((g) => g.categories));

	async function assignTo(categoryId: number, dollars: string) {
		error = '';
		try { await post('/api/budget/assign', { periodId: v.period.id, categoryId, assigned: decimalToCents(dollars || '0') }); await invalidateAll(); }
		catch (e) { error = (e as Error).message; }
	}
	async function doMove() {
		if (!move || move.to == null) return; error = '';
		try { await post('/api/budget/move', { periodId: v.period.id, fromCategoryId: move.from, toCategoryId: move.to, amount: decimalToCents(move.amount) }); move = null; await invalidateAll(); }
		catch (e) { error = (e as Error).message; }
	}
	const dollars = (c: number) => (c / 100).toFixed(2);
</script>

<div class="toolbar">
	<h1 style="margin:0">Budget</h1>
	<select value={v.period.id} onchange={(e) => goto(`/budget?period=${(e.target as HTMLSelectElement).value}`)}>
		{#each v.periods as p}<option value={p.id}>{p.label}</option>{/each}
	</select>
	{#if v.period.isCurrent}<span class="status paid">current</span>{/if}
	<label class="small"><input type="checkbox" bind:checked={showHidden} /> show hidden</label>
	<a href="/budget/categories?period={v.period.id}" class="small">Manage categories</a>
</div>
<div class="cards"><div class="card"><div class="label">Ready to assign</div><div class="value"><Money cents={v.readyToAssign} signed /></div></div></div>
{#if error}<p class="error">{error}</p>{/if}
{#if v.underfunded.length}
	<div class="strip">{#each v.underfunded as u}<span>{u.accountName}: owes <Money cents={u.owed} />, envelope <Money cents={u.available} />, <strong>underfunded <Money cents={u.underfunded} /></strong></span>{/each}</div>
{/if}
<table>
	<thead><tr><th>Category</th><th class="num">Carried</th><th class="num">Assigned</th><th class="num">Activity</th><th class="num">Available</th><th></th></tr></thead>
	<tbody>
	{#each v.groups as g}
		<tr class="group"><td colspan="6">{g.name}</td></tr>
		{#each g.categories.filter((c) => showHidden || !c.hidden) as c (c.id)}
			<tr>
				<td>{c.name}{#if c.hidden} <span class="muted small">hidden</span>{/if}{#if c.creditOverspend > 0} <span class="status overdue" title="credit overspend">{formatCents(c.creditOverspend)} on card</span>{/if}</td>
				<td class="num"><Money cents={c.carried} /></td>
				<td class="num"><input class="num" value={dollars(c.assigned)} onchange={(e) => assignTo(c.id, (e.target as HTMLInputElement).value)} /></td>
				<td class="num"><Money cents={c.activity} /></td>
				<td class="num"><Money cents={c.available} signed /></td>
				<td><button onclick={() => (move = { from: c.id, to: null, amount: '' })}>Move</button></td>
			</tr>
		{/each}
	{/each}
	</tbody>
</table>

{#if move}
<Dialog open={true} title="Move money" onclose={() => (move = null)}>
	<form class="grid" onsubmit={(e) => { e.preventDefault(); doMove(); }}>
		<label for="mv-from">From</label><select id="mv-from" bind:value={move.from}>{#each allCats as c}<option value={c.id}>{c.name} ({formatCents(c.available)})</option>{/each}</select>
		<label for="mv-to">To</label><select id="mv-to" bind:value={move.to}><option value={null}>choose…</option>{#each allCats as c}<option value={c.id}>{c.name}</option>{/each}</select>
		<label for="mv-amt">Amount</label><input id="mv-amt" class="num" bind:value={move.amount} placeholder="0.00" />
		<div class="actions" style="grid-column: 1 / -1"><button type="button" onclick={() => (move = null)}>Cancel</button><button class="primary" type="submit">Move</button></div>
	</form>
</Dialog>
{/if}
```
The "Manage categories" link targets Task 5's page; it 404s until then, which is acceptable for this commit.

- [ ] **Step 8: Verify** — `npx vitest run` all pass; `npm run check` 0 errors; dev smoke `curl -s localhost:5173/budget | grep -c 'Ready to assign'` → `1`.

- [ ] **Step 9: Commit**

```bash
git add src/lib/server/read/budget.ts src/lib/server/read/budget.test.ts src/routes/api/budget src/routes/budget
git commit -m "feat: budget page with envelope grid, ready to assign, underfunding strip, assign and move"
```

---

### Task 5: Category management — tree read model, routes, page

**Files:**
- Create: `src/lib/server/read/categories.ts`, `src/lib/server/read/categories.test.ts`, `src/routes/api/categories/+server.ts`, `src/routes/api/categories/[id]/+server.ts`, `src/routes/api/category-groups/+server.ts`, `src/routes/api/categories/categories.test.ts`, `src/routes/budget/categories/+page.server.ts`, `src/routes/budget/categories/+page.svelte`

**Interfaces:**
- Consumes: `createGroup`, `createCategory`, `updateCategory` (Task 2), `renameCategory`, `hideCategory`, `moveCategory`.
- Produces:
```ts
export type CategoryTree = { groups: { id: number; name: string; sort: number; categories: { id: number; name: string; kind: CategoryKind; accountId: number | null; hidden: boolean; isSystem: boolean; sort: number }[] }[];
	debtAccounts: { id: number; name: string }[]; kinds: readonly CategoryKind[] };
export function categoryTree(db: DbOrTx): CategoryTree   // every group and category incl. hidden and system; used by pickers in Ledger and Bills too
```
- Routes: `POST /api/category-groups { name }` → `{ id }`; `POST /api/categories { groupId, name, kind, accountId? }` → `{ id }`; `POST /api/categories/[id] { name?, kind?, accountId?, hidden?, groupId?, sort? }` → `{ ok: true }`.

- [ ] **Step 1: Failing tests**

`src/lib/server/read/categories.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { categoryTree } from './categories';
describe('categoryTree', () => {
	it('lists groups in sort order with their categories, debt accounts, and kinds', () => {
		const f = fixture();
		const t = categoryTree(f.db);
		expect(t.groups.map((g) => g.name)).toEqual(['System', 'Bills', 'Spending', 'Debt Payments', 'Savings']);
		const debt = t.groups.find((g) => g.name === 'Debt Payments')!;
		expect(debt.categories[0]).toMatchObject({ name: 'Sapphire', kind: 'debt_payment', accountId: f.card, isSystem: false });
		expect(t.debtAccounts).toEqual([{ id: f.card, name: 'Sapphire' }]);
		expect(t.kinds).toContain('spending');
	});
});
```
`src/routes/api/categories/categories.test.ts` (harness):
```ts
import { getDb } from '$lib/server/db/instance';
import { categories } from '$lib/server/db/schema';
import { createConnection, upsertAccount } from '$lib/server/sync/connections';
import { POST as createGroupRoute } from '../category-groups/+server';
import { POST as createRoute } from './+server';
import { POST as patchRoute } from './[id]/+server';
import { eq } from 'drizzle-orm';
describe('category routes', () => {
	it('creates a group and a category, then renames and hides it', async () => {
		const g = await (await createGroupRoute({ request: req({ name: 'Fun' }) } as never)).json();
		const c = await (await createRoute({ request: req({ groupId: g.id, name: 'Games', kind: 'spending' }) } as never)).json();
		expect((await patchRoute({ request: req({ name: 'Video games', hidden: true }), params: { id: String(c.id) } } as never)).status).toBe(200);
		const row = getDb().select().from(categories).where(eq(categories.id, c.id)).get()!;
		expect(row.name).toBe('Video games'); expect(row.hidden).toBe(true); expect(row.groupId).toBe(g.id);
	});
	it('rejects a second payment category for the same account with 409', async () => {
		const db = getDb();
		const conn = createConnection(db, { provider: 'manual', institutionName: 'T', appKey: 'k'.repeat(40) });
		const card = upsertAccount(db, conn, { externalId: 'c', name: 'C', type: 'credit' }).id;
		const g = await (await createGroupRoute({ request: req({ name: 'Debt' }) } as never)).json();
		expect((await createRoute({ request: req({ groupId: g.id, name: 'C', kind: 'debt_payment', accountId: card }) } as never)).status).toBe(200);
		const dup = await createRoute({ request: req({ groupId: g.id, name: 'C again', kind: 'debt_payment', accountId: card }) } as never);
		expect(dup.status).toBe(409); expect((await dup.json()).code).toBe('DEBT_CATEGORY_DUPLICATE');
		expect(db.select().from(categories).where(eq(categories.accountId, card)).all()).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run to verify they fail**, then implement

`src/lib/server/read/categories.ts`:
```ts
import { asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, categories, categoryGroups, CATEGORY_KINDS, type CategoryKind } from '../db/schema';
export type CategoryTree = { /* copy from Interfaces */ };
export function categoryTree(db: DbOrTx): CategoryTree {
	const groups = db.select().from(categoryGroups).orderBy(asc(categoryGroups.sort), asc(categoryGroups.id)).all();
	const cats = db.select().from(categories).orderBy(asc(categories.sort), asc(categories.id)).all();
	const debtAccounts = db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(eq(accounts.isDebt, true)).orderBy(asc(accounts.name)).all();
	return {
		groups: groups.map((g) => ({ id: g.id, name: g.name, sort: g.sort, categories: cats.filter((c) => c.groupId === g.id).map((c) => ({ id: c.id, name: c.name, kind: c.kind, accountId: c.accountId, hidden: c.hidden, isSystem: c.isSystem, sort: c.sort })) })),
		debtAccounts, kinds: CATEGORY_KINDS
	};
}
```
Routes:
```ts
// src/routes/api/category-groups/+server.ts
import { handle, readJson, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { createGroup } from '$lib/server/ledger/categories';
export const POST = handle(async ({ request }) => {
	const b = await readJson<{ name?: string }>(request);
	if (!b.name?.trim()) throw new ValidationError('name is required');
	return { id: createGroup(getDb(), b.name.trim(), 100) };
});
// src/routes/api/categories/+server.ts
import { handle, readJson, cents, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { createCategory } from '$lib/server/ledger/categories';
import { CATEGORY_KINDS, type CategoryKind } from '$lib/server/db/schema';
export const POST = handle(async ({ request }) => {
	const b = await readJson<{ groupId: unknown; name?: string; kind?: string; accountId?: unknown }>(request);
	if (!b.name?.trim()) throw new ValidationError('name is required');
	if (!(CATEGORY_KINDS as readonly string[]).includes(b.kind ?? '')) throw new ValidationError('kind is invalid');
	const accountId = b.accountId == null ? null : cents(b.accountId, 'accountId');
	return { id: createCategory(getDb(), { groupId: cents(b.groupId, 'groupId'), name: b.name.trim(), kind: b.kind as CategoryKind, accountId }) };
});
// src/routes/api/categories/[id]/+server.ts
import { handle, readJson, intParam, cents, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { updateCategory } from '$lib/server/ledger/categories';
import { CATEGORY_KINDS, type CategoryKind } from '$lib/server/db/schema';
export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id');
	const b = await readJson<Record<string, unknown>>(request);
	const patch: Parameters<typeof updateCategory>[2] = {};
	if (typeof b.name === 'string') { if (!b.name.trim()) throw new ValidationError('name is required'); patch.name = b.name.trim(); }
	if (b.kind !== undefined) { if (!(CATEGORY_KINDS as readonly string[]).includes(String(b.kind))) throw new ValidationError('kind is invalid'); patch.kind = b.kind as CategoryKind; }
	if (b.accountId !== undefined) patch.accountId = b.accountId == null ? null : cents(b.accountId, 'accountId');
	if (b.hidden !== undefined) { if (typeof b.hidden !== 'boolean') throw new ValidationError('hidden must be boolean'); patch.hidden = b.hidden; }
	if (b.groupId !== undefined) patch.groupId = cents(b.groupId, 'groupId');
	if (b.sort !== undefined) patch.sort = cents(b.sort, 'sort');
	updateCategory(getDb(), id, patch);
	return { ok: true };
});
```

- [ ] **Step 3: Run to verify they pass**

- [ ] **Step 4: Page**

`src/routes/budget/categories/+page.server.ts`:
```ts
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { categoryTree } from '$lib/server/read/categories';
export const load: PageServerLoad = () => ({ tree: categoryTree(getDb()) });
```
`src/routes/budget/categories/+page.svelte`:
```svelte
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { post } from '$lib/ui/api';
	let { data } = $props();
	const t = $derived(data.tree);
	let error = $state(''); let newGroup = $state('');
	let draft = $state<Record<number, { name: string; kind: string; accountId: number | null }>>({});
	const run = async (fn: () => Promise<unknown>) => { error = ''; try { await fn(); await invalidateAll(); } catch (e) { error = (e as Error).message; } };
	function startNew(groupId: number) { draft[groupId] = { name: '', kind: 'spending', accountId: null }; }
	async function create(groupId: number) {
		const d = draft[groupId]; await run(() => post('/api/categories', { groupId, name: d.name, kind: d.kind, accountId: d.kind === 'debt_payment' ? d.accountId : null })); delete draft[groupId];
	}
	const patch = (id: number, body: unknown) => run(() => post(`/api/categories/${id}`, body));
</script>

<h1>Categories</h1>
<p class="small"><a href="/budget">← Budget</a></p>
{#if error}<p class="error">{error}</p>{/if}
<form class="toolbar" onsubmit={(e) => { e.preventDefault(); run(() => post('/api/category-groups', { name: newGroup })).then(() => (newGroup = '')); }}>
	<input placeholder="New group name" bind:value={newGroup} /><button class="primary" type="submit">Add group</button>
</form>
{#each t.groups as g}
	<h2>{g.name} <button class="small" onclick={() => startNew(g.id)}>+ category</button></h2>
	<table>
		<thead><tr><th>Name</th><th>Kind</th><th>Linked account</th><th>Group</th><th>Hidden</th></tr></thead>
		<tbody>
		{#each g.categories as c (c.id)}
			<tr>
				<td><input class="inline" value={c.name} onchange={(e) => patch(c.id, { name: (e.target as HTMLInputElement).value })} /></td>
				<td>{#if c.isSystem}<span class="muted">{c.kind}</span>{:else}
					<select value={c.kind} onchange={(e) => patch(c.id, { kind: (e.target as HTMLSelectElement).value, accountId: c.accountId })}>{#each t.kinds as k}<option value={k}>{k}</option>{/each}</select>{/if}</td>
				<td>{#if c.kind === 'debt_payment'}
					<select value={c.accountId} onchange={(e) => patch(c.id, { accountId: Number((e.target as HTMLSelectElement).value) })}>{#each t.debtAccounts as a}<option value={a.id}>{a.name}</option>{/each}</select>{:else}<span class="muted">—</span>{/if}</td>
				<td><select value={c.groupId ?? g.id} onchange={(e) => patch(c.id, { groupId: Number((e.target as HTMLSelectElement).value) })}>{#each t.groups as og}<option value={og.id}>{og.name}</option>{/each}</select></td>
				<td><input type="checkbox" checked={c.hidden} onchange={(e) => patch(c.id, { hidden: (e.target as HTMLInputElement).checked })} /></td>
			</tr>
		{/each}
		{#if draft[g.id]}
			<tr>
				<td><input placeholder="Name" bind:value={draft[g.id].name} /></td>
				<td><select bind:value={draft[g.id].kind}>{#each t.kinds as k}<option value={k}>{k}</option>{/each}</select></td>
				<td>{#if draft[g.id].kind === 'debt_payment'}<select bind:value={draft[g.id].accountId}><option value={null}>choose…</option>{#each t.debtAccounts as a}<option value={a.id}>{a.name}</option>{/each}</select>{/if}</td>
				<td colspan="2"><button class="primary" onclick={() => create(g.id)}>Create</button> <button onclick={() => delete draft[g.id]}>Cancel</button></td>
			</tr>
		{/if}
		</tbody>
	</table>
{/each}
```
`categoryTree` categories carry no `groupId`; add `groupId: c.groupId` to the tree's category objects (and to the `CategoryTree` type) so the group select above works.

- [ ] **Step 5: Verify** — `npx vitest run`, `npm run check`, dev smoke `curl -s localhost:5173/budget/categories | grep -c 'Add group'` → `1`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/read/categories.ts src/lib/server/read/categories.test.ts src/routes/api/categories src/routes/api/category-groups src/routes/budget/categories
git commit -m "feat: category management page and routes"
```

---

### Task 6: Ledger read model and transaction routes

**Files:**
- Create: `src/lib/server/read/ledger.ts`, `src/lib/server/read/ledger.test.ts`, `src/routes/api/transactions/+server.ts`, `src/routes/api/transactions/[id]/+server.ts`, `src/routes/api/transactions/[id]/review/+server.ts`, `src/routes/api/transactions/[id]/delete/+server.ts`, `src/routes/api/transactions/[id]/link/+server.ts`, `src/routes/api/transactions/[id]/unlink/+server.ts`, `src/routes/api/payee-rules/+server.ts`, `src/routes/api/transactions/transactions.test.ts`

**Interfaces:**
- Consumes: `getTransaction`, `setPayee`, `setMemo`, `setPeriod`, `setSplits`, `clearReview`, `linkTransfer`, `unlinkTransfer`, `createManualTransaction`, `deleteUserTransaction` (Task 2), `createPayeeRule`, `applyPayeeRules`, `driftReport`.
- Produces:
```ts
export type LedgerFilter = { accountId?: number | null; periodId?: number | null; categoryId?: number | null; from?: string | null; to?: string | null; review?: boolean; q?: string | null; limit?: number; offset?: number };
export type LedgerRow = { id: number; accountId: number; accountName: string; postedDate: string; pending: boolean; payee: string; payeeRaw: string; memo: string | null;
	amount: number; periodId: number; periodLabel: string; source: string; needsReview: boolean; reviewReason: string | null;
	transferPeerId: number | null; transferPeerAccountName: string | null;
	splits: { id: number; categoryId: number; categoryName: string; amount: number; memo: string | null }[] };
export type LedgerView = { rows: LedgerRow[]; total: number; limit: number; offset: number;
	accounts: { id: number; name: string; type: string; closed: boolean }[]; periods: { id: number; label: string }[];
	drift: { accountId: number; accountName: string; drift: number }[] };
export function ledgerView(db: DbOrTx, f: LedgerFilter): LedgerView
```
Rules: live rows only (`deleted_at IS NULL`); newest first (`posted_date desc, id desc`); default `limit 100`; `q` matches `payee` or `payee_raw` or `memo` case-insensitively (`like '%q%'`, escape `%`/`_`); `categoryId` filters rows having any split in that category; `from`/`to` bound `posted_date` inclusive; `review: true` restricts to `needs_review = 1`. `drift` lists accounts with non-zero drift from `driftReport` (always, so the review queue can show them). `total` is the count before limit/offset.
- Routes (all `POST`, JSON):
  - `/api/transactions { accountId, postedDate, amount, payee, memo?, categoryId? }` → `{ id }` (manual entry)
  - `/api/transactions/[id] { payee?, memo?, periodId?, splits?: { categoryId, amount, memo? }[] }` → `{ ok: true }`. `payee` → `setPayee`; `memo` → `setMemo`; `periodId` → `setPeriod`; `splits` → `setSplits` (409 `SPLITS_DO_NOT_SUM` when they don't sum).
  - `/api/transactions/[id]/review { }` → clears the flag.
  - `/api/transactions/[id]/delete { }` → `deleteUserTransaction` (409 `NOT_USER_ROW` for synced rows).
  - `/api/transactions/[id]/link { peerId }` → `linkTransfer` (409 `TRANSFER_NOT_OPPOSITE` / `TRANSFER_ALREADY_LINKED`); `/unlink {}` → `unlinkTransfer`.
  - `/api/payee-rules { pattern, payee, categoryId?, isRegex?, applyToExisting?: boolean }` → `{ id, applied: { renamed, categorized } }`. When `applyToExisting`, run `applyPayeeRules` over every live transaction id whose `payee_raw` matches the rule (`matchPayeeRule([rule], payeeRaw)`), so the new rule renames history too.

- [ ] **Step 1: Failing read-model test**

`src/lib/server/read/ledger.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { createTransaction, flagForReview, linkTransfer } from '../ledger/transactions';
import { appendBalance } from '../sync/connections';
import { ledgerView } from './ledger';

describe('ledgerView', () => {
	it('filters, searches, paginates, and joins names', () => {
		const f = fixture();
		const t1 = createTransaction(f.db, { accountId: f.checking, externalId: 'a', postedDate: '2026-09-02', amount: -4500, payeeRaw: 'WHOLE FOODS 123', payee: 'Whole Foods', source: 'sync', splits: [{ categoryId: f.groceries, amount: -4500 }] });
		const t2 = createTransaction(f.db, { accountId: f.checking, externalId: 'b', postedDate: '2026-09-05', amount: -30000, payeeRaw: 'PAYMENT TO CARD', source: 'sync' });
		const t3 = createTransaction(f.db, { accountId: f.card, externalId: 'c', postedDate: '2026-09-05', amount: 30000, payeeRaw: 'PAYMENT THANK YOU', source: 'sync' });
		linkTransfer(f.db, t2, t3);
		flagForReview(f.db, t1, 'amount_changed');
		appendBalance(f.db, f.card, { asOf: '2026-09-08', current: 0, source: 'manual' }); // ledger says +30000 → drift

		const all = ledgerView(f.db, {});
		expect(all.total).toBe(3); expect(all.rows.map((r) => r.id)).toEqual([t3, t2, t1]);
		expect(all.rows[2]).toMatchObject({ payee: 'Whole Foods', accountName: 'Checking', needsReview: true, reviewReason: 'amount_changed', periodLabel: 'Sep 1–15, 2026' });
		expect(all.rows[2].splits[0]).toMatchObject({ categoryName: 'Groceries', amount: -4500 });
		expect(all.rows[1]).toMatchObject({ transferPeerId: t3, transferPeerAccountName: 'Sapphire' });
		expect(ledgerView(f.db, { accountId: f.card }).rows.map((r) => r.id)).toEqual([t3]);
		expect(ledgerView(f.db, { q: 'whole' }).rows.map((r) => r.id)).toEqual([t1]);
		expect(ledgerView(f.db, { categoryId: f.groceries }).rows.map((r) => r.id)).toEqual([t1]);
		expect(ledgerView(f.db, { from: '2026-09-03', to: '2026-09-05' }).total).toBe(2);
		expect(ledgerView(f.db, { review: true }).rows.map((r) => r.id)).toEqual([t1]);
		expect(ledgerView(f.db, { limit: 2, offset: 2 }).rows.map((r) => r.id)).toEqual([t1]);
		expect(all.drift).toEqual([{ accountId: f.card, accountName: 'Sapphire', drift: -30000 }]);
		expect(all.accounts.map((a) => a.name)).toEqual(['Checking', 'Savings', 'Sapphire']);
	});
});
```

- [ ] **Step 2: Run to verify it fails**, then implement `ledger.ts`

```ts
import { and, asc, desc, eq, gte, inArray, isNull, like, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { DbOrTx } from '../db';
import { accounts, categories, periods, transactions, transactionSplits } from '../db/schema';
import { driftReport } from '../reconcile';

export type LedgerFilter = { /* copy */ }; export type LedgerRow = { /* copy */ }; export type LedgerView = { /* copy */ };

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function ledgerView(db: DbOrTx, f: LedgerFilter): LedgerView {
	const limit = Math.min(Math.max(f.limit ?? 100, 1), 500), offset = Math.max(f.offset ?? 0, 0);
	const conds: SQL[] = [isNull(transactions.deletedAt)];
	if (f.accountId != null) conds.push(eq(transactions.accountId, f.accountId));
	if (f.periodId != null) conds.push(eq(transactions.periodId, f.periodId));
	if (f.from) conds.push(gte(transactions.postedDate, f.from));
	if (f.to) conds.push(lte(transactions.postedDate, f.to));
	if (f.review) conds.push(eq(transactions.needsReview, true));
	if (f.q?.trim()) { const p = `%${escapeLike(f.q.trim().toLowerCase())}%`; conds.push(or(sql`lower(${transactions.payee}) like ${p} escape '\\'`, sql`lower(${transactions.payeeRaw}) like ${p} escape '\\'`, sql`lower(coalesce(${transactions.memo}, '')) like ${p} escape '\\'`)!); }
	if (f.categoryId != null) conds.push(sql`exists (select 1 from ${transactionSplits} where ${transactionSplits.transactionId} = ${transactions.id} and ${transactionSplits.categoryId} = ${f.categoryId})`);
	const where = and(...conds);
	const total = db.select({ n: sql<number>`count(*)` }).from(transactions).where(where).get()?.n ?? 0;
	const peer = alias(transactions, 'peer'); const peerAcct = alias(accounts, 'peer_acct');
	const rows = db.select({ t: transactions, accountName: accounts.name, periodLabel: periods.label, peerAccountName: peerAcct.name })
		.from(transactions).innerJoin(accounts, eq(transactions.accountId, accounts.id)).innerJoin(periods, eq(transactions.periodId, periods.id))
		.leftJoin(peer, eq(transactions.transferPeerId, peer.id)).leftJoin(peerAcct, eq(peer.accountId, peerAcct.id))
		.where(where).orderBy(desc(transactions.postedDate), desc(transactions.id)).limit(limit).offset(offset).all();
	const ids = rows.map((r) => r.t.id);
	const splits = ids.length === 0 ? [] : db.select({ s: transactionSplits, categoryName: categories.name }).from(transactionSplits)
		.innerJoin(categories, eq(transactionSplits.categoryId, categories.id)).where(inArray(transactionSplits.transactionId, ids)).orderBy(asc(transactionSplits.id)).all();
	const acctRows = db.select().from(accounts).orderBy(asc(accounts.id)).all();
	const byId = new Map(acctRows.map((a) => [a.id, a.name]));
	return {
		rows: rows.map(({ t, accountName, periodLabel, peerAccountName }) => ({
			id: t.id, accountId: t.accountId, accountName, postedDate: t.postedDate, pending: t.pending, payee: t.payee, payeeRaw: t.payeeRaw, memo: t.memo,
			amount: t.amount, periodId: t.periodId, periodLabel, source: t.source, needsReview: t.needsReview, reviewReason: t.reviewReason,
			transferPeerId: t.transferPeerId, transferPeerAccountName: peerAccountName ?? null,
			splits: splits.filter((x) => x.s.transactionId === t.id).map((x) => ({ id: x.s.id, categoryId: x.s.categoryId, categoryName: x.categoryName, amount: x.s.amount, memo: x.s.memo }))
		})),
		total, limit, offset,
		accounts: acctRows.map((a) => ({ id: a.id, name: a.name, type: a.type, closed: a.closedAt != null })),
		periods: db.select({ id: periods.id, label: periods.label }).from(periods).orderBy(desc(periods.startDate)).all(),
		drift: driftReport(db).filter((d) => d.drift != null && d.drift !== 0).map((d) => ({ accountId: d.accountId, accountName: byId.get(d.accountId) ?? String(d.accountId), drift: d.drift! }))
	};
}
```
If Drizzle's `like` helper handles `escape` poorly, the `sql` template above is the intended form. Note `or(...)` returns `SQL | undefined`; the `!` is safe with ≥1 operand.

- [ ] **Step 3: Run to verify it passes**

- [ ] **Step 4: Failing route tests**

`src/routes/api/transactions/transactions.test.ts` (harness, plus):
```ts
import { getDb } from '$lib/server/db/instance';
import { transactions, transactionSplits, payeeRules, categoryGroups } from '$lib/server/db/schema';
import { createConnection, upsertAccount } from '$lib/server/sync/connections';
import { createCategory, uncategorizedId } from '$lib/server/ledger/categories';
import { createTransaction, getTransaction } from '$lib/server/ledger/transactions';
import { POST as create } from './+server';
import { POST as patch } from './[id]/+server';
import { POST as review } from './[id]/review/+server';
import { POST as del } from './[id]/delete/+server';
import { POST as link } from './[id]/link/+server';
import { POST as unlink } from './[id]/unlink/+server';
import { POST as rules } from '../payee-rules/+server';
import { eq } from 'drizzle-orm';

function accountsFor(db: ReturnType<typeof getDb>) {
	const conn = createConnection(db, { provider: 'manual', institutionName: 'T', appKey: 'k'.repeat(40) });
	return { chk: upsertAccount(db, conn, { externalId: 'chk', name: 'Checking', type: 'checking' }).id, card: upsertAccount(db, conn, { externalId: 'card', name: 'Card', type: 'credit' }).id };
}
describe('transaction routes', () => {
	it('creates, edits, splits, links, unlinks, clears review, deletes', async () => {
		const db = getDb(); const { chk, card } = accountsFor(db);
		const group = db.select().from(categoryGroups).where(eq(categoryGroups.name, 'Spending')).get()!.id;
		const g = createCategory(db, { groupId: group, name: 'G', kind: 'spending' });
		const { id } = await (await create({ request: req({ accountId: chk, postedDate: '2026-09-03', amount: -1000, payee: 'Shop' }) } as never)).json();
		expect((await patch({ request: req({ payee: 'The Shop', memo: 'm', splits: [{ categoryId: g, amount: -600 }, { categoryId: uncategorizedId(db), amount: -400 }] }), params: { id: String(id) } } as never)).status).toBe(200);
		let t = getTransaction(db, id); expect(t.payee).toBe('The Shop'); expect(t.memo).toBe('m'); expect(t.splits).toHaveLength(2);
		const a = createTransaction(db, { accountId: chk, externalId: 'x', postedDate: '2026-09-04', amount: -5000, payeeRaw: 'PAY', source: 'sync' });
		const b = createTransaction(db, { accountId: card, externalId: 'y', postedDate: '2026-09-04', amount: 5000, payeeRaw: 'PAY', source: 'sync' });
		expect((await link({ request: req({ peerId: b }), params: { id: String(a) } } as never)).status).toBe(200);
		expect(getTransaction(db, a).transferPeerId).toBe(b);
		expect((await unlink({ request: req({}), params: { id: String(a) } } as never)).status).toBe(200);
		t = getTransaction(db, a); expect(t.transferPeerId).toBeNull(); expect(t.needsReview).toBe(true);
		expect((await review({ request: req({}), params: { id: String(a) } } as never)).status).toBe(200);
		expect(getTransaction(db, a).needsReview).toBe(false);
		expect((await del({ request: req({}), params: { id: String(id) } } as never)).status).toBe(200);
		expect(getTransaction(db, id).deletedAt).not.toBeNull();
	});
	it('rejects splits that do not sum (409) and deleting a synced row (409)', async () => {
		const db = getDb(); const { chk } = accountsFor(db);
		const s = createTransaction(db, { accountId: chk, externalId: 's', postedDate: '2026-09-04', amount: -5000, payeeRaw: 'S', source: 'sync' });
		const bad = await patch({ request: req({ splits: [{ categoryId: uncategorizedId(db), amount: -100 }] }), params: { id: String(s) } } as never);
		expect(bad.status).toBe(409); expect((await bad.json()).code).toBe('SPLITS_DO_NOT_SUM');
		expect(db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, s)).get()!.amount).toBe(-5000);
		const d = await del({ request: req({}), params: { id: String(s) } } as never);
		expect(d.status).toBe(409); expect(getTransaction(db, s).deletedAt).toBeNull();
	});
	it('creates a payee rule and applies it to existing rows', async () => {
		const db = getDb(); const { chk } = accountsFor(db);
		const t = createTransaction(db, { accountId: chk, externalId: 'r', postedDate: '2026-09-04', amount: -700, payeeRaw: 'SQ *BLUE BOTTLE 42', source: 'sync' });
		const res = await (await rules({ request: req({ pattern: 'BLUE BOTTLE', payee: 'Blue Bottle', applyToExisting: true }) } as never)).json();
		expect(res.applied.renamed).toBe(1); expect(getTransaction(db, t).payee).toBe('Blue Bottle');
		expect(db.select().from(payeeRules).all()).toHaveLength(1);
		expect((await rules({ request: req({ pattern: '', payee: 'x' }) } as never)).status).toBe(400);
	});
});
```

- [ ] **Step 5: Run to verify they fail**, then implement the routes

```ts
// src/routes/api/transactions/+server.ts
import { handle, readJson, cents, isoDate, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { createManualTransaction } from '$lib/server/ledger/transactions';
export const POST = handle(async ({ request }) => {
	const b = await readJson<{ accountId: unknown; postedDate: unknown; amount: unknown; payee?: string; memo?: string | null; categoryId?: unknown }>(request);
	if (!b.payee?.trim()) throw new ValidationError('payee is required');
	return { id: createManualTransaction(getDb(), { accountId: cents(b.accountId, 'accountId'), postedDate: isoDate(b.postedDate, 'postedDate'), amount: cents(b.amount, 'amount'), payee: b.payee.trim(), memo: b.memo ?? null, categoryId: b.categoryId == null ? null : cents(b.categoryId, 'categoryId') }) };
});
// src/routes/api/transactions/[id]/+server.ts
import { handle, readJson, intParam, cents, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { setPayee, setMemo, setPeriod, setSplits } from '$lib/server/ledger/transactions';
export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id'); const db = getDb();
	const b = await readJson<{ payee?: unknown; memo?: unknown; periodId?: unknown; splits?: unknown }>(request);
	db.transaction((tx) => {
		if (b.payee !== undefined) { if (typeof b.payee !== 'string' || !b.payee.trim()) throw new ValidationError('payee must be non-empty'); setPayee(tx, id, b.payee.trim()); }
		if (b.memo !== undefined) { if (b.memo !== null && typeof b.memo !== 'string') throw new ValidationError('memo must be a string or null'); setMemo(tx, id, b.memo); }
		if (b.periodId !== undefined) setPeriod(tx, id, cents(b.periodId, 'periodId'));
		if (b.splits !== undefined) {
			if (!Array.isArray(b.splits) || b.splits.length === 0) throw new ValidationError('splits must be a non-empty array');
			setSplits(tx, id, b.splits.map((s: { categoryId: unknown; amount: unknown; memo?: string | null }, i: number) => ({ categoryId: cents(s.categoryId, `splits[${i}].categoryId`), amount: cents(s.amount, `splits[${i}].amount`), memo: s.memo ?? null })));
		}
	});
	return { ok: true };
});
// review: clearReview(getDb(), id). delete: deleteUserTransaction(getDb(), id). unlink: unlinkTransfer(getDb(), id).
// link:
export const POST = handle(async ({ request, params }) => {
	const b = await readJson<{ peerId: unknown }>(request);
	linkTransfer(getDb(), intParam(params.id, 'id'), cents(b.peerId, 'peerId'));
	return { ok: true };
});
// src/routes/api/payee-rules/+server.ts
import { handle, readJson, cents, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { createPayeeRule, listPayeeRules, matchPayeeRule, applyPayeeRules } from '$lib/server/sync/payees';
import { transactions } from '$lib/server/db/schema';
import { isNull } from 'drizzle-orm';
export const POST = handle(async ({ request }) => {
	const b = await readJson<{ pattern?: string; payee?: string; categoryId?: unknown; isRegex?: boolean; applyToExisting?: boolean }>(request);
	if (!b.pattern?.trim() || !b.payee?.trim()) throw new ValidationError('pattern and payee are required');
	const db = getDb();
	const id = createPayeeRule(db, { pattern: b.pattern.trim(), payee: b.payee.trim(), isRegex: b.isRegex ?? false, categoryId: b.categoryId == null ? null : cents(b.categoryId, 'categoryId') });
	let applied = { renamed: 0, categorized: 0 };
	if (b.applyToExisting) {
		const rule = listPayeeRules(db).find((r) => r.id === id)!;
		const ids = db.select({ id: transactions.id, payeeRaw: transactions.payeeRaw }).from(transactions).where(isNull(transactions.deletedAt)).all()
			.filter((t) => matchPayeeRule([rule], t.payeeRaw) != null).map((t) => t.id);
		applied = applyPayeeRules(db, ids);
	}
	return { id, applied };
});
```
Note on `setPeriod`: 1A's `setPeriod` writes the column without checking the period exists; SQLite's foreign key rejects a bad id with a driver error (500). Add a `ValidationError` check that the period exists in the route (`db.select().from(periods).where(eq(periods.id, …)).get()`), so the UI gets a 400.

- [ ] **Step 6: Run to verify they pass**; `npm run check` 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/read/ledger.ts src/lib/server/read/ledger.test.ts src/routes/api/transactions src/routes/api/payee-rules
git commit -m "feat: ledger read model and transaction, review, transfer, and payee-rule routes"
```

---

### Task 7: Ledger page

**Files:**
- Create: `src/routes/ledger/+page.server.ts`, `src/routes/ledger/+page.svelte`, `src/routes/ledger/SplitEditor.svelte`, `src/routes/ledger/ledger.test.ts`

**Interfaces:**
- Consumes: `ledgerView`, `categoryTree` (Task 5), routes from Task 6.
- Page URL params: `account`, `period`, `category`, `from`, `to`, `review=1`, `q`, `page` (1-based, 100 rows each).

- [ ] **Step 1: Load and its test**

`src/routes/ledger/+page.server.ts`:
```ts
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { ledgerView } from '$lib/server/read/ledger';
import { categoryTree } from '$lib/server/read/categories';
const int = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : null);
const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
export const load: PageServerLoad = ({ url }) => {
	const p = url.searchParams; const page = Math.max(int(p.get('page')) ?? 1, 1);
	const filter = { accountId: int(p.get('account')), periodId: int(p.get('period')), categoryId: int(p.get('category')), from: date(p.get('from')), to: date(p.get('to')), review: p.get('review') === '1', q: p.get('q'), limit: 100, offset: (page - 1) * 100 };
	return { filter, page, view: ledgerView(getDb(), filter), tree: categoryTree(getDb()) };
};
```
`src/routes/ledger/ledger.test.ts` (harness):
```ts
import { load } from './+page.server';
describe('ledger page load', () => {
	it('parses filters and pages', async () => {
		const d = (await load({ url: new URL('http://localhost/ledger?review=1&page=2&q=foo&from=2026-09-01') } as never)) as { filter: Record<string, unknown>; page: number; view: { offset: number } };
		expect(d.filter).toMatchObject({ review: true, q: 'foo', from: '2026-09-01', to: null, accountId: null });
		expect(d.page).toBe(2); expect(d.view.offset).toBe(100);
	});
});
```

- [ ] **Step 2: Split editor dialog**

`src/routes/ledger/SplitEditor.svelte`:
```svelte
<script lang="ts">
	import Dialog from '$lib/ui/Dialog.svelte';
	import { decimalToCents, formatCents } from '$lib/money';
	import type { CategoryTree } from '$lib/server/read/categories';
	let { row, tree, onsave, onclose }: { row: { id: number; amount: number; splits: { categoryId: number; amount: number; memo: string | null }[] }; tree: CategoryTree; onsave: (splits: { categoryId: number; amount: number; memo: string | null }[]) => Promise<void>; onclose: () => void } = $props();
	let lines = $state(row.splits.map((s) => ({ categoryId: s.categoryId, amount: (s.amount / 100).toFixed(2), memo: s.memo ?? '' })));
	const sum = $derived(lines.reduce((s, l) => { try { return s + decimalToCents(l.amount || '0'); } catch { return s; } }, 0));
	const remaining = $derived(row.amount - sum);
</script>
<Dialog open={true} title="Split transaction" {onclose}>
	<table><thead><tr><th>Category</th><th class="num">Amount</th><th>Memo</th><th></th></tr></thead><tbody>
	{#each lines as l, i}
		<tr><td><select bind:value={l.categoryId}>{#each tree.groups as g}<optgroup label={g.name}>{#each g.categories.filter((c) => !c.hidden) as c}<option value={c.id}>{c.name}</option>{/each}</optgroup>{/each}</select></td>
		<td><input class="num" bind:value={l.amount} /></td><td><input bind:value={l.memo} /></td>
		<td><button type="button" onclick={() => lines.splice(i, 1)} disabled={lines.length === 1}>×</button></td></tr>
	{/each}
	</tbody></table>
	<p class="small">Total {formatCents(row.amount)} · remaining <span class:error={remaining !== 0}>{formatCents(remaining)}</span></p>
	<div class="actions">
		<button type="button" onclick={() => lines.push({ categoryId: lines[0].categoryId, amount: (remaining / 100).toFixed(2), memo: '' })}>Add line</button>
		<button type="button" onclick={onclose}>Cancel</button>
		<button class="primary" disabled={remaining !== 0} onclick={() => onsave(lines.map((l) => ({ categoryId: l.categoryId, amount: decimalToCents(l.amount), memo: l.memo || null })))}>Save</button>
	</div>
</Dialog>
```
`CategoryTree` is imported as a type only, so the server module is not bundled into the client.

- [ ] **Step 3: Page**

`src/routes/ledger/+page.svelte`:
```svelte
<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import Money from '$lib/ui/Money.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import SplitEditor from './SplitEditor.svelte';
	import { post } from '$lib/ui/api';
	import { decimalToCents } from '$lib/money';
	let { data } = $props();
	const v = $derived(data.view); const tree = $derived(data.tree);
	let error = $state('');
	let splitting = $state<(typeof v.rows)[number] | null>(null);
	let ruleFor = $state<{ id: number; payeeRaw: string; payee: string; pattern: string; categoryId: number | null } | null>(null);
	let adding = $state(false); let add = $state({ accountId: 0, postedDate: '', amount: '', payee: '', memo: '', categoryId: null as number | null });
	const run = async (fn: () => Promise<unknown>) => { error = ''; try { await fn(); await invalidateAll(); } catch (e) { error = (e as Error).message; } };
	const patch = (id: number, body: unknown) => run(() => post(`/api/transactions/${id}`, body));
	function setParam(k: string, val: string | null) { const u = new URL(page.url); if (val) u.searchParams.set(k, val); else u.searchParams.delete(k); u.searchParams.delete('page'); goto(u.pathname + u.search); }
	async function renamePayee(row: (typeof v.rows)[number], payee: string) {
		if (payee === row.payee) return;
		await patch(row.id, { payee });
		ruleFor = { id: row.id, payeeRaw: row.payeeRaw, payee, pattern: row.payeeRaw, categoryId: row.splits.length === 1 ? row.splits[0].categoryId : null };
	}
	const catName = (id: number) => tree.groups.flatMap((g) => g.categories).find((c) => c.id === id)?.name ?? '';
	const manualAccounts = $derived(v.accounts.filter((a) => !a.closed));
	const pages = $derived(Math.max(1, Math.ceil(v.total / v.limit)));
</script>

<h1>Ledger</h1>
<div class="toolbar">
	<select value={data.filter.accountId ?? ''} onchange={(e) => setParam('account', (e.target as HTMLSelectElement).value || null)}><option value="">All accounts</option>{#each v.accounts as a}<option value={a.id}>{a.name}{a.closed ? ' (closed)' : ''}</option>{/each}</select>
	<select value={data.filter.periodId ?? ''} onchange={(e) => setParam('period', (e.target as HTMLSelectElement).value || null)}><option value="">All periods</option>{#each v.periods as p}<option value={p.id}>{p.label}</option>{/each}</select>
	<select value={data.filter.categoryId ?? ''} onchange={(e) => setParam('category', (e.target as HTMLSelectElement).value || null)}><option value="">All categories</option>{#each tree.groups as g}<optgroup label={g.name}>{#each g.categories as c}<option value={c.id}>{c.name}</option>{/each}</optgroup>{/each}</select>
	<input placeholder="Search payee or memo" value={data.filter.q ?? ''} onchange={(e) => setParam('q', (e.target as HTMLInputElement).value || null)} />
	<label class="small"><input type="checkbox" checked={data.filter.review} onchange={(e) => setParam('review', (e.target as HTMLInputElement).checked ? '1' : null)} /> review queue</label>
	<button onclick={() => (adding = !adding)}>+ Manual transaction</button>
	<span class="muted small">{v.total} rows</span>
</div>
{#if error}<p class="error">{error}</p>{/if}
{#if v.drift.length}<div class="strip">{#each v.drift as d}<span>Drift on {d.accountName}: <Money cents={d.drift} signed /> — <a href="/accounts#account-{d.accountId}">reconcile</a></span>{/each}</div>{/if}

{#if adding}
<form class="card" onsubmit={(e) => { e.preventDefault(); run(() => post('/api/transactions', { accountId: add.accountId, postedDate: add.postedDate, amount: decimalToCents(add.amount), payee: add.payee, memo: add.memo || null, categoryId: add.categoryId })).then(() => { adding = false; }); }}>
	<div class="toolbar">
		<select bind:value={add.accountId} required><option value={0}>Account…</option>{#each manualAccounts as a}<option value={a.id}>{a.name}</option>{/each}</select>
		<input type="date" bind:value={add.postedDate} required /><input class="num" placeholder="-12.34" bind:value={add.amount} required /><input placeholder="Payee" bind:value={add.payee} required />
		<select bind:value={add.categoryId}><option value={null}>Uncategorized</option>{#each tree.groups as g}<optgroup label={g.name}>{#each g.categories.filter((c) => !c.hidden) as c}<option value={c.id}>{c.name}</option>{/each}</optgroup>{/each}</select>
		<input placeholder="Memo" bind:value={add.memo} /><button class="primary" type="submit">Add</button>
	</div>
	<p class="small muted">Amounts are from the account's point of view: spending is negative, deposits positive.</p>
</form>
{/if}

<table>
	<thead><tr><th>Date</th><th>Account</th><th>Payee</th><th>Category</th><th>Memo</th><th class="num">Amount</th><th>Period</th><th></th></tr></thead>
	<tbody>
	{#each v.rows as row (row.id)}
		<tr>
			<td>{row.postedDate}{#if row.pending} <span class="muted small">pending</span>{/if}</td>
			<td>{row.accountName}</td>
			<td><input class="inline" value={row.payee} title={row.payeeRaw} onchange={(e) => renamePayee(row, (e.target as HTMLInputElement).value)} /></td>
			<td>{#if row.transferPeerId != null}<span class="muted">Transfer · {row.transferPeerAccountName}</span> <button class="small" onclick={() => run(() => post(`/api/transactions/${row.id}/unlink`))}>unlink</button>
				{:else if row.splits.length === 1}<select value={row.splits[0].categoryId} onchange={(e) => patch(row.id, { splits: [{ categoryId: Number((e.target as HTMLSelectElement).value), amount: row.amount }] })}>{#each tree.groups as g}<optgroup label={g.name}>{#each g.categories.filter((c) => !c.hidden || c.id === row.splits[0].categoryId) as c}<option value={c.id}>{c.name}</option>{/each}</optgroup>{/each}</select> <button class="small" onclick={() => (splitting = row)}>split</button>
				{:else}<button class="small" onclick={() => (splitting = row)}>{row.splits.length} splits: {row.splits.map((s) => s.categoryName).join(', ')}</button>{/if}</td>
			<td><input class="inline" value={row.memo ?? ''} onchange={(e) => patch(row.id, { memo: (e.target as HTMLInputElement).value || null })} /></td>
			<td class="num"><Money cents={row.amount} /></td>
			<td><select value={row.periodId} onchange={(e) => patch(row.id, { periodId: Number((e.target as HTMLSelectElement).value) })}>{#each v.periods as p}<option value={p.id}>{p.label}</option>{/each}</select></td>
			<td>{#if row.needsReview}<span class="status overdue" title={row.reviewReason ?? ''}>{row.reviewReason}</span> <button class="small" onclick={() => run(() => post(`/api/transactions/${row.id}/review`))}>clear</button>{/if}
				{#if row.source === 'manual' || row.source === 'import'}<button class="small danger" onclick={() => run(() => post(`/api/transactions/${row.id}/delete`))}>delete</button>{/if}</td>
		</tr>
	{:else}<tr><td colspan="8" class="muted">No transactions match.</td></tr>{/each}
	</tbody>
</table>
<div class="toolbar">
	{#if data.page > 1}<a href={(() => { const u = new URL(page.url); u.searchParams.set('page', String(data.page - 1)); return u.pathname + u.search; })()}>← newer</a>{/if}
	<span class="muted small">page {data.page} of {pages}</span>
	{#if data.page < pages}<a href={(() => { const u = new URL(page.url); u.searchParams.set('page', String(data.page + 1)); return u.pathname + u.search; })()}>older →</a>{/if}
</div>

{#if splitting}<SplitEditor row={splitting} {tree} onclose={() => (splitting = null)} onsave={async (splits) => { const id = splitting!.id; splitting = null; await patch(id, { splits }); }} />{/if}

{#if ruleFor}
<Dialog open={true} title="Create a payee rule?" onclose={() => (ruleFor = null)}>
	<p class="small">Rename every transaction whose raw payee contains the pattern to <strong>{ruleFor.payee}</strong>{#if ruleFor.categoryId} and categorise it as {catName(ruleFor.categoryId)}{/if}.</p>
	<form class="grid" onsubmit={(e) => { e.preventDefault(); const r = ruleFor!; ruleFor = null; run(() => post('/api/payee-rules', { pattern: r.pattern, payee: r.payee, categoryId: r.categoryId, applyToExisting: true })); }}>
		<label for="rule-pattern">Pattern</label><input id="rule-pattern" bind:value={ruleFor.pattern} />
		<div class="actions" style="grid-column: 1 / -1"><button type="button" onclick={() => (ruleFor = null)}>No thanks</button><button class="primary" type="submit">Create rule</button></div>
	</form>
</Dialog>
{/if}
```
(The dialog's pattern default is the raw payee; users shorten it. `matchPayeeRule` treats non-regex patterns as case-insensitive substring matches, `payees.ts:27`.)

- [ ] **Step 4: Verify** — `npx vitest run`, `npm run check` 0 errors, `npm run build` succeeds, dev smoke `curl -s 'localhost:5173/ledger?review=1' | grep -c 'review queue'` → `1`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/ledger
git commit -m "feat: ledger page with inline edits, splits, transfers, review queue, and payee rules"
```

---

### Task 8: Spending read model — ranges, compare, by category, by merchant, over time

**Files:**
- Create: `src/lib/server/read/spending.ts`, `src/lib/server/read/spending.test.ts`

**Interfaces:**
- Consumes: `periodBoundsFor`, `periods` table, `categories`, `transactionSplits`, `transactions`.
- Produces:
```ts
export type RangeKind = 'period' | 'month' | 'quarter' | 'year' | 'custom';
export type Range = { kind: RangeKind; start: string; end: string; label: string; prevStart: string; prevEnd: string; prevLabel: string };
export function resolveRange(db: DbOrTx, q: { kind: RangeKind; anchor: string; end?: string | null; cadence: Cadence }): Range
export const EXCLUDED_KINDS: readonly CategoryKind[] = ['bill', 'debt_payment', 'transfer', 'income', 'reconciliation'];
export type SpendingFilter = { accountId?: number | null; groupId?: number | null; merchant?: string | null; includeExcluded?: boolean; compare?: boolean };
export type SpendingView = {
	range: Range; filter: SpendingFilter; total: number; prevTotal: number | null;
	byCategory: { categoryId: number; name: string; groupName: string; amount: number; share: number; prevAmount: number | null }[];   // amount desc
	byMerchant: { payee: string; count: number; total: number; prevTotal: number | null }[];                                        // top 25 by total desc
	overTime: { buckets: { key: string; label: string; start: string; end: string; total: number; prevTotal: number | null; byCategory: Record<string, number> }[]; categories: { id: number; name: string }[] };
	accounts: { id: number; name: string }[]; groups: { id: number; name: string }[];
};
export function spendingView(db: DbOrTx, q: { range: Range; filter: SpendingFilter }): SpendingView
```
Rules:
- `resolveRange`: `period` → the period row containing `anchor` (`periodBoundsFor`), previous = the period before it; `month` → calendar month of `anchor`, previous = prior month; `quarter` → calendar quarter, previous = prior quarter; `year` → calendar year, previous = prior year; `custom` → `[anchor, end]`, previous = the same number of days immediately before `anchor`. Labels: period label as `periodBoundsFor`; `September 2026`; `Q3 2026`; `2026`; `2026-08-01 – 2026-08-31`.
- Amounts are spending-positive: `amount = −Σ split.amount` over live rows (`deleted_at IS NULL`) with `posted_date` in range. Only splits whose category kind is not in `EXCLUDED_KINDS` unless `includeExcluded`. Transfer-linked rows are excluded regardless (their splits are kind `transfer` anyway). Filters: `accountId` on `transactions.account_id`; `groupId` on `categories.group_id`; `merchant` exact match on `transactions.payee`.
- `share = amount / total` (0 when total is 0), rounded to 4 decimals. `prevAmount`/`prevTotal` are computed over the previous range with the same filters when `compare`, else `null`.
- `overTime` buckets: by budget period when the range is ≤ 92 days, else by calendar month; buckets cover the range in order; `byCategory` keyed by category id as a string with only the top 8 categories of the whole range, the rest summed under key `"other"` (`categories` lists those 8 plus `{ id: 0, name: 'Other' }` when used). `prevTotal` per bucket is the matching bucket of the previous range by ordinal (null when compare is off or the previous range has fewer buckets).

- [ ] **Step 1: Failing tests**

`src/lib/server/read/spending.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { createTransaction, linkTransfer } from '../ledger/transactions';
import { createCategory } from '../ledger/categories';
import { resolveRange, spendingView } from './spending';

describe('resolveRange', () => {
	it('resolves each kind with its previous range', () => {
		const f = fixture();
		expect(resolveRange(f.db, { kind: 'period', anchor: '2026-09-08', cadence: 'semi_monthly' })).toMatchObject({ start: '2026-09-01', end: '2026-09-15', prevStart: '2026-08-16', prevEnd: '2026-08-31', label: 'Sep 1–15, 2026' });
		expect(resolveRange(f.db, { kind: 'month', anchor: '2026-09-08', cadence: 'semi_monthly' })).toMatchObject({ start: '2026-09-01', end: '2026-09-30', prevStart: '2026-08-01', prevEnd: '2026-08-31', label: 'September 2026' });
		expect(resolveRange(f.db, { kind: 'quarter', anchor: '2026-09-08', cadence: 'semi_monthly' })).toMatchObject({ start: '2026-07-01', end: '2026-09-30', prevStart: '2026-04-01', prevEnd: '2026-06-30', label: 'Q3 2026' });
		expect(resolveRange(f.db, { kind: 'year', anchor: '2026-09-08', cadence: 'semi_monthly' })).toMatchObject({ start: '2026-01-01', end: '2026-12-31', prevStart: '2025-01-01', prevEnd: '2025-12-31', label: '2026' });
		expect(resolveRange(f.db, { kind: 'custom', anchor: '2026-09-01', end: '2026-09-10', cadence: 'semi_monthly' })).toMatchObject({ start: '2026-09-01', end: '2026-09-10', prevStart: '2026-08-22', prevEnd: '2026-08-31' });
	});
});

describe('spendingView', () => {
	it('groups by category and merchant, excludes bill-like kinds and transfers, and compares', () => {
		const f = fixture();
		const dining = createCategory(f.db, { groupId: f.groups.spending, name: 'Dining', kind: 'spending' });
		const add = (date: string, amount: number, payee: string, cat: number, account = f.card) =>
			createTransaction(f.db, { accountId: account, externalId: `${date}-${payee}-${amount}`, postedDate: date, amount, payeeRaw: payee, payee, source: 'sync', splits: [{ categoryId: cat, amount }] });
		add('2026-09-02', -4000, 'Whole Foods', f.groceries); add('2026-09-05', -6000, 'Whole Foods', f.groceries); add('2026-09-06', -2500, 'Cafe', dining);
		add('2026-09-03', -227445, 'Landlord', f.rent, f.checking);                       // bill kind → excluded by default
		add('2026-08-20', -3000, 'Whole Foods', f.groceries);                              // previous period
		const a = add('2026-09-04', -50000, 'PAYMENT', f.uncategorized, f.checking); const b = add('2026-09-04', 50000, 'PAYMENT', f.uncategorized); linkTransfer(f.db, a, b);
		const range = resolveRange(f.db, { kind: 'period', anchor: '2026-09-08', cadence: 'semi_monthly' });
		const v = spendingView(f.db, { range, filter: { compare: true } });
		expect(v.total).toBe(12500); expect(v.prevTotal).toBe(3000);
		expect(v.byCategory.map((c) => [c.name, c.amount, c.share, c.prevAmount])).toEqual([['Groceries', 10000, 0.8, 3000], ['Dining', 2500, 0.2, 0]]);
		expect(v.byMerchant[0]).toEqual({ payee: 'Whole Foods', count: 2, total: 10000, prevTotal: 3000 });
		expect(v.overTime.buckets).toHaveLength(1); expect(v.overTime.buckets[0]).toMatchObject({ total: 12500, prevTotal: 3000, byCategory: { [String(f.groceries)]: 10000, [String(dining)]: 2500 } });
		expect(spendingView(f.db, { range, filter: { includeExcluded: true } }).total).toBe(12500 + 227445);
		expect(spendingView(f.db, { range, filter: { accountId: f.checking } }).total).toBe(0);
		expect(spendingView(f.db, { range, filter: { merchant: 'Cafe' } }).byCategory.map((c) => c.name)).toEqual(['Dining']);
		const year = resolveRange(f.db, { kind: 'year', anchor: '2026-09-08', cadence: 'semi_monthly' });
		expect(spendingView(f.db, { range: year, filter: {} }).overTime.buckets.map((b) => b.key)).toEqual(['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08','2026-09','2026-10','2026-11','2026-12']);
	});
});
```

- [ ] **Step 2: Run to verify they fail**, then implement `spending.ts`

```ts
import { and, asc, eq, gte, inArray, isNull, lte, notInArray, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, categories, categoryGroups, periods, transactions, transactionSplits, type CategoryKind } from '../db/schema';
import { periodBoundsFor, nextPeriodStart, type Cadence } from '../budget/periods';
import { addDays, endOfMonth, startOfMonth, compareIso } from '$lib/dates';

export const EXCLUDED_KINDS: readonly CategoryKind[] = ['bill', 'debt_payment', 'transfer', 'income', 'reconciliation'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export function resolveRange(db: DbOrTx, q: { kind: RangeKind; anchor: string; end?: string | null; cadence: Cadence }): Range {
	const y = +q.anchor.slice(0, 4), m = +q.anchor.slice(5, 7);
	const monthLabel = (iso: string) => `${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
	switch (q.kind) {
		case 'period': {
			const cur = periodBoundsFor(q.cadence, q.anchor); const prev = periodBoundsFor(q.cadence, addDays(cur.startDate, -1));
			return { kind: 'period', start: cur.startDate, end: cur.endDate, label: cur.label, prevStart: prev.startDate, prevEnd: prev.endDate, prevLabel: prev.label };
		}
		case 'month': {
			const start = startOfMonth(q.anchor), prevStart = startOfMonth(addDays(start, -1));
			return { kind: 'month', start, end: endOfMonth(start), label: monthLabel(start), prevStart, prevEnd: endOfMonth(prevStart), prevLabel: monthLabel(prevStart) };
		}
		case 'quarter': {
			const qn = Math.floor((m - 1) / 3); const start = `${y}-${String(qn * 3 + 1).padStart(2, '0')}-01`; const end = endOfMonth(`${y}-${String(qn * 3 + 3).padStart(2, '0')}-01`);
			const prevStart = startOfMonth(addDays(start, -1)); const ps = startOfMonth(addDays(prevStart, -40)); // two months earlier
			const pStart = startOfMonth(addDays(ps, 0)); const prevQ = Math.floor((+pStart.slice(5, 7) - 1) / 3), py = +pStart.slice(0, 4);
			const pqStart = `${py}-${String(prevQ * 3 + 1).padStart(2, '0')}-01`, pqEnd = endOfMonth(`${py}-${String(prevQ * 3 + 3).padStart(2, '0')}-01`);
			return { kind: 'quarter', start, end, label: `Q${qn + 1} ${y}`, prevStart: pqStart, prevEnd: pqEnd, prevLabel: `Q${prevQ + 1} ${py}` };
		}
		case 'year':
			return { kind: 'year', start: `${y}-01-01`, end: `${y}-12-31`, label: String(y), prevStart: `${y - 1}-01-01`, prevEnd: `${y - 1}-12-31`, prevLabel: String(y - 1) };
		case 'custom': {
			const end = q.end && compareIso(q.end, q.anchor) >= 0 ? q.end : q.anchor; const len = daysBetween(q.anchor, end) + 1;
			const prevEnd = addDays(q.anchor, -1), prevStart = addDays(prevEnd, -(len - 1));
			return { kind: 'custom', start: q.anchor, end, label: `${q.anchor} – ${end}`, prevStart, prevEnd, prevLabel: `${prevStart} – ${prevEnd}` };
		}
	}
}
```
Simplify the quarter's previous-range arithmetic: `prevQuarterStart = addMonths(start, -3)` where `addMonths(iso, n)` builds the date with `Date.UTC(y, m - 1 + n, 1)`; write that helper instead of the `-40 days` trick above (the trick is shown only to make the intent clear; do not ship it).

```ts
type SplitRow = { accountId: number; postedDate: string; payee: string; categoryId: number; categoryName: string; groupId: number; groupName: string; amount: number };

function splitRows(db: DbOrTx, start: string, end: string, f: SpendingFilter): SplitRow[] {
	const conds: SQL[] = [isNull(transactions.deletedAt), isNull(transactions.transferPeerId), gte(transactions.postedDate, start), lte(transactions.postedDate, end)];
	if (!f.includeExcluded) conds.push(notInArray(categories.kind, [...EXCLUDED_KINDS]));
	if (f.accountId != null) conds.push(eq(transactions.accountId, f.accountId));
	if (f.groupId != null) conds.push(eq(categories.groupId, f.groupId));
	if (f.merchant) conds.push(eq(transactions.payee, f.merchant));
	return db.select({ accountId: transactions.accountId, postedDate: transactions.postedDate, payee: transactions.payee, categoryId: categories.id, categoryName: categories.name, groupId: categoryGroups.id, groupName: categoryGroups.name, amount: transactionSplits.amount })
		.from(transactionSplits).innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
		.innerJoin(categories, eq(transactionSplits.categoryId, categories.id)).innerJoin(categoryGroups, eq(categories.groupId, categoryGroups.id))
		.where(and(...conds)).all();
}

function buckets(db: DbOrTx, range: { start: string; end: string }, cadence: Cadence): { key: string; label: string; start: string; end: string }[] {
	const out = [];
	if (daysBetween(range.start, range.end) <= 92) {
		let cur = periodBoundsFor(cadence, range.start);
		while (compareIso(cur.startDate, range.end) <= 0) { out.push({ key: cur.startDate, label: cur.label, start: cur.startDate, end: cur.endDate }); cur = periodBoundsFor(cadence, nextPeriodStart(cadence, cur.endDate)); }
	} else {
		let cur = startOfMonth(range.start);
		while (compareIso(cur, range.end) <= 0) { out.push({ key: cur.slice(0, 7), label: `${MONTHS[+cur.slice(5, 7) - 1].slice(0, 3)} ${cur.slice(0, 4)}`, start: cur, end: endOfMonth(cur) }); cur = addDays(endOfMonth(cur), 1); }
	}
	return out;
}

export function spendingView(db: DbOrTx, q: { range: Range; filter: SpendingFilter; cadence: Cadence }): SpendingView {
	const cur = splitRows(db, q.range.start, q.range.end, q.filter);
	const prev = q.filter.compare ? splitRows(db, q.range.prevStart, q.range.prevEnd, q.filter) : null;
	const sumBy = <K>(rows: SplitRow[], key: (r: SplitRow) => K) => { const m = new Map<K, number>(); for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) - r.amount); return m; };
	const total = cur.reduce((s, r) => s - r.amount, 0); const prevTotal = prev ? prev.reduce((s, r) => s - r.amount, 0) : null;
	const byCat = sumBy(cur, (r) => r.categoryId), prevByCat = prev ? sumBy(prev, (r) => r.categoryId) : null;
	const catMeta = new Map(cur.map((r) => [r.categoryId, { name: r.categoryName, groupName: r.groupName }]));
	const byCategory = [...byCat].map(([id, amount]) => ({ categoryId: id, name: catMeta.get(id)!.name, groupName: catMeta.get(id)!.groupName, amount, share: total ? Math.round((amount / total) * 10000) / 10000 : 0, prevAmount: prevByCat ? prevByCat.get(id) ?? 0 : null })).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
	const merch = new Map<string, { count: number; total: number }>(); for (const r of cur) { const m = merch.get(r.payee) ?? { count: 0, total: 0 }; m.count++; m.total -= r.amount; merch.set(r.payee, m); }
	const prevMerch = prev ? sumBy(prev, (r) => r.payee) : null;
	const byMerchant = [...merch].map(([payee, m]) => ({ payee, ...m, prevTotal: prevMerch ? prevMerch.get(payee) ?? 0 : null })).sort((a, b) => b.total - a.total || a.payee.localeCompare(b.payee)).slice(0, 25);
	const top = byCategory.slice(0, 8).map((c) => c.categoryId); const topSet = new Set(top);
	const bs = buckets(db, q.range, q.cadence); const pbs = prev ? buckets(db, { start: q.range.prevStart, end: q.range.prevEnd }, q.cadence) : [];
	const inB = (b: { start: string; end: string }, d: string) => compareIso(d, b.start) >= 0 && compareIso(d, b.end) <= 0;
	const overTime = bs.map((b, i) => {
		const rows = cur.filter((r) => inB(b, r.postedDate)); const byC: Record<string, number> = {};
		for (const r of rows) { const k = topSet.has(r.categoryId) ? String(r.categoryId) : 'other'; byC[k] = (byC[k] ?? 0) - r.amount; }
		const pb = pbs[i]; const prevT = prev && pb ? prev.filter((r) => inB(pb, r.postedDate)).reduce((s, r) => s - r.amount, 0) : null;
		return { ...b, total: rows.reduce((s, r) => s - r.amount, 0), prevTotal: prevT, byCategory: byC };
	});
	const otherUsed = overTime.some((b) => 'other' in b.byCategory);
	return {
		range: q.range, filter: q.filter, total, prevTotal, byCategory, byMerchant,
		overTime: { buckets: overTime, categories: [...top.map((id) => ({ id, name: catMeta.get(id)!.name })), ...(otherUsed ? [{ id: 0, name: 'Other' }] : [])] },
		accounts: db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(isNull(accounts.closedAt)).orderBy(asc(accounts.name)).all(),
		groups: db.select({ id: categoryGroups.id, name: categoryGroups.name }).from(categoryGroups).orderBy(asc(categoryGroups.sort)).all()
	};
}
```
The signature takes `cadence` (the Interfaces block omits it; add `cadence: Cadence` to `spendingView`'s argument and pass `'semi_monthly'` in the test). Do not fetch every split twice for `prev` when `compare` is off.

- [ ] **Step 3: Run to verify they pass**; `npm run check` 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/server/read/spending.ts src/lib/server/read/spending.test.ts
git commit -m "feat: spending read model with ranges, comparison, category, merchant, and time buckets"
```

---

### Task 9: Spending page — range picker, filters, three views, stacked bars

**Files:**
- Create: `src/routes/spending/+page.server.ts`, `src/routes/spending/+page.svelte`, `src/routes/spending/spending.test.ts`, `src/lib/ui/RangePicker.svelte`, `src/lib/ui/StackedBars.svelte`

**Interfaces:**
- Consumes: `resolveRange`, `spendingView`, `EXCLUDED_KINDS`.
- URL params: `kind` (period|month|quarter|year|custom, default `period`), `anchor` (YYYY-MM-DD, default today), `end` (custom only), `compare=1`, `account`, `group`, `merchant`, `all=1` (include excluded kinds).

- [ ] **Step 1: Load + test**

`src/routes/spending/+page.server.ts`:
```ts
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { resolveRange, spendingView, type RangeKind } from '$lib/server/read/spending';
import { todayIso } from '$lib/dates';
const KINDS: RangeKind[] = ['period', 'month', 'quarter', 'year', 'custom'];
const int = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : null);
const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
export const load: PageServerLoad = ({ url }) => {
	const config = getConfig(); const p = url.searchParams; const today = todayIso(config.timeZone);
	const kind = (KINDS as string[]).includes(p.get('kind') ?? '') ? (p.get('kind') as RangeKind) : 'period';
	const range = resolveRange(getDb(), { kind, anchor: date(p.get('anchor')) ?? today, end: date(p.get('end')), cadence: config.cadence });
	const filter = { accountId: int(p.get('account')), groupId: int(p.get('group')), merchant: p.get('merchant') || null, includeExcluded: p.get('all') === '1', compare: p.get('compare') === '1' };
	return { view: spendingView(getDb(), { range, filter, cadence: config.cadence }), today };
};
```
`src/routes/spending/spending.test.ts` (harness):
```ts
import { load } from './+page.server';
describe('spending page load', () => {
	it('defaults to the current period and parses the range and filters', async () => {
		const d = (await load({ url: new URL('http://localhost/spending?kind=month&anchor=2026-07-10&compare=1&all=1') } as never)) as { view: { range: { kind: string; start: string }; filter: { compare: boolean; includeExcluded: boolean } } };
		expect(d.view.range).toMatchObject({ kind: 'month', start: '2026-07-01' }); expect(d.view.filter).toMatchObject({ compare: true, includeExcluded: true });
		const e = (await load({ url: new URL('http://localhost/spending') } as never)) as { view: { range: { kind: string } } };
		expect(e.view.range.kind).toBe('period');
	});
});
```

- [ ] **Step 2: RangePicker and StackedBars**

`src/lib/ui/RangePicker.svelte`:
```svelte
<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { addDays } from '$lib/dates';
	let { range, compare }: { range: { kind: string; start: string; end: string; label: string; prevLabel: string }; compare: boolean } = $props();
	function nav(changes: Record<string, string | null>) {
		const u = new URL(page.url); for (const [k, v] of Object.entries(changes)) { if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); } goto(u.pathname + u.search);
	}
	// Step by the range's own length: anchor moves to the day after `end` (forward) or the day before `start` (back).
	const forward = () => nav({ anchor: addDays(range.end, 1), end: range.kind === 'custom' ? addDays(range.end, 1 + (Date.parse(range.end) - Date.parse(range.start)) / 86400000) : null });
	const back = () => { const len = (Date.parse(range.end) - Date.parse(range.start)) / 86400000; nav({ anchor: addDays(range.start, -(len + 1)), end: range.kind === 'custom' ? addDays(range.start, -1) : null }); };
</script>
<div class="toolbar">
	<select value={range.kind} onchange={(e) => nav({ kind: (e.target as HTMLSelectElement).value, anchor: range.start, end: (e.target as HTMLSelectElement).value === 'custom' ? range.end : null })}>
		{#each ['period', 'month', 'quarter', 'year', 'custom'] as k}<option value={k}>{k}</option>{/each}
	</select>
	<button onclick={back}>←</button><strong>{range.label}</strong><button onclick={forward}>→</button>
	{#if range.kind === 'custom'}<input type="date" value={range.start} onchange={(e) => nav({ anchor: (e.target as HTMLInputElement).value })} /><input type="date" value={range.end} onchange={(e) => nav({ end: (e.target as HTMLInputElement).value })} />{/if}
	<label class="small"><input type="checkbox" checked={compare} onchange={(e) => nav({ compare: (e.target as HTMLInputElement).checked ? '1' : null })} /> compare to {range.prevLabel}</label>
</div>
```
`addDays` lives in `$lib/dates`, which has no server imports; confirm the file stays client-safe.

`src/lib/ui/StackedBars.svelte`:
```svelte
<script lang="ts">
	import { formatCents } from '$lib/money';
	let { buckets, categories, compare }: { buckets: { key: string; label: string; total: number; prevTotal: number | null; byCategory: Record<string, number> }[]; categories: { id: number; name: string }[]; compare: boolean } = $props();
	const PALETTE = ['#2f6f4e', '#d98c2b', '#4a6fb5', '#b5484a', '#7a5ab5', '#3c9d9b', '#a0a028', '#8a6d4b', '#9a9a9a'];
	const W = 720, H = 260, PAD = 36, BW = $derived(Math.max(8, (W - PAD * 2) / Math.max(buckets.length, 1) - 8));
	const max = $derived(Math.max(1, ...buckets.map((b) => Math.max(b.total, b.prevTotal ?? 0))));
	const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
	const x = (i: number) => PAD + i * ((W - PAD * 2) / Math.max(buckets.length, 1)) + 4;
	const keyOf = (c: { id: number }) => (c.id === 0 ? 'other' : String(c.id));
	const linePath = $derived(buckets.map((b, i) => `${i ? 'L' : 'M'}${x(i) + BW / 2},${y(b.total)}`).join(' '));
	const prevPath = $derived(buckets.every((b) => b.prevTotal != null) ? buckets.map((b, i) => `${i ? 'L' : 'M'}${x(i) + BW / 2},${y(b.prevTotal!)}`).join(' ') : '');
</script>
<svg class="chart" viewBox="0 0 {W} {H}">
	{#each buckets as b, i}
		{@const segs = categories.map((c) => ({ c, v: b.byCategory[keyOf(c)] ?? 0 }))}
		{#each segs as s, j}
			{@const prior = segs.slice(0, j).reduce((a, q) => a + q.v, 0)}
			<rect x={x(i)} y={y(prior + s.v)} width={BW} height={y(prior) - y(prior + s.v)} fill={PALETTE[j % PALETTE.length]}><title>{b.label} · {s.c.name}: {formatCents(s.v)}</title></rect>
		{/each}
		<text x={x(i) + BW / 2} y={H - PAD + 14} text-anchor="middle" font-size="10" fill="var(--muted)">{b.label}</text>
	{/each}
	{#if compare && prevPath}<path d={prevPath} fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 3" opacity=".6" />{/if}
	<path d={linePath} fill="none" stroke="var(--fg)" stroke-width="1.5" />
	<text x={PAD} y={PAD - 8} font-size="10" fill="var(--muted)">{formatCents(max)}</text>
</svg>
<div class="legend">{#each categories as c, j}<span><i style="background:{PALETTE[j % PALETTE.length]}"></i>{c.name}</span>{/each}{#if compare}<span><i style="background:var(--muted);opacity:.6"></i>previous range</span>{/if}</div>
```

- [ ] **Step 3: Page**

`src/routes/spending/+page.svelte`:
```svelte
<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Money from '$lib/ui/Money.svelte';
	import RangePicker from '$lib/ui/RangePicker.svelte';
	import StackedBars from '$lib/ui/StackedBars.svelte';
	let { data } = $props();
	const v = $derived(data.view);
	function setParam(k: string, val: string | null) { const u = new URL(page.url); if (val) u.searchParams.set(k, val); else u.searchParams.delete(k); goto(u.pathname + u.search); }
	const delta = (cur: number, prev: number | null) => (prev == null ? '' : prev === 0 ? (cur === 0 ? '' : 'new') : `${cur >= prev ? '+' : ''}${Math.round(((cur - prev) / prev) * 100)}%`);
	const ledgerLink = (categoryId: number) => `/ledger?category=${categoryId}&from=${v.range.start}&to=${v.range.end}${v.filter.accountId ? `&account=${v.filter.accountId}` : ''}`;
</script>

<h1>Spending</h1>
<RangePicker range={v.range} compare={v.filter.compare ?? false} />
<div class="toolbar">
	<select value={v.filter.accountId ?? ''} onchange={(e) => setParam('account', (e.target as HTMLSelectElement).value || null)}><option value="">All accounts</option>{#each v.accounts as a}<option value={a.id}>{a.name}</option>{/each}</select>
	<select value={v.filter.groupId ?? ''} onchange={(e) => setParam('group', (e.target as HTMLSelectElement).value || null)}><option value="">All groups</option>{#each v.groups as g}<option value={g.id}>{g.name}</option>{/each}</select>
	{#if v.filter.merchant}<span class="status">merchant: {v.filter.merchant} <button class="small" onclick={() => setParam('merchant', null)}>×</button></span>{/if}
	<label class="small"><input type="checkbox" checked={v.filter.includeExcluded} onchange={(e) => setParam('all', (e.target as HTMLInputElement).checked ? '1' : null)} /> include bills, debt payments, transfers, income</label>
</div>
<div class="cards"><div class="card"><div class="label">Total spending · {v.range.label}</div><div class="value"><Money cents={v.total} /></div>{#if v.prevTotal != null}<div class="small muted">{v.range.prevLabel}: <Money cents={v.prevTotal} /> ({delta(v.total, v.prevTotal)})</div>{/if}</div></div>

<h2>Over time</h2>
<StackedBars buckets={v.overTime.buckets} categories={v.overTime.categories} compare={v.filter.compare ?? false} />

<h2>By category</h2>
<table><thead><tr><th>Category</th><th>Group</th><th class="num">Amount</th><th class="num">Share</th>{#if v.prevTotal != null}<th class="num">Previous</th><th class="num">Δ</th>{/if}<th></th></tr></thead>
<tbody>{#each v.byCategory as c}<tr><td>{c.name}</td><td class="muted">{c.groupName}</td><td class="num"><Money cents={c.amount} /></td><td class="num">{(c.share * 100).toFixed(1)}%</td>
	{#if v.prevTotal != null}<td class="num"><Money cents={c.prevAmount ?? 0} /></td><td class="num">{delta(c.amount, c.prevAmount)}</td>{/if}<td><a href={ledgerLink(c.categoryId)}>transactions →</a></td></tr>{:else}<tr><td colspan="7" class="muted">No spending in this range.</td></tr>{/each}</tbody></table>

<h2>By merchant</h2>
<table><thead><tr><th>Merchant</th><th class="num">Count</th><th class="num">Total</th>{#if v.prevTotal != null}<th class="num">Previous</th>{/if}</tr></thead>
<tbody>{#each v.byMerchant as m}<tr><td><a href="?{(() => { const u = new URL(page.url); u.searchParams.set('merchant', m.payee); return u.searchParams.toString(); })()}">{m.payee}</a></td><td class="num">{m.count}</td><td class="num"><Money cents={m.total} /></td>{#if v.prevTotal != null}<td class="num"><Money cents={m.prevTotal ?? 0} /></td>{/if}</tr>{/each}</tbody></table>
```

- [ ] **Step 4: Verify** — `npx vitest run`, `npm run check` 0 errors, `npm run build`, dev smoke `curl -s 'localhost:5173/spending?kind=year' | grep -c 'By merchant'` → `1`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/spending src/lib/ui/RangePicker.svelte src/lib/ui/StackedBars.svelte
git commit -m "feat: spending page with range picker, comparison, category and merchant views, stacked bars"
```

---

### Task 10: Accounts read model and routes

**Files:**
- Create: `src/lib/server/read/accounts.ts`, `src/lib/server/read/accounts.test.ts`, `src/routes/api/accounts/[id]/+server.ts`, `src/routes/api/accounts/[id]/balance/+server.ts`, `src/routes/api/accounts/[id]/terms/+server.ts`, `src/routes/api/accounts/[id]/adjust/+server.ts`, `src/routes/api/accounts/[id]/convention/+server.ts`, `src/routes/api/accounts/[id]/import/+server.ts`, `src/routes/api/connections/+server.ts`, `src/routes/api/connections/[id]/status/+server.ts`, `src/routes/api/accounts/accounts.test.ts`

**Interfaces:**
- Consumes: `updateAccount` (Task 2), `appendBalance`, `appendTermsIfChanged`, `latestBalance`, `latestTerms`, `createAdjustment`, `driftForAccount`, `conventionFor`, `PENDING_CONVENTION_KEY`, `getSetting`/`setSetting`, `importCsv`, `processUnprocessed`, `createConnection`, `upsertAccount`, `setConnectionStatus`, `syncRuns`, `plaidClient`.
- Produces:
```ts
export type AccountsView = {
	plaidConfigured: boolean;
	connections: { id: number; provider: string; institutionName: string; status: string; lastSuccessAt: string | null; lastError: string | null;
		lastRun: { startedAt: string; finishedAt: string | null; status: string; error: string | null; added: number; modified: number; removed: number; balancesWritten: number; termsWritten: number } | null;
		accounts: { id: number; name: string; type: string; onBudget: boolean; isDebt: boolean; closedAt: string | null; mask: string | null;
			balance: { current: number; available: number | null; creditLimit: number | null; asOf: string; source: string } | null;
			drift: { providerBalance: number | null; ledgerBalance: number; drift: number | null; convention: string };
			terms: { asOf: string; source: string; aprBps: number | null; promoAprBps: number | null; minPayment: number | null; nextDueDate: string | null; lastStatementBalance: number | null; lastStatementDate: string | null; annualFee: number | null } | null }[] }[];
	types: readonly string[];
};
export function accountsView(db: DbOrTx, opts: { plaidConfigured: boolean }): AccountsView
```
`lastRun` is the newest `sync_runs` row per connection by `started_at desc, id desc`. Accounts ordered by `closed_at is null desc, id`; connections by `id`.
- Routes (JSON unless noted):
  - `POST /api/accounts/[id] { name?, type?, onBudget?, closedAt? }` → `{ ok }` (409 `ACCOUNT_HAS_PAYMENT_CATEGORY`).
  - `POST /api/accounts/[id]/balance { current, asOf, available?, creditLimit? }` → `{ id }` via `appendBalance(..., source: 'manual')`.
  - `POST /api/accounts/[id]/terms { asOf, aprBps?, promoAprBps?, minPayment?, nextDueDate?, lastStatementBalance?, lastStatementDate?, annualFee? }` → `{ inserted: true }` via `appendTermsIfChanged(..., source: 'manual')`. `aprBps` etc. are integers (basis points); the UI converts a typed `27.49` to `2749`.
  - `POST /api/accounts/[id]/adjust { amount, date }` → `{ id }` via `createAdjustment`; `amount` must equal the account's current drift (`driftForAccount`), else 409 `InvariantError('DRIFT_CHANGED')`, so a stale page cannot post an adjustment for a number that moved.
  - `POST /api/accounts/[id]/convention { convention: 'exclude_pending' | 'include_pending' }` → writes the per-account override into the `pending_convention` setting map.
  - `POST /api/accounts/[id]/import` (multipart, field `file`) → `{ created, duplicates, processed }`: `importCsv(db, id, text, { cadence, todayIso })` then `processUnprocessed(db, { todayIso, graceDays, transferWindowDays })` (read the two knobs with `getSetting`, defaults 3 and 4). 400 when no file or the header is not Apple Card's.
  - `POST /api/connections { institutionName, accounts: { name, type }[] }` → `{ connectionId, accountIds }` creates a `manual` connection with `upsertAccount(externalId: 'manual:<n>')`.
  - `POST /api/connections/[id]/status { status: 'active' | 'disabled' }` → `{ ok }` via `setConnectionStatus`.

- [ ] **Step 1: Failing read-model test**

`src/lib/server/read/accounts.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { appendBalance, appendTermsIfChanged } from '../sync/connections';
import { createTransaction } from '../ledger/transactions';
import { syncRuns } from '../db/schema';
import { accountsView } from './accounts';

describe('accountsView', () => {
	it('joins balances, drift, terms, and the last run per connection', () => {
		const f = fixture();
		appendBalance(f.db, f.card, { asOf: '2026-09-08', current: -8000, creditLimit: 500000, source: 'manual' });
		appendTermsIfChanged(f.db, f.card, { asOf: '2026-09-08', aprBps: 2749, minPayment: 3500, nextDueDate: '2026-09-25', source: 'manual' });
		createTransaction(f.db, { accountId: f.card, externalId: 'x', postedDate: '2026-09-02', amount: -5000, payeeRaw: 'X', source: 'sync' });
		f.db.insert(syncRuns).values({ connectionId: f.conn, trigger: 'manual', startedAt: '2026-09-08T01:00:00.000Z', finishedAt: '2026-09-08T01:00:02.000Z', status: 'error', error: 'boom' }).run();
		f.db.insert(syncRuns).values({ connectionId: f.conn, trigger: 'cron', startedAt: '2026-09-08T03:00:00.000Z', finishedAt: '2026-09-08T03:00:05.000Z', status: 'ok', added: 4 }).run();
		const v = accountsView(f.db, { plaidConfigured: false });
		expect(v.plaidConfigured).toBe(false);
		const c = v.connections[0]; expect(c.institutionName).toBe('Test Bank'); expect(c.lastRun).toMatchObject({ status: 'ok', added: 4 });
		const card = c.accounts.find((a) => a.id === f.card)!;
		expect(card.balance).toMatchObject({ current: -8000, creditLimit: 500000, source: 'manual' });
		expect(card.drift).toMatchObject({ providerBalance: -8000, ledgerBalance: -5000, drift: -3000, convention: 'include_pending' });
		expect(card.terms).toMatchObject({ aprBps: 2749, minPayment: 3500, nextDueDate: '2026-09-25', source: 'manual' });
		expect(c.accounts.find((a) => a.id === f.checking)!.balance).toBeNull();
		expect(v.types).toContain('credit');
	});
});
```

- [ ] **Step 2: Run to verify it fails**, then implement `accounts.ts`

```ts
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, connections, syncRuns, ACCOUNT_TYPES } from '../db/schema';
import { latestBalance, latestTerms } from '../sync/connections';
import { driftForAccount } from '../reconcile';
export type AccountsView = { /* copy */ };
export function accountsView(db: DbOrTx, opts: { plaidConfigured: boolean }): AccountsView {
	const conns = db.select().from(connections).orderBy(asc(connections.id)).all();
	const accts = db.select().from(accounts).orderBy(sql`${accounts.closedAt} is null desc`, asc(accounts.id)).all();
	return {
		plaidConfigured: opts.plaidConfigured, types: ACCOUNT_TYPES,
		connections: conns.map((c) => {
			const run = db.select().from(syncRuns).where(eq(syncRuns.connectionId, c.id)).orderBy(desc(syncRuns.startedAt), desc(syncRuns.id)).get() ?? null;
			return {
				id: c.id, provider: c.provider, institutionName: c.institutionName, status: c.status, lastSuccessAt: c.lastSuccessAt, lastError: c.lastError,
				lastRun: run && { startedAt: run.startedAt, finishedAt: run.finishedAt, status: run.status, error: run.error, added: run.added, modified: run.modified, removed: run.removed, balancesWritten: run.balancesWritten, termsWritten: run.termsWritten },
				accounts: accts.filter((a) => a.connectionId === c.id).map((a) => {
					const b = latestBalance(db, a.id); const t = latestTerms(db, a.id); const d = driftForAccount(db, a.id);
					return {
						id: a.id, name: a.name, type: a.type, onBudget: a.onBudget, isDebt: a.isDebt, closedAt: a.closedAt, mask: a.mask,
						balance: b && { current: b.current, available: b.available, creditLimit: b.creditLimit, asOf: b.asOf, source: b.source },
						drift: { providerBalance: d.providerBalance, ledgerBalance: d.ledgerBalance, drift: d.drift, convention: d.convention },
						terms: t && { asOf: t.asOf, source: t.source, aprBps: t.aprBps, promoAprBps: t.promoAprBps, minPayment: t.minPayment, nextDueDate: t.nextDueDate, lastStatementBalance: t.lastStatementBalance, lastStatementDate: t.lastStatementDate, annualFee: t.annualFee }
					};
				})
			};
		})
	};
}
```

- [ ] **Step 3: Failing route tests**

`src/routes/api/accounts/accounts.test.ts` (harness, plus):
```ts
import { getDb } from '$lib/server/db/instance';
import { accounts, accountBalances, accountTerms, transactions, connections } from '$lib/server/db/schema';
import { createTransaction } from '$lib/server/ledger/transactions';
import { driftForAccount } from '$lib/server/reconcile';
import { POST as createConn } from '../connections/+server';
import { POST as connStatus } from '../connections/[id]/status/+server';
import { POST as patchAccount } from './[id]/+server';
import { POST as balance } from './[id]/balance/+server';
import { POST as terms } from './[id]/terms/+server';
import { POST as adjust } from './[id]/adjust/+server';
import { POST as convention } from './[id]/convention/+server';
import { POST as importRoute } from './[id]/import/+server';
import { eq } from 'drizzle-orm';

const CSV = `Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By
09/01/2026,09/02/2026,APPLE.COM/BILL,Apple,Other,Purchase,10.59,J
`;
const multipart = (name: string, text: string) => { const fd = new FormData(); fd.set('file', new File([text], name, { type: 'text/csv' })); return new Request('http://localhost/x', { method: 'POST', body: fd }); };

describe('account and connection routes', () => {
	it('creates a manual connection, edits an account, appends balance and terms, adjusts drift, imports csv', async () => {
		const db = getDb();
		const { connectionId, accountIds } = await (await createConn({ request: req({ institutionName: 'Apple', accounts: [{ name: 'Apple Card', type: 'credit' }] }) } as never)).json();
		const card = accountIds[0];
		expect((await patchAccount({ request: req({ name: 'Apple Card (Titanium)', onBudget: true }), params: { id: String(card) } } as never)).status).toBe(200);
		expect(db.select().from(accounts).where(eq(accounts.id, card)).get()!.name).toBe('Apple Card (Titanium)');
		expect((await balance({ request: req({ current: -12345, asOf: '2026-09-08' }), params: { id: String(card) } } as never)).status).toBe(200);
		expect(db.select().from(accountBalances).all()).toHaveLength(1);
		expect((await terms({ request: req({ asOf: '2026-09-08', aprBps: 2649, minPayment: 2500 }), params: { id: String(card) } } as never)).status).toBe(200);
		expect(db.select().from(accountTerms).all()[0]).toMatchObject({ aprBps: 2649, source: 'manual' });
		createTransaction(db, { accountId: card, externalId: 't', postedDate: '2026-09-03', amount: -10000, payeeRaw: 'X', source: 'sync' });
		const drift = driftForAccount(db, card).drift!; expect(drift).toBe(-2345);
		expect((await adjust({ request: req({ amount: drift, date: '2026-09-08' }), params: { id: String(card) } } as never)).status).toBe(200);
		expect(driftForAccount(db, card).drift).toBe(0);
		expect((await convention({ request: req({ convention: 'exclude_pending' }), params: { id: String(card) } } as never)).status).toBe(200);
		expect(driftForAccount(db, card).convention).toBe('exclude_pending');
		const imp = await (await importRoute({ request: multipart('apple.csv', CSV), params: { id: String(card) } } as never)).json();
		expect(imp).toMatchObject({ created: 1, duplicates: 0 });
		expect(db.select().from(transactions).where(eq(transactions.source, 'import')).get()!.processedAt).not.toBeNull();
		expect((await connStatus({ request: req({ status: 'disabled' }), params: { id: String(connectionId) } } as never)).status).toBe(200);
		expect(db.select().from(connections).where(eq(connections.id, connectionId)).get()!.status).toBe('disabled');
	});
	it('rejects a stale adjustment (409), a bad convention (400), and a non-Apple csv (400)', async () => {
		const db = getDb();
		const { accountIds } = await (await createConn({ request: req({ institutionName: 'B', accounts: [{ name: 'Chk', type: 'checking' }] }) } as never)).json();
		const id = accountIds[0];
		const stale = await adjust({ request: req({ amount: 999, date: '2026-09-08' }), params: { id: String(id) } } as never);
		expect(stale.status).toBe(409); expect(db.select().from(transactions).all()).toHaveLength(0);
		expect((await convention({ request: req({ convention: 'sometimes' }), params: { id: String(id) } } as never)).status).toBe(400);
		expect((await importRoute({ request: multipart('x.csv', 'Date,Amount\n1,2\n'), params: { id: String(id) } } as never)).status).toBe(400);
	});
});
```

- [ ] **Step 4: Run to verify they fail**, then implement the routes

```ts
// src/routes/api/connections/+server.ts
import { handle, readJson, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { createConnection, upsertAccount } from '$lib/server/sync/connections';
import { ACCOUNT_TYPES, type AccountType } from '$lib/server/db/schema';
export const POST = handle(async ({ request }) => {
	const b = await readJson<{ institutionName?: string; accounts?: { name?: string; type?: string }[] }>(request);
	if (!b.institutionName?.trim()) throw new ValidationError('institutionName is required');
	if (!Array.isArray(b.accounts) || b.accounts.length === 0) throw new ValidationError('at least one account is required');
	for (const a of b.accounts) { if (!a.name?.trim()) throw new ValidationError('account name is required'); if (!(ACCOUNT_TYPES as readonly string[]).includes(a.type ?? '')) throw new ValidationError(`account type is invalid: ${a.type}`); }
	const db = getDb();
	return db.transaction((tx) => {
		const connectionId = createConnection(tx, { provider: 'manual', institutionName: b.institutionName!.trim(), appKey: getConfig().appKey });
		const accountIds = b.accounts!.map((a, i) => upsertAccount(tx, connectionId, { externalId: `manual:${i + 1}`, name: a.name!.trim(), type: a.type as AccountType }).id);
		return { connectionId, accountIds };
	});
});
// src/routes/api/connections/[id]/status/+server.ts
export const POST = handle(async ({ request, params }) => {
	const b = await readJson<{ status?: string }>(request);
	if (b.status !== 'active' && b.status !== 'disabled') throw new ValidationError('status must be active or disabled');
	getConnection(getDb(), intParam(params.id, 'id'));       // 404 when missing
	setConnectionStatus(getDb(), intParam(params.id, 'id'), b.status);
	return { ok: true };
});
// src/routes/api/accounts/[id]/+server.ts
export const POST = handle(async ({ request, params }) => {
	const b = await readJson<Record<string, unknown>>(request); const patch: Parameters<typeof updateAccount>[2] = {};
	if (b.name !== undefined) { if (typeof b.name !== 'string' || !b.name.trim()) throw new ValidationError('name must be non-empty'); patch.name = b.name.trim(); }
	if (b.type !== undefined) { if (!(ACCOUNT_TYPES as readonly string[]).includes(String(b.type))) throw new ValidationError('type is invalid'); patch.type = b.type as AccountType; }
	if (b.onBudget !== undefined) { if (typeof b.onBudget !== 'boolean') throw new ValidationError('onBudget must be boolean'); patch.onBudget = b.onBudget; }
	if (b.closedAt !== undefined) patch.closedAt = b.closedAt === null ? null : isoDate(b.closedAt, 'closedAt');
	updateAccount(getDb(), intParam(params.id, 'id'), patch);
	return { ok: true };
});
// balance:
export const POST = handle(async ({ request, params }) => {
	const b = await readJson<{ current: unknown; asOf: unknown; available?: unknown; creditLimit?: unknown }>(request);
	return { id: appendBalance(getDb(), intParam(params.id, 'id'), { current: cents(b.current, 'current'), asOf: isoDate(b.asOf, 'asOf'), available: b.available == null ? null : cents(b.available, 'available'), creditLimit: b.creditLimit == null ? null : cents(b.creditLimit, 'creditLimit'), source: 'manual' }) };
});
// terms: every optional field is `x == null ? null : cents(x, name)` for integers, `isoDate` for dates; asOf required.
export const POST = handle(async ({ request, params }) => {
	const b = await readJson<Record<string, unknown>>(request);
	const opt = (k: string) => (b[k] == null ? null : cents(b[k], k)); const optDate = (k: string) => (b[k] == null ? null : isoDate(b[k], k));
	appendTermsIfChanged(getDb(), intParam(params.id, 'id'), { asOf: isoDate(b.asOf, 'asOf'), source: 'manual', aprBps: opt('aprBps'), promoAprBps: opt('promoAprBps'), minPayment: opt('minPayment'), nextDueDate: optDate('nextDueDate'), lastStatementBalance: opt('lastStatementBalance'), lastStatementDate: optDate('lastStatementDate'), annualFee: opt('annualFee') });
	return { inserted: true };
});
// adjust:
export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id'); const b = await readJson<{ amount: unknown; date: unknown }>(request);
	const amount = cents(b.amount, 'amount'); const db = getDb();
	return db.transaction((tx) => {
		const d = driftForAccount(tx, id);
		if (d.drift == null || d.drift !== amount) throw new InvariantError('DRIFT_CHANGED', `drift is now ${d.drift ?? 'unknown'}`);
		return { id: createAdjustment(tx, id, amount, isoDate(b.date, 'date')) };
	});
});
// convention:
export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id'); const b = await readJson<{ convention?: string }>(request);
	if (b.convention !== 'exclude_pending' && b.convention !== 'include_pending') throw new ValidationError('convention is invalid');
	const db = getDb(); const map = getSetting<Record<string, string>>(db, PENDING_CONVENTION_KEY, {});
	setSetting(db, PENDING_CONVENTION_KEY, { ...map, [String(id)]: b.convention });
	return { ok: true };
});
// import (multipart):
export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id');
	const form = await request.formData().catch(() => null); const file = form?.get('file');
	if (!(file instanceof File)) throw new ValidationError('file is required');
	const text = await file.text(); const config = getConfig(); const db = getDb(); const today = todayIso(config.timeZone);
	let result;
	try { result = importCsv(db, id, text, { cadence: config.cadence, todayIso: today }); }
	catch (err) { if (err instanceof Error && /header/i.test(err.message)) throw new ValidationError(err.message); throw err; }
	const processed = processUnprocessed(db, { todayIso: today, graceDays: getSetting(db, 'grace_days', 3), transferWindowDays: getSetting(db, 'transfer_window_days', 4) });
	return { created: result.created, duplicates: result.duplicates, processed: processed.processed };
});
```
`createAdjustment` marks its row processed already. `importCsv` is typed `Db`, not `DbOrTx`; pass `getDb()` directly (no surrounding transaction). The `InvariantError` import for `adjust` comes from `$lib/server/ledger/errors`.

- [ ] **Step 5: Run to verify they pass**; `npm run check` 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/read/accounts.ts src/lib/server/read/accounts.test.ts src/routes/api/accounts src/routes/api/connections
git commit -m "feat: accounts read model and account, connection, balance, terms, adjustment, import routes"
```

---

### Task 11: Accounts page — connections, Plaid Link, SimpleFIN, manual, drift, terms, CSV

**Files:**
- Create: `src/routes/accounts/+page.server.ts`, `src/routes/accounts/+page.svelte`, `src/routes/accounts/TermsEditor.svelte`, `src/routes/accounts/accounts.test.ts`

**Interfaces:**
- Consumes: `accountsView`, `plaidClient` (for `plaidConfigured`), routes from Task 10 plus 1B's `/api/sync`, `/api/sync/[connectionId]`, `/api/plaid/link-token`, `/api/plaid/exchange`, `/api/simplefin/claim`.
- Plaid Link runs in the browser from `https://cdn.plaid.com/link/v2/stable/link-initialize.js` loaded in `<svelte:head>` only when `plaidConfigured`. Global `window.Plaid.create({ token, onSuccess(publicToken, metadata) })`.

- [ ] **Step 1: Load + test**

`src/routes/accounts/+page.server.ts`:
```ts
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { accountsView } from '$lib/server/read/accounts';
import { todayIso } from '$lib/dates';
export const load: PageServerLoad = () => {
	const config = getConfig();
	return { view: accountsView(getDb(), { plaidConfigured: !!(config.plaid.clientId && config.plaid.secret) }), today: todayIso(config.timeZone) };
};
```
`src/routes/accounts/accounts.test.ts` (harness): assert `load({} as never)` returns `view.plaidConfigured === false` under the test config and `today` matches `/^\d{4}-\d{2}-\d{2}$/`.

- [ ] **Step 2: Terms editor**

`src/routes/accounts/TermsEditor.svelte`:
```svelte
<script lang="ts">
	import Dialog from '$lib/ui/Dialog.svelte';
	import { decimalToCents } from '$lib/money';
	type Terms = { aprBps: number | null; promoAprBps: number | null; minPayment: number | null; nextDueDate: string | null; lastStatementBalance: number | null; lastStatementDate: string | null; annualFee: number | null } | null;
	let { account, terms, today, onsave, onclose }: { account: { id: number; name: string }; terms: Terms; today: string; onsave: (body: Record<string, unknown>) => Promise<void>; onclose: () => void } = $props();
	const pct = (bps: number | null) => (bps == null ? '' : (bps / 100).toFixed(2));
	const dollars = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2));
	let f = $state({ asOf: today, apr: pct(terms?.aprBps ?? null), promoApr: pct(terms?.promoAprBps ?? null), minPayment: dollars(terms?.minPayment ?? null), nextDueDate: terms?.nextDueDate ?? '', lastStatementBalance: dollars(terms?.lastStatementBalance ?? null), lastStatementDate: terms?.lastStatementDate ?? '', annualFee: dollars(terms?.annualFee ?? null) });
	const bps = (s: string) => (s.trim() === '' ? null : Math.round(parseFloat(s) * 100));
	const c = (s: string) => (s.trim() === '' ? null : decimalToCents(s));
	const d = (s: string) => (s.trim() === '' ? null : s);
</script>
<Dialog open={true} title="Terms · {account.name}" {onclose}>
	<form class="grid" onsubmit={(e) => { e.preventDefault(); onsave({ asOf: f.asOf, aprBps: bps(f.apr), promoAprBps: bps(f.promoApr), minPayment: c(f.minPayment), nextDueDate: d(f.nextDueDate), lastStatementBalance: c(f.lastStatementBalance), lastStatementDate: d(f.lastStatementDate), annualFee: c(f.annualFee) }); }}>
		<label for="t-asof">As of</label><input id="t-asof" type="date" bind:value={f.asOf} required />
		<label for="t-apr">APR %</label><input id="t-apr" class="num" bind:value={f.apr} placeholder="27.49" />
		<label for="t-promo">Promo APR %</label><input id="t-promo" class="num" bind:value={f.promoApr} />
		<label for="t-min">Minimum payment</label><input id="t-min" class="num" bind:value={f.minPayment} />
		<label for="t-due">Next due date</label><input id="t-due" type="date" bind:value={f.nextDueDate} />
		<label for="t-stmt">Last statement balance</label><input id="t-stmt" class="num" bind:value={f.lastStatementBalance} />
		<label for="t-stmtd">Last statement date</label><input id="t-stmtd" type="date" bind:value={f.lastStatementDate} />
		<label for="t-fee">Annual fee</label><input id="t-fee" class="num" bind:value={f.annualFee} />
		<div class="actions" style="grid-column: 1 / -1"><button type="button" onclick={onclose}>Cancel</button><button class="primary" type="submit">Save terms</button></div>
	</form>
</Dialog>
```

- [ ] **Step 3: Page**

`src/routes/accounts/+page.svelte`:
```svelte
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import Money from '$lib/ui/Money.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import TermsEditor from './TermsEditor.svelte';
	import { post, upload } from '$lib/ui/api';
	import { decimalToCents } from '$lib/money';
	let { data } = $props();
	const v = $derived(data.view);
	let error = $state(''); let busy = $state<string | null>(null);
	let termsFor = $state<{ id: number; name: string; terms: Parameters<typeof TermsEditor>[0]['terms'] } | null>(null);
	let balanceFor = $state<{ id: number; current: string; asOf: string } | null>(null);
	let editFor = $state<{ id: number; name: string; type: string; onBudget: boolean; closed: boolean } | null>(null);
	let addManual = $state<{ institutionName: string; accounts: { name: string; type: string }[] } | null>(null);
	let simplefin = $state<{ setupToken: string; institutionName: string } | null>(null);
	let plaidName = $state('');
	const run = async (key: string, fn: () => Promise<unknown>) => { error = ''; busy = key; try { await fn(); await invalidateAll(); } catch (e) { error = (e as Error).message; } finally { busy = null; } };
	const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');
	const pct = (bps: number | null) => (bps == null ? '—' : `${(bps / 100).toFixed(2)}%`);

	declare global { interface Window { Plaid?: { create(o: { token: string; onSuccess: (publicToken: string, meta: { institution?: { name?: string } }) => void; onExit?: () => void }): { open(): void } } } }
	async function plaidLink(connectionId?: number) {
		if (!window.Plaid) { error = 'Plaid Link script not loaded'; return; }
		error = '';
		try {
			const { linkToken } = await post<{ linkToken: string }>('/api/plaid/link-token', connectionId ? { connectionId } : {});
			window.Plaid.create({ token: linkToken, onSuccess: (publicToken, meta) => {
				if (connectionId) run('relink', () => post(`/api/sync/${connectionId}`, {}));   // update mode: same access token, just sync again
				else run('plaid', () => post('/api/plaid/exchange', { publicToken, institutionName: plaidName || meta.institution?.name || 'Plaid' }));
			} }).open();
		} catch (e) { error = (e as Error).message; }
	}
	async function importCsv(accountId: number, input: HTMLInputElement) {
		const file = input.files?.[0]; if (!file) return;
		const fd = new FormData(); fd.set('file', file);
		await run(`import-${accountId}`, async () => { const r = await upload<{ created: number; duplicates: number }>(`/api/accounts/${accountId}/import`, fd); error = `Imported ${r.created} new, ${r.duplicates} duplicates`; });
		input.value = '';
	}
</script>

<svelte:head>{#if v.plaidConfigured}<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>{/if}</svelte:head>

<h1>Accounts</h1>
<div class="toolbar">
	<button class="primary" disabled={busy != null} onclick={() => run('all', () => post('/api/sync', { mode: 'full' }))}>Sync all</button>
	<button disabled={busy != null} onclick={() => run('bal', () => post('/api/sync', { mode: 'balances' }))}>Refresh balances</button>
	{#if v.plaidConfigured}<input placeholder="Institution name (optional)" bind:value={plaidName} /><button onclick={() => plaidLink()}>+ Plaid</button>{:else}<span class="muted small">Plaid not configured</span>{/if}
	<button onclick={() => (simplefin = { setupToken: '', institutionName: '' })}>+ SimpleFIN</button>
	<button onclick={() => (addManual = { institutionName: '', accounts: [{ name: '', type: 'checking' }] })}>+ Manual</button>
</div>
{#if error}<p class="error">{error}</p>{/if}

{#each v.connections as c (c.id)}
	<div class="card" style="margin-bottom:1rem">
		<div class="toolbar" style="margin:0 0 .5rem">
			<strong>{c.institutionName}</strong><span class="muted small">{c.provider}</span><span class="status {c.status}">{c.status}</span>
			<span class="small muted">last success {fmtTime(c.lastSuccessAt)}</span>
			{#if c.lastRun}<span class="small muted">last run {c.lastRun.status} · +{c.lastRun.added} ~{c.lastRun.modified} −{c.lastRun.removed}{#if c.lastRun.error} · {c.lastRun.error}{/if}</span>{/if}
			{#if c.provider !== 'manual'}<button disabled={busy != null} onclick={() => run(`sync-${c.id}`, () => post(`/api/sync/${c.id}`, {}))}>Sync</button>{/if}
			{#if c.status === 'needs_relink' && c.provider === 'plaid'}<button class="primary" onclick={() => plaidLink(c.id)}>Relink</button>{/if}
			{#if c.status === 'disabled'}<button onclick={() => run('en', () => post(`/api/connections/${c.id}/status`, { status: 'active' }))}>Enable</button>{:else if c.provider !== 'manual'}<button onclick={() => run('dis', () => post(`/api/connections/${c.id}/status`, { status: 'disabled' }))}>Disable</button>{/if}
		</div>
		{#if c.lastError}<p class="error small">{c.lastError}</p>{/if}
		<table>
			<thead><tr><th>Account</th><th>Type</th><th class="num">Balance</th><th class="num">Ledger</th><th class="num">Drift</th><th>Terms</th><th></th></tr></thead>
			<tbody>
			{#each c.accounts as a (a.id)}
				<tr id="account-{a.id}">
					<td>{a.name}{#if a.mask} <span class="muted small">····{a.mask}</span>{/if}{#if a.closedAt} <span class="status">closed {a.closedAt}</span>{/if}{#if !a.onBudget} <span class="muted small">off-budget</span>{/if}</td>
					<td>{a.type}</td>
					<td class="num">{#if a.balance}<Money cents={a.balance.current} /><div class="small muted">{a.balance.asOf} · {a.balance.source}</div>{:else}<span class="muted">—</span>{/if}</td>
					<td class="num"><Money cents={a.drift.ledgerBalance} /></td>
					<td class="num">{#if a.drift.drift != null && a.drift.drift !== 0}<Money cents={a.drift.drift} signed />
							<button class="small" disabled={busy != null} onclick={() => run(`adj-${a.id}`, () => post(`/api/accounts/${a.id}/adjust`, { amount: a.drift.drift, date: data.today }))}>adjust</button>
							<div class="small muted">{a.drift.convention === 'exclude_pending' ? 'excluding pending' : 'including pending'} · <button class="small" onclick={() => run('conv', () => post(`/api/accounts/${a.id}/convention`, { convention: a.drift.convention === 'exclude_pending' ? 'include_pending' : 'exclude_pending' }))}>switch</button></div>
						{:else if a.drift.drift === 0}<span class="status paid">reconciled</span>{:else}<span class="muted">no balance</span>{/if}</td>
					<td>{#if a.isDebt}{#if a.terms}<span class="small">APR {pct(a.terms.aprBps)} · min <Money cents={a.terms.minPayment ?? 0} /> · due {a.terms.nextDueDate ?? '—'} <span class="muted">({a.terms.source})</span></span>{:else}<span class="muted small">no terms</span>{/if}
							<button class="small" onclick={() => (termsFor = { id: a.id, name: a.name, terms: a.terms })}>edit</button>{/if}</td>
					<td>
						<button class="small" onclick={() => (balanceFor = { id: a.id, current: a.balance ? (a.balance.current / 100).toFixed(2) : '', asOf: data.today })}>balance</button>
						<button class="small" onclick={() => (editFor = { id: a.id, name: a.name, type: a.type, onBudget: a.onBudget, closed: a.closedAt != null })}>edit</button>
						<label class="small">csv <input type="file" accept=".csv,text/csv" hidden onchange={(e) => importCsv(a.id, e.currentTarget)} /></label>
					</td>
				</tr>
			{/each}
			</tbody>
		</table>
	</div>
{:else}<p class="muted">No connections yet. Add Plaid, SimpleFIN, or a manual account.</p>{/each}

{#if termsFor}<TermsEditor account={termsFor} terms={termsFor.terms} today={data.today} onclose={() => (termsFor = null)} onsave={async (body) => { const id = termsFor!.id; termsFor = null; await run('terms', () => post(`/api/accounts/${id}/terms`, body)); }} />{/if}

{#if balanceFor}
<Dialog open={true} title="Record balance" onclose={() => (balanceFor = null)}>
	<form class="grid" onsubmit={(e) => { e.preventDefault(); const b = balanceFor!; balanceFor = null; run('balance', () => post(`/api/accounts/${b.id}/balance`, { current: decimalToCents(b.current), asOf: b.asOf })); }}>
		<label for="b-cur">Current balance</label><input id="b-cur" class="num" bind:value={balanceFor.current} placeholder="-1234.56 for money owed" required />
		<label for="b-asof">As of</label><input id="b-asof" type="date" bind:value={balanceFor.asOf} required />
		<div class="actions" style="grid-column: 1 / -1"><button type="button" onclick={() => (balanceFor = null)}>Cancel</button><button class="primary" type="submit">Save</button></div>
	</form>
</Dialog>
{/if}

{#if editFor}
<Dialog open={true} title="Edit account" onclose={() => (editFor = null)}>
	<form class="grid" onsubmit={(e) => { e.preventDefault(); const f = editFor!; editFor = null; run('edit', () => post(`/api/accounts/${f.id}`, { name: f.name, type: f.type, onBudget: f.onBudget, closedAt: f.closed ? data.today : null })); }}>
		<label for="e-name">Name</label><input id="e-name" bind:value={editFor.name} required />
		<label for="e-type">Type</label><select id="e-type" bind:value={editFor.type}>{#each v.types as t}<option value={t}>{t}</option>{/each}</select>
		<label for="e-ob">On budget</label><input id="e-ob" type="checkbox" bind:checked={editFor.onBudget} />
		<label for="e-cl">Closed</label><input id="e-cl" type="checkbox" bind:checked={editFor.closed} />
		<div class="actions" style="grid-column: 1 / -1"><button type="button" onclick={() => (editFor = null)}>Cancel</button><button class="primary" type="submit">Save</button></div>
	</form>
</Dialog>
{/if}

{#if addManual}
<Dialog open={true} title="Manual connection" onclose={() => (addManual = null)}>
	<form onsubmit={(e) => { e.preventDefault(); const m = addManual!; addManual = null; run('manual', () => post('/api/connections', m)); }}>
		<div class="grid" style="display:grid;grid-template-columns:max-content 1fr;gap:.5rem .75rem"><label for="m-inst">Institution</label><input id="m-inst" bind:value={addManual.institutionName} required /></div>
		<table style="margin:.5rem 0"><thead><tr><th>Account</th><th>Type</th><th></th></tr></thead><tbody>
		{#each addManual.accounts as a, i}<tr><td><input bind:value={a.name} required /></td><td><select bind:value={a.type}>{#each v.types as t}<option value={t}>{t}</option>{/each}</select></td><td><button type="button" onclick={() => addManual!.accounts.splice(i, 1)} disabled={addManual.accounts.length === 1}>×</button></td></tr>{/each}
		</tbody></table>
		<div class="actions"><button type="button" onclick={() => addManual!.accounts.push({ name: '', type: 'credit' })}>Add account</button><button type="button" onclick={() => (addManual = null)}>Cancel</button><button class="primary" type="submit">Create</button></div>
	</form>
</Dialog>
{/if}

{#if simplefin}
<Dialog open={true} title="Connect SimpleFIN" onclose={() => (simplefin = null)}>
	<p class="small muted">Paste the setup token from your SimpleFIN Bridge account. It is claimed once and exchanged for an access URL stored encrypted.</p>
	<form class="grid" onsubmit={(e) => { e.preventDefault(); const s = simplefin!; simplefin = null; run('simplefin', () => post('/api/simplefin/claim', s)); }}>
		<label for="s-name">Institution</label><input id="s-name" bind:value={simplefin.institutionName} required />
		<label for="s-tok">Setup token</label><textarea id="s-tok" rows="3" bind:value={simplefin.setupToken} required></textarea>
		<div class="actions" style="grid-column: 1 / -1"><button type="button" onclick={() => (simplefin = null)}>Cancel</button><button class="primary" type="submit">Connect</button></div>
	</form>
</Dialog>
{/if}
```
Notes: `declare global` inside a `<script lang="ts">` is not allowed by Svelte; put the `Window.Plaid` augmentation in `src/app.d.ts` instead (add `interface Window { Plaid?: … }` at the top level there) and delete the `declare global` block from the component. Relink in Plaid update mode does not change the access token, so the success handler only re-syncs; if the item still reports `needs_relink` afterwards, the status button stays visible, which is the correct signal.

- [ ] **Step 4: Verify** — `npx vitest run`, `npm run check` 0 errors, `npm run build`, dev smoke `curl -s localhost:5173/accounts | grep -c 'Sync all'` → `1`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/accounts src/app.d.ts
git commit -m "feat: accounts page with plaid link, simplefin, manual connections, drift, terms, and csv import"
```

---

### Task 12: Bills read model, income-occurrence actions, and routes

**Files:**
- Create: `src/lib/server/read/bills.ts`, `src/lib/server/read/bills.test.ts`, `src/routes/api/bills/+server.ts`, `src/routes/api/bills/[id]/+server.ts`, `src/routes/api/income/+server.ts`, `src/routes/api/income/[id]/+server.ts`, `src/routes/api/occurrences/[id]/+server.ts`, `src/routes/api/income-occurrences/[id]/+server.ts`, `src/routes/api/bills/bills.test.ts`
- Modify: `src/lib/server/bills/matching.ts` (income manual actions), `src/lib/server/bills/matching.test.ts` (append)

**Interfaces:**
- Consumes: `createBill`, `updateBill`, `setBillActive`, `createIncomeSource`, `updateIncomeSource`, `setIncomeActive`, `generateOccurrences`, `markOccurrencePaid`, `unmarkOccurrence`, `skipOccurrence`, `matchAll`.
- Produces in `matching.ts`:
  - `markIncomeReceived(db, occurrenceId, opts: { transactionId?: number | null; amount?: number | null }): void` — `status: 'received'`? No: the schema's statuses are `pending | paid | overdue | skipped`; income uses `paid` for received (as `matchIncomeOccurrences` already does). Sets `receivedAmount = opts.amount ?? (transactionId ? transaction.amount : expectedAmount)`, `transactionId`, `markedBy: 'manual'`.
  - `unmarkIncome(db, occurrenceId)`, `skipIncome(db, occurrenceId)` — mirrors of the bill functions.
- Read model:
```ts
export type Occ = { id: number; dueDate: string; periodLabel: string; expected: number; paid: number; extra: number; status: string; markedBy: string | null; needsReview: boolean; transactionIds: number[] };
export type BillsView = {
	bills: { id: number; name: string; categoryId: number; categoryName: string; payFromAccountId: number; payFromAccountName: string; expectedAmount: number; toleranceAbs: number; tolerancePct: number;
		cadence: string; dueDay: number | null; dueDay2: number | null; interval: number | null; anchorDate: string | null; autopay: boolean; matchPattern: string | null; linkedDebtAccountId: number | null; active: boolean;
		next: Occ | null; history: Occ[] }[];                                                   // history: newest 12 occurrences, due desc
	income: { id: number; name: string; categoryId: number; depositAccountId: number; depositAccountName: string; expectedAmount: number; toleranceAbs: number; tolerancePct: number; cadence: string; dueDay: number | null; dueDay2: number | null; interval: number | null; anchorDate: string | null; matchPattern: string | null; active: boolean;
		next: Occ | null; history: Occ[] }[];
	accounts: { id: number; name: string; type: string; isDebt: boolean }[]; cadences: readonly string[];
};
export function billsView(db: DbOrTx, opts: { todayIso: string }): BillsView
```
`next` is the earliest non-skipped occurrence with `due_date >= todayIso`, else null. For income `Occ.paid` is `received_amount`, `extra` is 0, `transactionIds` is `[transaction_id]` or `[]`.
- Routes:
  - `POST /api/bills { name, categoryId, payFromAccountId, expectedAmount, cadence, dueDay?, dueDay2?, interval?, anchorDate?, toleranceAbs?, tolerancePct?, autopay?, matchPattern?, linkedDebtAccountId? }` → `{ id }`; after insert, `generateOccurrences` so the new bill shows occurrences immediately.
  - `POST /api/bills/[id] { ...same fields, all optional, active? }` → `{ ok }` (`updateBill` + `setBillActive` when `active` present) then `generateOccurrences`.
  - `POST /api/income`, `POST /api/income/[id]` — same shape minus `autopay`/`linkedDebtAccountId`, with `depositAccountId`.
  - `POST /api/occurrences/[id] { action: 'paid' | 'unmark' | 'skip', transactionId?, amount? }` → `{ ok }`.
  - `POST /api/income-occurrences/[id] { action: 'received' | 'unmark' | 'skip', transactionId?, amount? }` → `{ ok }`.
  - Validation: `cadence` in `BILL_CADENCES`; `monthly` needs `dueDay` 1–31; `semi_monthly` needs `dueDay` and `dueDay2`; `every_n_weeks` needs `interval ≥ 1` and `anchorDate`; `yearly` needs `anchorDate`. Invalid → 400.

- [ ] **Step 1: Failing tests for income manual actions** (append to `matching.test.ts`)

```ts
describe('income manual actions', () => {
	it('marks received, unmarks, and skips', () => {
		const f = fixture();
		createIncomeSource(f.db, { name: 'Salary', categoryId: f.income, depositAccountId: f.checking, expectedAmount: 275000, cadence: 'semi_monthly', dueDay: 15, dueDay2: 30 });
		generateOccurrences(f.db, { todayIso: '2026-09-08', cadence: 'semi_monthly', graceDays: 3 });
		const occ = f.db.select().from(incomeOccurrences).orderBy(asc(incomeOccurrences.dueDate)).all().find((o) => o.dueDate >= '2026-09-01')!;
		const t = createTransaction(f.db, { accountId: f.checking, externalId: 'pay', postedDate: '2026-09-14', amount: 274000, payeeRaw: 'PAYROLL', source: 'sync' });
		markIncomeReceived(f.db, occ.id, { transactionId: t });
		let row = f.db.select().from(incomeOccurrences).where(eq(incomeOccurrences.id, occ.id)).get()!;
		expect(row).toMatchObject({ status: 'paid', receivedAmount: 274000, transactionId: t, markedBy: 'manual' });
		unmarkIncome(f.db, occ.id);
		row = f.db.select().from(incomeOccurrences).where(eq(incomeOccurrences.id, occ.id)).get()!;
		expect(row).toMatchObject({ status: 'pending', receivedAmount: 0, transactionId: null, markedBy: 'manual' });
		skipIncome(f.db, occ.id);
		expect(f.db.select().from(incomeOccurrences).where(eq(incomeOccurrences.id, occ.id)).get()!.status).toBe('skipped');
	});
});
```
(Import `fixture` from `../test/fixture`; the file already imports the rest or add as needed.)

- [ ] **Step 2: Run to verify it fails**, then implement in `matching.ts`

```ts
export function markIncomeReceived(db: DbOrTx, occurrenceId: number, opts: { transactionId?: number | null; amount?: number | null } = {}): void {
	const o = db.select().from(incomeOccurrences).where(eq(incomeOccurrences.id, occurrenceId)).get();
	if (!o) throw new Error(`income occurrence ${occurrenceId} not found`);
	const received = opts.amount ?? (opts.transactionId != null ? getTransaction(db, opts.transactionId).amount : o.expectedAmount);
	db.update(incomeOccurrences).set({ status: 'paid', receivedAmount: received, transactionId: opts.transactionId ?? null, markedBy: 'manual', ...touch() }).where(eq(incomeOccurrences.id, occurrenceId)).run();
}
export function unmarkIncome(db: DbOrTx, occurrenceId: number): void {
	db.update(incomeOccurrences).set({ status: 'pending', receivedAmount: 0, transactionId: null, markedBy: 'manual', ...touch() }).where(eq(incomeOccurrences.id, occurrenceId)).run();
}
export function skipIncome(db: DbOrTx, occurrenceId: number): void {
	db.update(incomeOccurrences).set({ status: 'skipped', markedBy: 'manual', ...touch() }).where(eq(incomeOccurrences.id, occurrenceId)).run();
}
```

- [ ] **Step 3: Failing read-model test**

`src/lib/server/read/bills.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { createBill, createIncomeSource } from '../bills/bills';
import { generateOccurrences } from '../bills/schedule';
import { markOccurrencePaid } from '../bills/matching';
import { billOccurrences } from '../db/schema';
import { billsView } from './bills';
describe('billsView', () => {
	it('lists definitions with the next occurrence and recent history', () => {
		const f = fixture();
		createBill(f.db, { name: 'Rent', categoryId: f.rent, payFromAccountId: f.checking, expectedAmount: 227445, cadence: 'monthly', dueDay: 1 });
		createIncomeSource(f.db, { name: 'Salary', categoryId: f.income, depositAccountId: f.checking, expectedAmount: 275000, cadence: 'semi_monthly', dueDay: 15, dueDay2: 30 });
		generateOccurrences(f.db, { todayIso: '2026-09-08', cadence: 'semi_monthly', graceDays: 3 });
		const sep1 = f.db.select().from(billOccurrences).all().find((o) => o.dueDate === '2026-09-01')!;
		markOccurrencePaid(f.db, sep1.id);
		const v = billsView(f.db, { todayIso: '2026-09-08' });
		const rent = v.bills[0];
		expect(rent).toMatchObject({ name: 'Rent', categoryName: 'Rent', payFromAccountName: 'Checking', active: true });
		expect(rent.next?.dueDate).toBe('2026-10-01');
		expect(rent.history.map((o) => [o.dueDate, o.status])).toContainEqual(['2026-09-01', 'paid']);
		expect(rent.history[0].periodLabel).toMatch(/2026/);
		expect(v.income[0].next?.dueDate).toBe('2026-09-15');
		expect(v.accounts.map((a) => a.name)).toEqual(['Checking', 'Savings', 'Sapphire']);
		expect(v.cadences).toContain('every_n_weeks');
	});
});
```

- [ ] **Step 4: Run to verify it fails**, then implement `bills.ts`

```ts
import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, billOccurrences, billOccurrenceTransactions, bills, categories, incomeOccurrences, incomeSources, periods, BILL_CADENCES } from '../db/schema';
import { compareIso } from '$lib/dates';
export type Occ = { /* copy */ }; export type BillsView = { /* copy */ };
export function billsView(db: DbOrTx, opts: { todayIso: string }): BillsView {
	const periodLabel = new Map(db.select({ id: periods.id, label: periods.label }).from(periods).all().map((p) => [p.id, p.label]));
	const accts = db.select().from(accounts).orderBy(asc(accounts.id)).all(); const acctName = new Map(accts.map((a) => [a.id, a.name]));
	const catName = new Map(db.select({ id: categories.id, name: categories.name }).from(categories).all().map((c) => [c.id, c.name]));
	const links = db.select().from(billOccurrenceTransactions).all();
	const split = (occs: Occ[]) => { const sorted = [...occs].sort((a, b) => compareIso(a.dueDate, b.dueDate)); const next = sorted.find((o) => o.status !== 'skipped' && compareIso(o.dueDate, opts.todayIso) >= 0) ?? null; return { next, history: sorted.reverse().slice(0, 12) }; };
	const billRows = db.select().from(bills).orderBy(asc(bills.name)).all();
	const billOccs = db.select().from(billOccurrences).where(billRows.length ? inArray(billOccurrences.billId, billRows.map((b) => b.id)) : eq(billOccurrences.id, -1)).all();
	const incRows = db.select().from(incomeSources).orderBy(asc(incomeSources.name)).all();
	const incOccs = db.select().from(incomeOccurrences).where(incRows.length ? inArray(incomeOccurrences.incomeSourceId, incRows.map((i) => i.id)) : eq(incomeOccurrences.id, -1)).all();
	return {
		bills: billRows.map((b) => ({
			id: b.id, name: b.name, categoryId: b.categoryId, categoryName: catName.get(b.categoryId) ?? '', payFromAccountId: b.payFromAccountId, payFromAccountName: acctName.get(b.payFromAccountId) ?? '',
			expectedAmount: b.expectedAmount, toleranceAbs: b.toleranceAbs, tolerancePct: b.tolerancePct, cadence: b.cadence, dueDay: b.dueDay, dueDay2: b.dueDay2, interval: b.interval, anchorDate: b.anchorDate,
			autopay: b.autopay, matchPattern: b.matchPattern, linkedDebtAccountId: b.linkedDebtAccountId, active: b.active,
			...split(billOccs.filter((o) => o.billId === b.id).map((o) => ({ id: o.id, dueDate: o.dueDate, periodLabel: periodLabel.get(o.periodId) ?? '', expected: o.expectedAmount, paid: o.paidAmount, extra: o.extraAmount, status: o.status, markedBy: o.markedBy, needsReview: o.needsReview, transactionIds: links.filter((l) => l.billOccurrenceId === o.id).map((l) => l.transactionId) })))
		})),
		income: incRows.map((s) => ({
			id: s.id, name: s.name, categoryId: s.categoryId, depositAccountId: s.depositAccountId, depositAccountName: acctName.get(s.depositAccountId) ?? '', expectedAmount: s.expectedAmount, toleranceAbs: s.toleranceAbs, tolerancePct: s.tolerancePct,
			cadence: s.cadence, dueDay: s.dueDay, dueDay2: s.dueDay2, interval: s.interval, anchorDate: s.anchorDate, matchPattern: s.matchPattern, active: s.active,
			...split(incOccs.filter((o) => o.incomeSourceId === s.id).map((o) => ({ id: o.id, dueDate: o.dueDate, periodLabel: periodLabel.get(o.periodId) ?? '', expected: o.expectedAmount, paid: o.receivedAmount, extra: 0, status: o.status, markedBy: o.markedBy, needsReview: false, transactionIds: o.transactionId != null ? [o.transactionId] : [] })))
		})),
		accounts: accts.map((a) => ({ id: a.id, name: a.name, type: a.type, isDebt: a.isDebt })), cadences: BILL_CADENCES
	};
}
```

- [ ] **Step 5: Failing route tests**

`src/routes/api/bills/bills.test.ts` (harness, plus):
```ts
import { getDb } from '$lib/server/db/instance';
import { bills, billOccurrences, incomeSources, incomeOccurrences, categoryGroups } from '$lib/server/db/schema';
import { createConnection, upsertAccount } from '$lib/server/sync/connections';
import { createCategory, systemCategoryId } from '$lib/server/ledger/categories';
import { POST as createBillRoute } from './+server';
import { POST as patchBillRoute } from './[id]/+server';
import { POST as createIncomeRoute } from '../income/+server';
import { POST as occurrenceRoute } from '../occurrences/[id]/+server';
import { POST as incomeOccurrenceRoute } from '../income-occurrences/[id]/+server';
import { eq } from 'drizzle-orm';
function setup() {
	const db = getDb(); const conn = createConnection(db, { provider: 'manual', institutionName: 'T', appKey: 'k'.repeat(40) });
	const chk = upsertAccount(db, conn, { externalId: 'chk', name: 'Checking', type: 'checking' }).id;
	const group = db.select().from(categoryGroups).where(eq(categoryGroups.name, 'Bills')).get()!.id;
	return { db, chk, rent: createCategory(db, { groupId: group, name: 'Rent', kind: 'bill' }) };
}
describe('bill and income routes', () => {
	it('creates a bill with occurrences, edits it, marks an occurrence paid and unmarks it', async () => {
		const { db, chk, rent } = setup();
		const { id } = await (await createBillRoute({ request: req({ name: 'Rent', categoryId: rent, payFromAccountId: chk, expectedAmount: 227445, cadence: 'monthly', dueDay: 1 }) } as never)).json();
		expect(db.select().from(billOccurrences).where(eq(billOccurrences.billId, id)).all().length).toBeGreaterThan(0);
		expect((await patchBillRoute({ request: req({ expectedAmount: 230000, active: false }), params: { id: String(id) } } as never)).status).toBe(200);
		expect(db.select().from(bills).where(eq(bills.id, id)).get()).toMatchObject({ expectedAmount: 230000, active: false });
		const occ = db.select().from(billOccurrences).where(eq(billOccurrences.billId, id)).all()[0];
		expect((await occurrenceRoute({ request: req({ action: 'paid', amount: 227445 }), params: { id: String(occ.id) } } as never)).status).toBe(200);
		expect(db.select().from(billOccurrences).where(eq(billOccurrences.id, occ.id)).get()).toMatchObject({ status: 'paid', paidAmount: 227445, markedBy: 'manual' });
		expect((await occurrenceRoute({ request: req({ action: 'unmark' }), params: { id: String(occ.id) } } as never)).status).toBe(200);
		expect(db.select().from(billOccurrences).where(eq(billOccurrences.id, occ.id)).get()!.status).toBe('pending');
	});
	it('creates income and marks an occurrence received; rejects a monthly bill without dueDay (400) and an unknown action (400)', async () => {
		const { db, chk, rent } = setup();
		const { id } = await (await createIncomeRoute({ request: req({ name: 'Salary', categoryId: systemCategoryId(db, 'income'), depositAccountId: chk, expectedAmount: 275000, cadence: 'semi_monthly', dueDay: 15, dueDay2: 30 }) } as never)).json();
		const occ = db.select().from(incomeOccurrences).where(eq(incomeOccurrences.incomeSourceId, id)).all()[0];
		expect((await incomeOccurrenceRoute({ request: req({ action: 'received' }), params: { id: String(occ.id) } } as never)).status).toBe(200);
		expect(db.select().from(incomeOccurrences).where(eq(incomeOccurrences.id, occ.id)).get()).toMatchObject({ status: 'paid', receivedAmount: 275000 });
		expect((await createBillRoute({ request: req({ name: 'X', categoryId: rent, payFromAccountId: chk, expectedAmount: 1, cadence: 'monthly' }) } as never)).status).toBe(400);
		expect(db.select().from(bills).all()).toHaveLength(0);
		expect((await occurrenceRoute({ request: req({ action: 'explode' }), params: { id: String(occ.id) } } as never)).status).toBe(400);
	});
});
```

- [ ] **Step 6: Run to verify they fail**, then implement the routes

Shared validation helper, `src/routes/api/bills/schedule-body.ts`:
```ts
import { cents, isoDate, ValidationError } from '$lib/server/http';
import { BILL_CADENCES, type BillCadence } from '$lib/server/db/schema';
export type ScheduleFields = { cadence: BillCadence; dueDay: number | null; dueDay2: number | null; interval: number | null; anchorDate: string | null };
/** Validate the cadence fields of a bill or income body. `partial` allows omitting cadence (patch); when cadence is present its companions are checked. */
export function scheduleFields(b: Record<string, unknown>, partial: boolean): Partial<ScheduleFields> {
	const out: Partial<ScheduleFields> = {};
	if (b.cadence === undefined) { if (!partial) throw new ValidationError('cadence is required'); return out; }
	if (!(BILL_CADENCES as readonly string[]).includes(String(b.cadence))) throw new ValidationError('cadence is invalid');
	const cadence = b.cadence as BillCadence;
	const day = (k: string) => { const v = cents(b[k], k); if (v < 1 || v > 31) throw new ValidationError(`${k} must be 1-31`); return v; };
	out.cadence = cadence; out.dueDay = null; out.dueDay2 = null; out.interval = null; out.anchorDate = null;
	if (cadence === 'monthly') out.dueDay = day('dueDay');
	if (cadence === 'semi_monthly') { out.dueDay = day('dueDay'); out.dueDay2 = day('dueDay2'); }
	if (cadence === 'every_n_weeks') { out.interval = cents(b.interval, 'interval'); if (out.interval < 1) throw new ValidationError('interval must be >= 1'); out.anchorDate = isoDate(b.anchorDate, 'anchorDate'); }
	if (cadence === 'yearly') out.anchorDate = isoDate(b.anchorDate, 'anchorDate');
	return out;
}
export function commonFields(b: Record<string, unknown>, partial: boolean) {
	const out: Record<string, unknown> = {};
	if (b.name !== undefined || !partial) { if (typeof b.name !== 'string' || !b.name.trim()) throw new ValidationError('name is required'); out.name = b.name.trim(); }
	if (b.categoryId !== undefined || !partial) out.categoryId = cents(b.categoryId, 'categoryId');
	if (b.expectedAmount !== undefined || !partial) out.expectedAmount = cents(b.expectedAmount, 'expectedAmount');
	if (b.toleranceAbs !== undefined) out.toleranceAbs = cents(b.toleranceAbs, 'toleranceAbs');
	if (b.tolerancePct !== undefined) out.tolerancePct = cents(b.tolerancePct, 'tolerancePct');
	if (b.matchPattern !== undefined) out.matchPattern = b.matchPattern === null ? null : String(b.matchPattern);
	return out;
}
```
Routes:
```ts
// src/routes/api/bills/+server.ts
import { handle, readJson, cents } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { createBill, type NewBill } from '$lib/server/bills/bills';
import { generateOccurrences } from '$lib/server/bills/schedule';
import { getSetting } from '$lib/server/settings';
import { todayIso } from '$lib/dates';
import { scheduleFields, commonFields } from './schedule-body';
export function regenerate() { const db = getDb(); const c = getConfig(); return generateOccurrences(db, { todayIso: todayIso(c.timeZone), cadence: c.cadence, graceDays: getSetting(db, 'grace_days', 3) }); }
export const POST = handle(async ({ request }) => {
	const b = await readJson<Record<string, unknown>>(request);
	const input = { ...commonFields(b, false), ...scheduleFields(b, false), payFromAccountId: cents(b.payFromAccountId, 'payFromAccountId'),
		autopay: b.autopay === true, linkedDebtAccountId: b.linkedDebtAccountId == null ? null : cents(b.linkedDebtAccountId, 'linkedDebtAccountId') } as NewBill;
	const id = createBill(getDb(), input); regenerate(); return { id };
});
// src/routes/api/bills/[id]/+server.ts
export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id'); const b = await readJson<Record<string, unknown>>(request); const db = getDb();
	const patch = { ...commonFields(b, true), ...scheduleFields(b, true) } as Partial<NewBill>;
	if (b.payFromAccountId !== undefined) patch.payFromAccountId = cents(b.payFromAccountId, 'payFromAccountId');
	if (b.autopay !== undefined) patch.autopay = b.autopay === true;
	if (b.linkedDebtAccountId !== undefined) patch.linkedDebtAccountId = b.linkedDebtAccountId == null ? null : cents(b.linkedDebtAccountId, 'linkedDebtAccountId');
	if (!db.select({ id: bills.id }).from(bills).where(eq(bills.id, id)).get()) throw new Error(`bill ${id} not found`);
	if (Object.keys(patch).length) updateBill(db, id, patch);
	if (b.active !== undefined) setBillActive(db, id, b.active === true);
	regenerate(); return { ok: true };
});
// income routes mirror these with depositAccountId and no autopay/linkedDebtAccountId; import regenerate from '../bills/+server'.
// src/routes/api/occurrences/[id]/+server.ts
export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id'); const b = await readJson<{ action?: string; transactionId?: unknown; amount?: unknown }>(request); const db = getDb();
	const opts = { transactionId: b.transactionId == null ? null : cents(b.transactionId, 'transactionId'), amount: b.amount == null ? null : cents(b.amount, 'amount') };
	if (b.action === 'paid') markOccurrencePaid(db, id, opts);
	else if (b.action === 'unmark') unmarkOccurrence(db, id);
	else if (b.action === 'skip') skipOccurrence(db, id);
	else throw new ValidationError('action must be paid, unmark, or skip');
	return { ok: true };
});
// income-occurrences: actions received | unmark | skip → markIncomeReceived | unmarkIncome | skipIncome.
```
`unmarkOccurrence`/`skipOccurrence` do not check existence; add a `select` first in the route so an unknown id is a 404 rather than a silent no-op. Exporting `regenerate` from a `+server.ts` alongside `POST` is allowed by SvelteKit only for uppercase HTTP method names and known exports; move `regenerate` into `src/routes/api/bills/schedule-body.ts` instead (rename that file `bills-shared.ts`) to avoid the "unexpected export" build error.

- [ ] **Step 7: Run to verify they pass**; `npm run check`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/server/bills/matching.ts src/lib/server/bills/matching.test.ts src/lib/server/read/bills.ts src/lib/server/read/bills.test.ts src/routes/api/bills src/routes/api/income src/routes/api/occurrences src/routes/api/income-occurrences
git commit -m "feat: bills read model, income occurrence actions, and bill, income, occurrence routes"
```

---

### Task 13: Bills page

**Files:**
- Create: `src/routes/bills/+page.server.ts`, `src/routes/bills/+page.svelte`, `src/routes/bills/DefinitionForm.svelte`, `src/routes/bills/bills.test.ts`

**Interfaces:**
- Consumes: `billsView`, `categoryTree`, routes from Task 12.

- [ ] **Step 1: Load + test**

`src/routes/bills/+page.server.ts`:
```ts
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { billsView } from '$lib/server/read/bills';
import { categoryTree } from '$lib/server/read/categories';
import { todayIso } from '$lib/dates';
export const load: PageServerLoad = () => { const today = todayIso(getConfig().timeZone); return { view: billsView(getDb(), { todayIso: today }), tree: categoryTree(getDb()), today }; };
```
`src/routes/bills/bills.test.ts` (harness): `load({} as never)` returns `view.bills` as an array and `tree.groups.length > 0`.

- [ ] **Step 2: Definition form (shared by bills and income)**

`src/routes/bills/DefinitionForm.svelte`:
```svelte
<script lang="ts">
	import Dialog from '$lib/ui/Dialog.svelte';
	import { decimalToCents } from '$lib/money';
	import type { CategoryTree } from '$lib/server/read/categories';
	type Def = { id?: number; name: string; categoryId: number | null; accountId: number | null; expectedAmount: string; cadence: string; dueDay: number | null; dueDay2: number | null; interval: number | null; anchorDate: string | null; toleranceAbs: string; tolerancePct: number; matchPattern: string; autopay: boolean; linkedDebtAccountId: number | null; active: boolean };
	let { kind, def, tree, accounts, cadences, onsave, onclose }: { kind: 'bill' | 'income'; def: Def; tree: CategoryTree; accounts: { id: number; name: string; type: string; isDebt: boolean }[]; cadences: readonly string[]; onsave: (body: Record<string, unknown>) => Promise<void>; onclose: () => void } = $props();
	let f = $state({ ...def });
	function body(): Record<string, unknown> {
		const b: Record<string, unknown> = { name: f.name, categoryId: f.categoryId, expectedAmount: decimalToCents(f.expectedAmount), cadence: f.cadence, dueDay: f.dueDay, dueDay2: f.dueDay2, interval: f.interval, anchorDate: f.anchorDate, toleranceAbs: f.toleranceAbs ? decimalToCents(f.toleranceAbs) : 0, tolerancePct: f.tolerancePct, matchPattern: f.matchPattern || null };
		if (kind === 'bill') { b.payFromAccountId = f.accountId; b.autopay = f.autopay; b.linkedDebtAccountId = f.linkedDebtAccountId; } else b.depositAccountId = f.accountId;
		if (f.id != null) b.active = f.active;
		return b;
	}
	const cashAccounts = $derived(accounts.filter((a) => !a.isDebt)); const debtAccounts = $derived(accounts.filter((a) => a.isDebt));
</script>
<Dialog open={true} title={(f.id != null ? 'Edit ' : 'New ') + kind} {onclose}>
	<form class="grid" onsubmit={(e) => { e.preventDefault(); onsave(body()); }}>
		<label for="d-name">Name</label><input id="d-name" bind:value={f.name} required />
		<label for="d-cat">Category</label><select id="d-cat" bind:value={f.categoryId} required><option value={null}>choose…</option>{#each tree.groups as g}<optgroup label={g.name}>{#each g.categories as c}<option value={c.id}>{c.name}</option>{/each}</optgroup>{/each}</select>
		<label for="d-acct">{kind === 'bill' ? 'Paid from' : 'Deposited to'}</label><select id="d-acct" bind:value={f.accountId} required><option value={null}>choose…</option>{#each cashAccounts as a}<option value={a.id}>{a.name}</option>{/each}</select>
		<label for="d-amt">Expected amount</label><input id="d-amt" class="num" bind:value={f.expectedAmount} required />
		<label for="d-cad">Cadence</label><select id="d-cad" bind:value={f.cadence}>{#each cadences as c}<option value={c}>{c}</option>{/each}</select>
		{#if f.cadence === 'monthly' || f.cadence === 'semi_monthly'}<label for="d-day">Due day</label><input id="d-day" type="number" min="1" max="31" bind:value={f.dueDay} required />{/if}
		{#if f.cadence === 'semi_monthly'}<label for="d-day2">Second due day</label><input id="d-day2" type="number" min="1" max="31" bind:value={f.dueDay2} required />{/if}
		{#if f.cadence === 'every_n_weeks'}<label for="d-int">Every N weeks</label><input id="d-int" type="number" min="1" bind:value={f.interval} required />{/if}
		{#if f.cadence === 'every_n_weeks' || f.cadence === 'yearly'}<label for="d-anchor">Anchor date</label><input id="d-anchor" type="date" bind:value={f.anchorDate} required />{/if}
		<label for="d-tol">Tolerance ($ / %)</label><span><input class="num" style="width:5em" bind:value={f.toleranceAbs} placeholder="0.00" /> <input type="number" min="0" max="100" style="width:4em" bind:value={f.tolerancePct} /></span>
		<label for="d-pat">Match pattern</label><input id="d-pat" bind:value={f.matchPattern} placeholder="substring of the payee, optional" />
		{#if kind === 'bill'}
			<label for="d-auto">Autopay</label><input id="d-auto" type="checkbox" bind:checked={f.autopay} />
			<label for="d-debt">Card / loan paid</label><select id="d-debt" bind:value={f.linkedDebtAccountId}><option value={null}>not a debt payment</option>{#each debtAccounts as a}<option value={a.id}>{a.name}</option>{/each}</select>
		{/if}
		{#if f.id != null}<label for="d-active">Active</label><input id="d-active" type="checkbox" bind:checked={f.active} />{/if}
		<div class="actions" style="grid-column: 1 / -1"><button type="button" onclick={onclose}>Cancel</button><button class="primary" type="submit">Save</button></div>
	</form>
</Dialog>
```

- [ ] **Step 3: Page**

`src/routes/bills/+page.svelte`:
```svelte
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import Money from '$lib/ui/Money.svelte';
	import DefinitionForm from './DefinitionForm.svelte';
	import { post } from '$lib/ui/api';
	let { data } = $props();
	const v = $derived(data.view);
	let error = $state(''); let open = $state<Record<string, boolean>>({});
	let editing = $state<{ kind: 'bill' | 'income'; def: Parameters<typeof DefinitionForm>[0]['def'] } | null>(null);
	const run = async (fn: () => Promise<unknown>) => { error = ''; try { await fn(); await invalidateAll(); } catch (e) { error = (e as Error).message; } };
	const blank = (kind: 'bill' | 'income') => ({ kind, def: { name: '', categoryId: null, accountId: null, expectedAmount: '', cadence: 'monthly', dueDay: 1, dueDay2: null, interval: null, anchorDate: null, toleranceAbs: '', tolerancePct: 0, matchPattern: '', autopay: false, linkedDebtAccountId: null, active: true } });
	const fromBill = (b: (typeof v.bills)[number]) => ({ kind: 'bill' as const, def: { id: b.id, name: b.name, categoryId: b.categoryId, accountId: b.payFromAccountId, expectedAmount: (b.expectedAmount / 100).toFixed(2), cadence: b.cadence, dueDay: b.dueDay, dueDay2: b.dueDay2, interval: b.interval, anchorDate: b.anchorDate, toleranceAbs: b.toleranceAbs ? (b.toleranceAbs / 100).toFixed(2) : '', tolerancePct: b.tolerancePct, matchPattern: b.matchPattern ?? '', autopay: b.autopay, linkedDebtAccountId: b.linkedDebtAccountId, active: b.active } });
	const fromIncome = (s: (typeof v.income)[number]) => ({ kind: 'income' as const, def: { id: s.id, name: s.name, categoryId: s.categoryId, accountId: s.depositAccountId, expectedAmount: (s.expectedAmount / 100).toFixed(2), cadence: s.cadence, dueDay: s.dueDay, dueDay2: s.dueDay2, interval: s.interval, anchorDate: s.anchorDate, toleranceAbs: s.toleranceAbs ? (s.toleranceAbs / 100).toFixed(2) : '', tolerancePct: s.tolerancePct, matchPattern: s.matchPattern ?? '', autopay: false, linkedDebtAccountId: null, active: s.active } });
	async function save(body: Record<string, unknown>) {
		const e = editing!; editing = null;
		const base = e.kind === 'bill' ? '/api/bills' : '/api/income';
		await run(() => post(e.def.id != null ? `${base}/${e.def.id}` : base, body));
	}
	const occAction = (kind: 'bill' | 'income', id: number, action: string) => run(() => post(kind === 'bill' ? `/api/occurrences/${id}` : `/api/income-occurrences/${id}`, { action }));
	const schedule = (d: { cadence: string; dueDay: number | null; dueDay2: number | null; interval: number | null; anchorDate: string | null }) =>
		d.cadence === 'monthly' ? `monthly on the ${d.dueDay}` : d.cadence === 'semi_monthly' ? `on the ${d.dueDay} and ${d.dueDay2}` : d.cadence === 'every_n_weeks' ? `every ${d.interval} weeks from ${d.anchorDate}` : `yearly on ${d.anchorDate}`;
</script>

<h1>Bills & income</h1>
{#if error}<p class="error">{error}</p>{/if}

{#snippet history(kind: 'bill' | 'income', rows: (typeof v.bills)[number]['history'])}
	<table style="margin:.25rem 0 .75rem"><thead><tr><th>Due</th><th>Period</th><th class="num">Expected</th><th class="num">{kind === 'bill' ? 'Paid' : 'Received'}</th>{#if kind === 'bill'}<th class="num">Extra</th>{/if}<th>Status</th><th></th></tr></thead><tbody>
	{#each rows as o (o.id)}
		<tr><td>{o.dueDate}</td><td class="muted">{o.periodLabel}</td><td class="num"><Money cents={o.expected} /></td><td class="num"><Money cents={o.paid} /></td>{#if kind === 'bill'}<td class="num"><Money cents={o.extra} /></td>{/if}
			<td><span class="status {o.status}">{o.status}</span>{#if o.markedBy === 'manual'} <span class="muted small">manual</span>{/if}{#if o.needsReview} <span class="status overdue">tie</span>{/if}
				{#if o.transactionIds.length}<a class="small" href="/ledger?q=&review=0" title="linked transactions: {o.transactionIds.join(', ')}"> {o.transactionIds.length} linked</a>{/if}</td>
			<td>{#if o.status === 'paid'}<button class="small" onclick={() => occAction(kind, o.id, 'unmark')}>unmark</button>{:else if o.status !== 'skipped'}<button class="small" onclick={() => occAction(kind, o.id, kind === 'bill' ? 'paid' : 'received')}>mark {kind === 'bill' ? 'paid' : 'received'}</button> <button class="small" onclick={() => occAction(kind, o.id, 'skip')}>skip</button>{:else}<button class="small" onclick={() => occAction(kind, o.id, 'unmark')}>unskip</button>{/if}</td></tr>
	{/each}
	</tbody></table>
{/snippet}

<div class="toolbar"><h2 style="margin:0">Bills</h2><button class="primary" onclick={() => (editing = blank('bill'))}>+ Bill</button></div>
<table><thead><tr><th>Bill</th><th>Schedule</th><th>From</th><th class="num">Expected</th><th>Next</th><th></th></tr></thead><tbody>
{#each v.bills as b (b.id)}
	<tr class:muted={!b.active}><td>{b.name}{#if b.linkedDebtAccountId} <span class="muted small">card</span>{/if}{#if b.autopay} <span class="muted small">autopay</span>{/if}{#if !b.active} <span class="status">inactive</span>{/if}</td>
		<td class="small">{schedule(b)}</td><td>{b.payFromAccountName}</td><td class="num"><Money cents={b.expectedAmount} /></td>
		<td>{#if b.next}{b.next.dueDate} <span class="status {b.next.status}">{b.next.status}</span>{:else}<span class="muted">—</span>{/if}</td>
		<td><button class="small" onclick={() => (editing = fromBill(b))}>edit</button> <button class="small" onclick={() => (open[`b${b.id}`] = !open[`b${b.id}`])}>{open[`b${b.id}`] ? 'hide' : 'history'}</button></td></tr>
	{#if open[`b${b.id}`]}<tr><td colspan="6">{@render history('bill', b.history)}</td></tr>{/if}
{:else}<tr><td colspan="6" class="muted">No bills yet.</td></tr>{/each}
</tbody></table>

<div class="toolbar"><h2 style="margin:0">Income</h2><button class="primary" onclick={() => (editing = blank('income'))}>+ Income</button></div>
<table><thead><tr><th>Source</th><th>Schedule</th><th>To</th><th class="num">Expected</th><th>Next</th><th></th></tr></thead><tbody>
{#each v.income as s (s.id)}
	<tr class:muted={!s.active}><td>{s.name}</td><td class="small">{schedule(s)}</td><td>{s.depositAccountName}</td><td class="num"><Money cents={s.expectedAmount} /></td>
		<td>{#if s.next}{s.next.dueDate} <span class="status {s.next.status}">{s.next.status}</span>{:else}<span class="muted">—</span>{/if}</td>
		<td><button class="small" onclick={() => (editing = fromIncome(s))}>edit</button> <button class="small" onclick={() => (open[`i${s.id}`] = !open[`i${s.id}`])}>{open[`i${s.id}`] ? 'hide' : 'history'}</button></td></tr>
	{#if open[`i${s.id}`]}<tr><td colspan="6">{@render history('income', s.history)}</td></tr>{/if}
{:else}<tr><td colspan="6" class="muted">No income sources yet.</td></tr>{/each}
</tbody></table>

{#if editing}<DefinitionForm kind={editing.kind} def={editing.def} tree={data.tree} accounts={v.accounts} cadences={v.cadences} onsave={save} onclose={() => (editing = null)} />{/if}
```
The "linked" anchor should point at the ledger filtered to those ids; the ledger has no id filter, so make it `href="/ledger?q="` with the title showing ids, or better: add `ids` (comma-separated) to `LedgerFilter` in Task 6's read model if you reach this task with time — otherwise keep the title-only link and note it in the report. The "unskip" path calls `unmark` which resets a skipped occurrence to pending; that matches `unmarkOccurrence`'s behaviour.

- [ ] **Step 4: Verify** — `npx vitest run`, `npm run check` 0 errors, `npm run build`, dev smoke `curl -s localhost:5173/bills | grep -c 'Bills & income'` → `1`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/bills
git commit -m "feat: bills page with definitions, occurrence history, and manual marks"
```

---

### Task 14: Nightly backup, clean shutdown, and the deferred small fixes

**Files:**
- Create: `src/lib/server/backup.ts`, `src/lib/server/backup.test.ts`
- Modify: `src/lib/server/config.ts` (+ `config.test.ts`), `src/lib/server/sync/scheduler.ts` (+ test), `src/lib/server/sync/providers/index.ts` (`cronExpressions`), `src/hooks.server.ts`, `src/lib/server/db/index.ts` (+ `migrations.test.ts` or `db.test.ts`), `src/routes/api/plaid/link-token/+server.ts` (+ `sync.test.ts`), `.env.example`, every test `cfg()` literal (`startup.test.ts`, `health.test.ts`, `sync.test.ts`, and the 1C harnesses)

**Interfaces:**
- Produces:
  - `Config.backupHour: number` from `SHISO_BACKUP_HOUR` (default `4`), validated like the other hours; `Config.backupKeep: number` from `SHISO_BACKUP_KEEP` (default `30`, integer ≥ 1).
  - `backupDatabase(sqlite: Database.Database, dir: string, todayIso: string): string` — `VACUUM INTO '<dir>/shiso-<todayIso>.db'`; if the file exists, removes it first (one backup per day, latest wins); creates `dir`; returns the path.
  - `pruneBackups(dir: string, keep: number): string[]` — deletes the oldest `shiso-YYYY-MM-DD.db` files beyond `keep`, ignores `pre-migration-*` snapshots, returns deleted paths.
  - `cronExpressions(config)` gains `backup: '0 ${backupHour} * * *'`; `startScheduler` schedules a third task `shiso-backup` that runs `backupDatabase` then `pruneBackups` and logs the path.
  - `hooks.server.ts` registers `SIGTERM`/`SIGINT` once: stop the scheduler, `closeDb()`, `process.exit(0)`. A module-level `started` flag prevents a second `init` (Vite HMR) from starting a second scheduler.
  - `openDatabase` closes the SQLite handle when the snapshot or migration throws (1A deferral).
  - `/api/plaid/link-token` returns 404 for an unknown `connectionId` (1B deferral): call `getConnection` before `getCredential`.
  - `@types/better-sqlite3`: `better-sqlite3` 13 does not ship types, so keep the package but align it: `npm install -D @types/better-sqlite3@latest` and record the version in the report. If `npm run check` shows new errors from the bump, revert and note it.

- [ ] **Step 1: Failing tests**

`src/lib/server/backup.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { backupDatabase, pruneBackups } from './backup';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shiso-backup-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
describe('backupDatabase', () => {
	it('writes a dated copy that opens as a database, replacing a same-day file', () => {
		const db = new Database(join(dir, 'live.db')); db.exec('create table t (x); insert into t values (1)');
		const out = join(dir, 'bk');
		const p1 = backupDatabase(db, out, '2026-09-08'); expect(p1).toBe(join(out, 'shiso-2026-09-08.db'));
		db.exec('insert into t values (2)');
		const p2 = backupDatabase(db, out, '2026-09-08'); expect(p2).toBe(p1);
		const copy = new Database(p2, { readonly: true }); expect(copy.prepare('select count(*) as n from t').get()).toEqual({ n: 2 }); copy.close(); db.close();
	});
});
describe('pruneBackups', () => {
	it('keeps the newest N dated backups and never touches migration snapshots', () => {
		for (const d of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']) writeFileSync(join(dir, `shiso-${d}.db`), '');
		writeFileSync(join(dir, 'pre-migration-2026-09-01T00-00-00-000Z-0001.db'), '');
		const deleted = pruneBackups(dir, 2);
		expect(deleted.map((p) => p.split('/').pop())).toEqual(['shiso-2026-09-01.db', 'shiso-2026-09-02.db']);
		expect(readdirSync(dir).sort()).toEqual(['pre-migration-2026-09-01T00-00-00-000Z-0001.db', 'shiso-2026-09-03.db', 'shiso-2026-09-04.db']);
		expect(existsSync(join(dir, 'shiso-2026-09-04.db'))).toBe(true);
	});
});
```
Append to `config.test.ts`: defaults `backupHour === 4`, `backupKeep === 30`; `SHISO_BACKUP_HOUR: '25'` throws; `SHISO_BACKUP_KEEP: '0'` throws.
Append to `scheduler.test.ts`: `cronExpressions` includes `backup: '0 4 * * *'`, and `startScheduler` creates three tasks (extend the existing fake to count `schedule` calls) and `stop()` destroys all three.
Append to `db` tests (`src/lib/server/db/migrations.test.ts` or a new `index.test.ts`): opening with `backupDir` pointing at a regular file (so `VACUUM INTO` fails) on a database that has pending migrations throws AND leaves no open handle — assert by opening the same path again with `new Database(path)` in exclusive mode succeeding (`db.pragma('locking_mode = EXCLUSIVE'); db.exec('begin exclusive'); db.exec('commit'); db.close()`).
Append to `sync.test.ts`: `linkToken` with `{ connectionId: 999 }` under a configured fake Plaid provider returns 404 (use `setSyncDepsForTests({ providers: { plaid: fake }, … })` plus `setConfig` with `plaid: { clientId: 'id', secret: 's', env: 'sandbox' }`; `plaidClient` builds a real client object without a network call, and the route must 404 before it would use it).

- [ ] **Step 2: Run to verify they fail**, then implement

`src/lib/server/backup.ts`:
```ts
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
const DATED = /^shiso-(\d{4}-\d{2}-\d{2})\.db$/;
/** §3.1: a dated `VACUUM INTO` copy; one per calendar day, the later run wins. */
export function backupDatabase(sqlite: Database.Database, dir: string, todayIso: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `shiso-${todayIso}.db`);
	if (existsSync(path)) rmSync(path);
	sqlite.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
	return path;
}
export function pruneBackups(dir: string, keep: number): string[] {
	if (!existsSync(dir)) return [];
	const dated = readdirSync(dir).filter((f) => DATED.test(f)).sort();
	const doomed = dated.slice(0, Math.max(0, dated.length - keep));
	for (const f of doomed) rmSync(join(dir, f));
	return doomed.map((f) => join(dir, f));
}
```
`config.ts`: add `backupHour: hour(env, 'SHISO_BACKUP_HOUR', 4)` and
```ts
function positiveInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
	const raw = env[key]; if (raw === undefined || raw === '') return fallback;
	const n = Number(raw); if (!Number.isInteger(n) || n < 1) throw new Error(`${key} must be a positive integer, got ${JSON.stringify(raw)}`); return n;
}
// backupKeep: positiveInt(env, 'SHISO_BACKUP_KEEP', 30)
```
`providers/index.ts`: `cronExpressions(config: Pick<Config, 'syncHour' | 'balanceHour' | 'backupHour'>)` returns `{ full, balances, backup }`.
`scheduler.ts`: accept `sqlite: Database.Database` and `config: Pick<Config, 'syncHour' | 'balanceHour' | 'backupHour' | 'timeZone' | 'backupDir' | 'backupKeep'>`; third task:
```ts
const backup = cron.schedule(exprs.backup, () => {
	const path = backupDatabase(opts.sqlite, opts.config.backupDir, todayIso(opts.config.timeZone));
	const pruned = pruneBackups(opts.config.backupDir, opts.config.backupKeep);
	log(`backup written: ${path}${pruned.length ? `; pruned ${pruned.length}` : ''}`);
}, { ...common, name: 'shiso-backup' });
return { stop() { full.destroy(); balances.destroy(); backup.destroy(); } };
```
`hooks.server.ts`:
```ts
let started = false;
export const init: ServerInit = async () => {
	if (building || started) return;
	started = true;
	// … existing startup …
	let scheduler: { stop(): void } | null = null;
	if (config.schedulerEnabled) { scheduler = startScheduler({ db: getDb(), sqlite: getSqlite(), config, deps }); console.log(…); }
	const shutdown = (signal: string) => { console.log(`[shiso] ${signal}: stopping`); scheduler?.stop(); closeDb(); process.exit(0); };
	process.once('SIGTERM', () => shutdown('SIGTERM'));
	process.once('SIGINT', () => shutdown('SIGINT'));
};
```
`db/index.ts`: wrap the snapshot and `migrate` calls in `try { … } catch (err) { sqlite.close(); throw err; }` (keep the existing snapshot-cleanup behaviour inside).
`link-token/+server.ts`: `if (body?.connectionId) { getConnection(getDb(), Number(body.connectionId)); … }` before `getCredential`, wrapped by `handle` so the "not found" message maps to 404 (convert this route to `handle` while you are there; keep its 400 for "plaid not configured" as a `ValidationError`).
`.env.example`: append
```
# Local hour (0-23) for the nightly VACUUM INTO backup, and how many dated backups to keep.
SHISO_BACKUP_HOUR=4
SHISO_BACKUP_KEEP=30
```
Update every `cfg()` literal in tests with `backupHour: 4, backupKeep: 30`.

- [ ] **Step 3: Run to verify they pass**; `npm run check` 0 errors; `npm run build`; smoke: start `node build` against a scratch DB with `SHISO_SCHEDULER=on`, confirm the log line lists the backup hour, send `SIGTERM`, confirm the process exits 0 within 2 seconds and the log shows the stop line. Include the log lines in the report.

- [ ] **Step 4: Commit**

```bash
git add src/lib/server/backup.ts src/lib/server/backup.test.ts src/lib/server/config.ts src/lib/server/config.test.ts src/lib/server/sync/scheduler.ts src/lib/server/sync/scheduler.test.ts src/lib/server/sync/providers/index.ts src/lib/server/sync/providers/index.test.ts src/hooks.server.ts src/lib/server/db src/routes/api/plaid/link-token src/routes/api/sync/sync.test.ts src/lib/server/startup.test.ts src/routes/api/health/health.test.ts src/routes .env.example package.json package-lock.json
git commit -m "feat: nightly backup job, clean shutdown, and the deferred handle, relink, and hmr fixes"
```

---

### Task 15: Deployment kit — release script, systemd unit, Caddy vhost, runbook

**Files:**
- Create: `scripts/release.sh`, `deploy/install.sh`, `deploy/shiso.service`, `deploy/shiso.env.example`, `deploy/Caddyfile.snippet`, `docs/deploy.md`, `deploy/deploy.test.ts`
- Modify: `package.json` (`"release": "bash scripts/release.sh"`), `.gitignore` (`dist/`)

**Interfaces:**
- `scripts/release.sh` (run on the Mac): `npm ci`, `npm test`, `npm run check`, `npm run build`, then `tar -czf dist/shiso-<git sha>.tar.gz build drizzle package.json package-lock.json deploy` and prints the path. Exits non-zero if the tree is dirty unless `--allow-dirty`.
- `deploy/install.sh` (run as root on the LXC, `install.sh <tarball>`): creates user `shiso` (system, no login) and `/opt/shiso/{releases,data,backups}`; unpacks into `/opt/shiso/releases/<sha>`; runs `npm ci --omit=dev` there; points the `/opt/shiso/current` symlink at it; installs `deploy/shiso.service` to `/etc/systemd/system/` if missing; creates `/etc/shiso/shiso.env` from `shiso.env.example` if missing (mode 600, owner shiso) and prints a reminder to fill it; `systemctl daemon-reload && systemctl enable --now shiso && systemctl restart shiso`; waits up to 20 seconds for `curl -sf localhost:3000/api/health` and prints its body; on failure prints `journalctl -u shiso -n 50` and exits 1. Keeps the last 3 releases.
- `deploy/shiso.service`:
```ini
[Unit]
Description=shiso personal finance dashboard
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
User=shiso
Group=shiso
WorkingDirectory=/opt/shiso/current
EnvironmentFile=/etc/shiso/shiso.env
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOST=127.0.0.1
ExecStart=/usr/bin/node /opt/shiso/current/build
Restart=on-failure
RestartSec=30
KillSignal=SIGTERM
TimeoutStopSec=15
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/shiso/data /opt/shiso/backups
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```
- `deploy/shiso.env.example`: every variable from `.env.example` with production values: `SHISO_DB_PATH=/opt/shiso/data/shiso.db`, `SHISO_BACKUP_DIR=/opt/shiso/backups`, `SHISO_MIGRATIONS_DIR=/opt/shiso/current/drizzle`, `SHISO_TZ=America/New_York`, `SHISO_SCHEDULER=on`, `PLAID_ENV=production`, `ORIGIN=http://shiso.home.local` (adapter-node needs `ORIGIN` for form posts behind a proxy), blanks for secrets, and a comment that `SHISO_APP_KEY` is generated with `openssl rand -base64 48`.
- `deploy/Caddyfile.snippet`:
```
shiso.home.local {
	reverse_proxy 10.10.50.<CT-IP>:3000
}
```
with `HOST=0.0.0.0` noted as required in the unit when Caddy is on another container (it is: CT 130). Set `HOST=0.0.0.0` in the unit and note in the runbook that the services VLAN is the trust boundary.
- `docs/deploy.md` runbook sections: 1. Create the LXC (Debian 12, services VLAN 10.10.50.x, 1 vCPU, 1 GB, 8 GB disk, unprivileged, PBS backup job included); 2. Node 24 via NodeSource on the container; 3. First release (`npm run release` on the Mac, `scp` to the container, `bash deploy/install.sh <tarball>`); 4. Fill `/etc/shiso/shiso.env` (Plaid production keys, app key, TZ) and `systemctl restart shiso`; 5. Caddy: add the snippet to CT 130's Caddyfile and reload; Pi-hole `custom.list` on CT 101 gets `10.10.50.<ip> shiso.home.local`; 6. Verify: `curl -s http://shiso.home.local/api/health`, `journalctl -u shiso -f` for the scheduler line; 7. Upgrade: rerun steps 3 (install.sh handles symlink swap, restart, health check); 8. Restore: stop the service, copy a `shiso-YYYY-MM-DD.db` over `data/shiso.db` (or restore the container from PBS), start; 9. Tailscale: reach `shiso.home.local` via the CT 123 exit node with no app auth (spec §3.1). Secrets never leave `/etc/shiso/shiso.env`; nothing in the tarball contains them.
- `deploy/deploy.test.ts` (vitest, node): parses `deploy/shiso.service` and asserts `Restart=on-failure`, `RestartSec=30`, `StartLimitBurst=5`, `EnvironmentFile=/etc/shiso/shiso.env`, `ReadWritePaths` includes `/opt/shiso/data`; asserts `bash -n scripts/release.sh` and `bash -n deploy/install.sh` exit 0 (`execFileSync('bash', ['-n', path])`); asserts every `SHISO_`/`PLAID_` key in `.env.example` appears in `deploy/shiso.env.example`.

- [ ] **Step 1: Write the test first**, run it (fails: files missing).
- [ ] **Step 2: Write the five files and the runbook** as specified. The install script must be idempotent (re-running on the same tarball is safe) and must `set -euo pipefail`.
- [ ] **Step 3: Verify** — `npx vitest run deploy`, `npm run release -- --allow-dirty` produces a tarball (list its contents in the report with `tar -tzf`), then `rm -rf dist`. Add `dist/` to `.gitignore`.
- [ ] **Step 4: Commit**

```bash
git add scripts/release.sh deploy docs/deploy.md package.json .gitignore
git commit -m "feat: release tarball, systemd unit, install script, caddy vhost, and deployment runbook"
```

---

### Task 16: Sheet import — migration, parser, importer, script

**Files:**
- Create: `drizzle/0002_account_opened_on.sql` (+ `drizzle/meta` journal entry via `npm run db:generate`), `src/lib/server/import/sheet.ts`, `src/lib/server/import/sheet.test.ts`, `scripts/import-sheet.ts`, `scripts/README-sheet-import.md`
- Modify: `src/lib/server/db/schema.ts` (`accounts.openedOn`), `src/lib/server/sync/connections.ts` (`updateAccount` accepts `openedOn`), `package.json` (devDependencies `xlsx`, `tsx`; script `"import:sheet": "tsx scripts/import-sheet.ts"`)

**Interfaces:**
- Schema: `accounts.opened_on text null` (ISO date the account was opened; spec §11 "open date from the tab").
- Parser (pure, no I/O; a tab is a grid of cell strings):
```ts
export type Cell = string | number | null | undefined;
export type Grid = Cell[][];
export type TabDebt = { name: string; balance: number /* cents, owed is negative */; aprBps: number | null; annualFee: number | null; openedOn: string | null };
export type ParsedTab = { checking: number | null; debts: TabDebt[] };
export function parseTab(grid: Grid): ParsedTab
export function periodEndForTab(tabName: string, year: number): string | null   // "PP 7" → 7th semi-monthly period end; "4/1 - 4/15" → "YYYY-04-15"; else null
export function importSheet(db: DbOrTx, tabs: { name: string; grid: Grid }[], opts: { year: number; mapping: Record<string, number>; checkingAccountId: number | null }): ImportReport
export type ImportReport = { tabs: { name: string; date: string; balances: number; terms: number; skipped: string[] }[]; unmapped: string[]; ignoredTabs: string[] };
```
Parser rules (from the sheet's layout): find the header row containing a cell `Balance` followed on the same row by `Int. Charges`, `Int. Rate`, `Daily Int.`, `Monthly Int.`, `Yearly Int.`, `Ann. Fee` (the 'Balances' block). Let `nameCol = balanceCol − 1`, `rateCol = balanceCol + 2`, `feeCol = balanceCol + 6`, `dateCol = balanceCol + 7`. For every row below the header until a row whose `nameCol` is empty AND `balanceCol` is empty for two consecutive rows: `name = trim(cell[nameCol])`, skip when empty or when it starts with `[merged]`; `balance = decimalToCents(cell[balanceCol])` where accounting-style `$ (1,234.56)` is negative and `$ -` is 0 (treat empty as 0); `aprBps = round(parseFloat(rate without %) × 100)` or null when empty; `annualFee = decimalToCents(fee)` or null when empty/`$ -`; `openedOn` from `M/D/YY` → `20YY-MM-DD` (two-digit years < 70 → 20YY, else 19YY), null when empty. `checking`: the first cell anywhere in the grid whose trimmed text is exactly `Checking` with a parsable money value in the cell to its right; null when absent. Numbers may arrive as JS numbers (xlsx parses currency cells) — accept both strings and numbers (`decimalToCents` handles numbers).
Importer rules (§11): for each tab with a resolvable period end date `d` (sorted by `d`): for each debt whose `name` is in `mapping` → `appendBalance(accountId, { asOf: d, current: balance, source: 'import' })`; if `aprBps` differs from the previous tab's APR for that account (or there is no previous tab), `appendTermsIfChanged(accountId, { asOf: d, aprBps, annualFee, source: 'manual' })`; if `openedOn` is set and the account's `opened_on` is null, `updateAccount(accountId, { openedOn })`. `checking` → `appendBalance(checkingAccountId, …, source: 'import')` when both are set. Unmapped names are collected once. Re-running is idempotent for balances: before inserting, skip when a balance row with the same `account_id`, `as_of`, `source = 'import'` and `current` already exists (query `account_balances`). Terms use `appendTermsIfChanged` semantics but with `source: 'manual'`, which always inserts; guard with the same "already exists for as_of" check so re-runs do not duplicate.

- [ ] **Step 1: Failing tests**

`src/lib/server/import/sheet.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { fixture } from '../test/fixture';
import { accounts, accountBalances, accountTerms } from '../db/schema';
import { parseTab, periodEndForTab, importSheet, type Grid } from './sheet';

const header = (offset: number) => { const r: (string | null)[] = Array(offset + 8).fill(null); r[offset + 1] = 'Balance'; r[offset + 2] = 'Int. Charges'; r[offset + 3] = 'Int. Rate'; r[offset + 4] = 'Daily Int.'; r[offset + 5] = 'Monthly Int.'; r[offset + 6] = 'Yearly Int.'; r[offset + 7] = 'Ann. Fee'; return r; };
const debt = (offset: number, name: string, bal: string, rate: string, fee: string, open: string) => { const r: (string | null)[] = Array(offset + 9).fill(null); r[offset] = name; r[offset + 1] = bal; r[offset + 3] = rate; r[offset + 7] = fee; r[offset + 8] = open; return r; };
function tab(offset = 15): Grid {
	return [
		['8', null], [null, 'Pay Period Days', '11'],
		header(offset),
		debt(offset, 'Sweetwater', '$ (419.99)', '34.99%', '$ -', '6/20/14'),
		[null, 'Water', '$ (113.23)', null, null, null, null, null, null, null, null, 'Checking', '$ 3,699.13', ...Array(offset - 11).fill(null), 'Sapphire', '$ (11,179.26)', '$ (11,179.26)', '27.74%', '$ (8.50)', '$ (254.89)', '$ (3,058.65)', '$ 95.00', '7/11/18'],
		debt(offset, 'Apple', '', '26.49%', '', '8/31/07'),
		debt(offset, '[merged] Credit Cards', '', '', '', ''),
		Array(offset + 9).fill(null), Array(offset + 9).fill(null)
	];
}
describe('parseTab', () => {
	it('reads the balances block by header, checking by label, and normalises money, rate, and dates', () => {
		const p = parseTab(tab());
		expect(p.checking).toBe(369913);
		expect(p.debts).toEqual([
			{ name: 'Sweetwater', balance: -41999, aprBps: 3499, annualFee: null, openedOn: '2014-06-20' },
			{ name: 'Sapphire', balance: -1117926, aprBps: 2774, annualFee: 9500, openedOn: '2018-07-11' },
			{ name: 'Apple', balance: 0, aprBps: 2649, annualFee: null, openedOn: '2007-08-31' }
		]);
		expect(parseTab(tab(13)).debts.map((d) => d.name)).toEqual(['Sweetwater', 'Sapphire', 'Apple']);   // column offset differs per tab
	});
});
describe('periodEndForTab', () => {
	it('maps PP numbers and date ranges to semi-monthly period ends', () => {
		expect(periodEndForTab('PP 1', 2026)).toBe('2026-01-15'); expect(periodEndForTab('PP 2', 2026)).toBe('2026-01-31');
		expect(periodEndForTab('PP 4', 2026)).toBe('2026-02-28'); expect(periodEndForTab('4/1 - 4/15', 2026)).toBe('2026-04-15');
		expect(periodEndForTab('7/16-7/31', 2026)).toBe('2026-07-31'); expect(periodEndForTab('Summary', 2026)).toBeNull();
	});
});
describe('importSheet', () => {
	it('writes import balances, manual terms on APR change, opened_on once, and is idempotent', () => {
		const f = fixture();
		const t1 = tab(); const t2 = tab(); t2[3] = debt(15, 'Sweetwater', '$ (361.99)', '34.99%', '$ -', '6/20/14'); t2[4][16] = '$ (11,658.63)'; t2[4][18] = '27.49%';
		const tabs = [{ name: 'PP 2', grid: t2 }, { name: 'PP 1', grid: t1 }, { name: 'Summary', grid: [['x']] }];
		const r = importSheet(f.db, tabs, { year: 2026, mapping: { Sapphire: f.card }, checkingAccountId: f.checking });
		expect(r.ignoredTabs).toEqual(['Summary']); expect(r.unmapped.sort()).toEqual(['Apple', 'Sweetwater']);
		expect(r.tabs.map((t) => [t.name, t.date, t.balances, t.terms])).toEqual([['PP 1', '2026-01-15', 2, 1], ['PP 2', '2026-01-31', 2, 1]]);
		const bals = f.db.select().from(accountBalances).where(eq(accountBalances.accountId, f.card)).all();
		expect(bals.map((b) => [b.asOf, b.current, b.source])).toEqual([['2026-01-15', -1117926, 'import'], ['2026-01-31', -1165863, 'import']]);
		const terms = f.db.select().from(accountTerms).where(eq(accountTerms.accountId, f.card)).all();
		expect(terms.map((t) => [t.asOf, t.aprBps, t.annualFee, t.source])).toEqual([['2026-01-15', 2774, 9500, 'manual'], ['2026-01-31', 2749, 9500, 'manual']]);
		expect(f.db.select().from(accounts).where(eq(accounts.id, f.card)).get()!.openedOn).toBe('2018-07-11');
		expect(f.db.select().from(accountBalances).where(eq(accountBalances.accountId, f.checking)).all().map((b) => b.current)).toEqual([369913, 369913]);
		importSheet(f.db, tabs, { year: 2026, mapping: { Sapphire: f.card }, checkingAccountId: f.checking });
		expect(f.db.select().from(accountBalances).all()).toHaveLength(4); expect(f.db.select().from(accountTerms).all()).toHaveLength(2);
	});
});
```

- [ ] **Step 2: Migration and schema**

Add to `schema.ts` `accounts`: `openedOn: text('opened_on'),`. Run `npm run db:generate` and rename the produced file to `drizzle/0002_account_opened_on.sql` (keep the journal entry consistent; drizzle-kit names go in `drizzle/meta/_journal.json`). The SQL must be exactly `ALTER TABLE \`accounts\` ADD \`opened_on\` text;`. Extend `updateAccount`'s patch with `openedOn?: string | null`. Run the migration tests (`migrations.test.ts`) to confirm the pending count is 3 on a fresh file.

- [ ] **Step 3: Run tests to verify they fail**, then implement `sheet.ts`

```ts
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, accountBalances, accountTerms } from '../db/schema';
import { appendBalance, latestTerms, updateAccount } from '../sync/connections';
import { decimalToCents } from '$lib/money';
import { endOfMonth } from '$lib/dates';

export type Cell = string | number | null | undefined; export type Grid = Cell[][];
export type TabDebt = { name: string; balance: number; aprBps: number | null; annualFee: number | null; openedOn: string | null };
export type ParsedTab = { checking: number | null; debts: TabDebt[] };
export type ImportReport = { tabs: { name: string; date: string; balances: number; terms: number; skipped: string[] }[]; unmapped: string[]; ignoredTabs: string[] };

const HEADER = ['Balance', 'Int. Charges', 'Int. Rate', 'Daily Int.', 'Monthly Int.', 'Yearly Int.', 'Ann. Fee'];
const text = (c: Cell) => (c == null ? '' : String(c).trim());
/** `$ (1,234.56)` → -123456; `$ -` or empty → null; numbers pass through. */
export function money(c: Cell): number | null {
	if (typeof c === 'number') return decimalToCents(c);
	const s = text(c); if (s === '' || /^\$?\s*-\s*$/.test(s)) return null;
	return decimalToCents(s);
}
export function rateBps(c: Cell): number | null { if (typeof c === 'number') return Math.round(c * 10000); const s = text(c).replace('%', ''); return s === '' ? null : Math.round(parseFloat(s) * 100); }
export function usDate(c: Cell): string | null {
	const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text(c)); if (!m) return null;
	const y = m[3].length === 4 ? +m[3] : +m[3] < 70 ? 2000 + +m[3] : 1900 + +m[3];
	return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
export function parseTab(grid: Grid): ParsedTab {
	let headerRow = -1, balanceCol = -1;
	for (let r = 0; r < grid.length && headerRow < 0; r++) {
		const row = grid[r] ?? [];
		for (let c = 0; c < row.length; c++) if (HEADER.every((h, i) => text(row[c + i]) === h)) { headerRow = r; balanceCol = c; break; }
	}
	const debts: TabDebt[] = [];
	if (headerRow >= 0) {
		const nameCol = balanceCol - 1; let blank = 0;
		for (let r = headerRow + 1; r < grid.length; r++) {
			const row = grid[r] ?? []; const name = text(row[nameCol]);
			if (name === '' && text(row[balanceCol]) === '') { if (++blank >= 2) break; continue; }
			blank = 0;
			if (name === '' || name.startsWith('[merged]') || name.startsWith('\\[merged')) continue;
			debts.push({ name, balance: money(row[balanceCol]) ?? 0, aprBps: rateBps(row[balanceCol + 2]), annualFee: money(row[balanceCol + 6]), openedOn: usDate(row[balanceCol + 7]) });
		}
	}
	let checking: number | null = null;
	outer: for (const row of grid) for (let c = 0; c < (row?.length ?? 0); c++) if (text(row[c]) === 'Checking') { const v = money(row[c + 1]); if (v != null) { checking = v; break outer; } }
	return { checking, debts };
}
export function periodEndForTab(tabName: string, year: number): string | null {
	const pp = /^PP\s*(\d{1,2})$/i.exec(tabName.trim());
	if (pp) { const n = +pp[1]; if (n < 1 || n > 24) return null; const month = String(Math.ceil(n / 2)).padStart(2, '0'); return n % 2 === 1 ? `${year}-${month}-15` : endOfMonth(`${year}-${month}-01`); }
	const range = /(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})/.exec(tabName);
	if (range) return `${year}-${range[3].padStart(2, '0')}-${range[4].padStart(2, '0')}`;
	return null;
}
export function importSheet(db: DbOrTx, tabs: { name: string; grid: Grid }[], opts: { year: number; mapping: Record<string, number>; checkingAccountId: number | null }): ImportReport {
	const dated = tabs.map((t) => ({ ...t, date: periodEndForTab(t.name, opts.year) })).filter((t): t is typeof t & { date: string } => t.date != null).sort((a, b) => a.date.localeCompare(b.date));
	const ignoredTabs = tabs.filter((t) => periodEndForTab(t.name, opts.year) == null).map((t) => t.name);
	const unmapped = new Set<string>(); const lastApr = new Map<number, number | null>(); const report: ImportReport['tabs'] = [];
	const hasBalance = (accountId: number, asOf: string, current: number) => !!db.select({ id: accountBalances.id }).from(accountBalances).where(and(eq(accountBalances.accountId, accountId), eq(accountBalances.asOf, asOf), eq(accountBalances.source, 'import'), eq(accountBalances.current, current))).get();
	const hasTerms = (accountId: number, asOf: string) => !!db.select({ id: accountTerms.id }).from(accountTerms).where(and(eq(accountTerms.accountId, accountId), eq(accountTerms.asOf, asOf), eq(accountTerms.source, 'manual'))).get();
	for (const t of dated) {
		const p = parseTab(t.grid); let balances = 0, terms = 0; const skipped: string[] = [];
		for (const d of p.debts) {
			const accountId = opts.mapping[d.name]; if (accountId == null) { unmapped.add(d.name); continue; }
			if (!hasBalance(accountId, t.date, d.balance)) { appendBalance(db, accountId, { asOf: t.date, current: d.balance, source: 'import' }); balances++; } else skipped.push(`${d.name} balance`);
			const prevApr = lastApr.has(accountId) ? lastApr.get(accountId) : (latestTerms(db, accountId)?.aprBps ?? undefined);
			if (d.aprBps != null && d.aprBps !== prevApr) {
				if (!hasTerms(accountId, t.date)) { db.insert(accountTerms).values({ accountId, asOf: t.date, aprBps: d.aprBps, annualFee: d.annualFee, source: 'manual' }).run(); terms++; } else skipped.push(`${d.name} terms`);
			}
			lastApr.set(accountId, d.aprBps);
			if (d.openedOn && db.select({ o: accounts.openedOn }).from(accounts).where(eq(accounts.id, accountId)).get()?.o == null) updateAccount(db, accountId, { openedOn: d.openedOn });
		}
		if (p.checking != null && opts.checkingAccountId != null) { if (!hasBalance(opts.checkingAccountId, t.date, p.checking)) { appendBalance(db, opts.checkingAccountId, { asOf: t.date, current: p.checking, source: 'import' }); balances++; } else skipped.push('Checking balance'); }
		report.push({ name: t.name, date: t.date, balances, terms, skipped });
	}
	return { tabs: report, unmapped: [...unmapped], ignoredTabs };
}
```
`accountTerms` is written directly here because `appendTermsIfChanged` with `source: 'manual'` always inserts and would not carry the idempotency guard; this is the one place outside `connections.ts` that inserts terms, and it is a one-time script's library, so note it in the report. (If you prefer, add an `appendTermsAt` helper to `connections.ts` and call it; either is acceptable.)

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Script**

Install: `npm install -D xlsx tsx` (versions: `xlsx` 0.18.x from npm, `tsx` 4.x). `scripts/import-sheet.ts`:
```ts
#!/usr/bin/env tsx
// One-time import of the pay-period Google Sheet (spec §11). Usage:
//   npx tsx scripts/import-sheet.ts --db ./data/shiso.db --xlsx ~/Downloads/budget.xlsx --year 2025 --mapping ./mapping.json [--checking 3] [--dry-run]
// mapping.json: { "Sapphire": 4, "Freedom": 5, ... }  (sheet name → shiso account id; see /accounts)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import * as XLSX from 'xlsx';
import { openDatabase } from '../src/lib/server/db';
import { importSheet, parseTab, periodEndForTab, type Grid } from '../src/lib/server/import/sheet';

const { values } = parseArgs({ options: { db: { type: 'string' }, xlsx: { type: 'string' }, year: { type: 'string' }, mapping: { type: 'string' }, checking: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
if (!values.db || !values.xlsx || !values.year || !values.mapping) { console.error('required: --db --xlsx --year --mapping'); process.exit(2); }
const wb = XLSX.readFile(values.xlsx);
const tabs = wb.SheetNames.map((name) => ({ name, grid: XLSX.utils.sheet_to_json<Grid[number]>(wb.Sheets[name], { header: 1, raw: false, defval: null }) as Grid }));
const year = Number(values.year); const mapping = JSON.parse(readFileSync(values.mapping, 'utf8')) as Record<string, number>;
if (values['dry-run']) {
	for (const t of tabs) { const d = periodEndForTab(t.name, year); if (!d) { console.log(`ignore  ${t.name}`); continue; } const p = parseTab(t.grid); console.log(`${d}  ${t.name}: checking=${p.checking} debts=${p.debts.map((x) => `${x.name}:${x.balance}@${x.aprBps}`).join(' ')}`); }
	process.exit(0);
}
const { db, sqlite } = openDatabase({ path: values.db, backupDir: join(dirname(values.db), 'backups'), migrationsFolder: 'drizzle' });
const report = db.transaction((tx) => importSheet(tx, tabs, { year, mapping, checkingAccountId: values.checking ? Number(values.checking) : null }));
sqlite.close();
console.log(JSON.stringify(report, null, 2));
```
`raw: false` makes xlsx hand back formatted strings (`$ (1,234.56)`, `27.74%`, `6/20/14`), which is what the parser expects. `$lib/money` and `$lib/dates` resolve under `tsx` through the SvelteKit-generated `tsconfig` paths (`npm run prepare` must have run); `src/lib/server/db/index.ts` has no `$app`/`$env` imports. Confirm `npx tsx scripts/import-sheet.ts --help` style invocation fails with the "required" message and exit code 2 (that is the smoke test; no real sheet is needed). Write `scripts/README-sheet-import.md`: export the Google Sheet as `.xlsx` (File → Download → Microsoft Excel), one workbook per year, tab names as in the sheet (`PP 1` … or `M/D - M/D`), build `mapping.json` from the Accounts page ids, run with `--dry-run` first, then for real; run once per year file; re-runs are safe.

- [ ] **Step 6: Verify** — `npx vitest run`, `npm run check` 0 errors (the script is outside `src/`; if `svelte-check` complains about `scripts/`, exclude it in `tsconfig.json` `exclude` and type-check the script with `npx tsc --noEmit -p tsconfig.scripts.json` where that file extends the root config and includes only `scripts/**`; add that command to the report).

- [ ] **Step 7: Commit**

```bash
git add drizzle src/lib/server/db/schema.ts src/lib/server/sync/connections.ts src/lib/server/import scripts/import-sheet.ts scripts/README-sheet-import.md package.json package-lock.json tsconfig.json tsconfig.scripts.json
git commit -m "feat: one-time sheet import of period balances, apr history, and account open dates"
```

---

### Task 17: README, env example, and the production smoke

**Files:**
- Modify: `README.md` (rewrite), `.env.example` (review every key has a comment), `docs/superpowers/plans/2026-09-08-shiso-1c-screens.md` (tick boxes are the executor's; do not edit the plan body)

- [x] **Step 1: README** covering: what shiso is (two sentences from spec §1); requirements (Node 24, no Docker); development (`cp .env.example .env`, generate `SHISO_APP_KEY`, `npm install`, `npm run dev`, `npm test`, `npm run check`); the six pages in one line each; data model summary (integer cents, sign convention, periods, envelopes; link to the spec); providers (Plaid Trial 10-Item cap; SimpleFIN; manual + Apple Card CSV); sync schedule and env knobs (`SHISO_SYNC_HOUR`, `SHISO_BALANCE_HOUR`, `SHISO_BACKUP_HOUR`, `SHISO_BACKUP_KEEP`, `SHISO_TZ`, `SHISO_CADENCE`, `SHISO_SCHEDULER`, `SHISO_MIGRATIONS_DIR`); operations (health route, backups, restore, migrations snapshot behaviour); deployment (link to `docs/deploy.md`); sheet import (link to `scripts/README-sheet-import.md`); the Phase 1 gaps from spec §12 in one list; layout of `src/`. No secrets, no session or tooling references.

- [x] **Step 2: Production smoke.** `npm run build`, then in the background `SHISO_DB_PATH=/tmp/shiso-smoke/shiso.db SHISO_BACKUP_DIR=/tmp/shiso-smoke/backups SHISO_APP_KEY=$(openssl rand -base64 48) SHISO_SCHEDULER=off SHISO_MIGRATIONS_DIR=$PWD/drizzle PORT=3999 ORIGIN=http://localhost:3999 node build`; `curl -sf localhost:3999/api/health`, and `curl -sf -o /dev/null -w '%{http_code}\n' localhost:3999/{,budget,ledger,spending,accounts,bills}` → six `200`s; `POST /api/connections` with a manual checking account, `POST /api/accounts/<id>/balance`, then `GET /` contains the account name. Stop the server, `rm -rf /tmp/shiso-smoke`. Put the health body and the six status codes in the report.

- [x] **Step 3: Commit**

```bash
git add README.md .env.example
git commit -m "docs: readme for development, operation, deployment, and the sheet import"
```

---

## Self-review notes (author)

- **Spec coverage.** §8 Month (T3), Budget + dialogs (T4, T5), Ledger incl. review queue and payee-rule offer (T6, T7), Spending incl. compare, filters, kind toggle, drill-down (T8, T9), Accounts incl. relink, manual sync, drift + adjustment, terms edit with source, manual balance, CSV (T10, T11), Bills incl. history (T12, T13). §3.1 backup job, systemd with restart backoff, Caddy, Tailscale note, PBS (T14, T15). §3.2 SIGTERM close (T14). §9 routes call services; `InvariantError` → 409 (T1). §10 one happy + one invariant test per mutating route (T4, T5, T6, T10, T12). §11 sheet import (T16). 1B handoff: `updateAccount` (T2), README (T17), `@types/better-sqlite3` and `openDatabase` close (T14), link-token 404 and HMR guard (T14).
- **Not in this plan (named gaps, unchanged):** card-to-card transfers; cross-account `modified` events; `loan`/`line_of_credit` Plaid liabilities; matching's missing `source` filter; scheduler tick-suppression test; the Ledger has no filter by transaction ids (Bills page links by title only unless T13 adds `ids` to `LedgerFilter`).
- **Type consistency checks done:** `budgetView` uses `cardBalanceOwed`/`underfunded` keyed by account id (verified in `envelope.ts`); `spendingView` takes `cadence` (T8 Interfaces amended in text); `categoryTree` categories carry `groupId` (T5 note); `Config` gains `backupHour`/`backupKeep` (T14) and every earlier `cfg()` literal is updated there; `updateAccount` gains `openedOn` (T16).
- **Placeholders:** the `/* copy from Interfaces */` markers in T3, T4, T5, T6, T10, T12 refer to type literals fully written in each task's Interfaces block; implementers copy them verbatim.

## Handoff to Phase 2

Phase 2 (debt planner, payoff projections, promo sub-ledger) reads `account_terms` (APR history now also from the sheet import), `accounts.opened_on`, `bill_occurrences.extra_amount` (accumulates after 1B's fix wave), and `underfunded` from `budgetForPeriod`; it writes `planned_extras` (spec §4.6, table designed, not yet migrated) as assignments to payment categories with a projection attached, and adds the `balance_transfer` rule from spec §12. The Month page's "planned card payments" card is the natural home for the what-if input.

## Execution amendments (1C, 2026-09-08)

Rulings made while executing, each already reflected in the code; the task text above is the original plan:
- `Dialog` routes backdrop clicks through `el.close()` so the native `close` event is the single path to `onclose` (T1).
- Budget: `available` is the engine's gross figure and can be negative; the System group renders with only its envelope-bearing categories (Interest, Fees) — the plan's "no System group" assertion was wrong (T4).
- `categoryTree` categories carry `groupId` (T5). `spendingView` takes `cadence`; the quarter's previous range uses `addMonths` (T8).
- The transaction patch route pre-checks the period and the manual-create route maps "no period covers" to 400 (T6). Routes may read tables directly; spec §9 forbids direct writes only.
- Ledger page: the manual-add account placeholder is `null` with a submit guard; the split editor keeps a line's since-hidden category selectable (T7).
- Accounts page: `Window.Plaid` lives in `src/app.d.ts`; re-saving a closed account keeps its original `closedAt` (T11).
- Bills: the shared helper is `src/routes/api/bills/bills-shared.ts`; income "received" is status `paid`; occurrence routes 404 unknown ids; `rent.next` is null at 2026-09-08 because the horizon ends with the period after today (T12). The bills "linked" count is plain text; a Ledger `ids` filter is deferred (T13).
- Every mutating route has a happy-path and an invariant test (spec §10); the plan's test files omitted the move, account-patch, and income-patch cases (T4, T10, T12), and the final review found nine more routes with no invariant test — added in the fix wave.
- Ops: the unit ships `HOST=0.0.0.0` (Caddy is on CT 130) (T15). `tsconfig.json` carries an explicit `include` with `deploy/**/*.ts` and `scripts/**/*.ts`; `vite.config.ts` includes `deploy/**/*.test.ts` (T15, T16).
- Sheet import: the test fixture filler is `Array(offset - 13)`; `decimalToCents` accepts `$ (1,234.56)` (T16).
- Final-review fix wave: the Spending range picker's back button navigates to the resolver's previous range (it stepped by the current range's length and skipped months); stacked bars draw only positive segments and scale to the positive stack, listing refunds in a title; the split, terms, and definition dialogs surface money-parse errors instead of throwing; the health route's `lastSync` is an array with one entry per connection (spec §3.2); the deploy hardening (checksum sidecar, `npm ci` as the service user, unit re-sync) landed as its own commit — `install.sh` now refuses a tarball without its `.sha256` sidecar.
