# shiso Plan 1A: Core (schema, periods, ledger service, envelope math)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running SvelteKit process with the full Phase 1 schema, a ledger service that enforces the envelope invariants, periods that back-fill from history, and envelope math proven by hand-built scenarios and a two-way ready-to-assign property test.

**Architecture:** One Node process. Drizzle over better-sqlite3 in WAL mode owns the schema; a startup routine snapshots the database before applying pending migrations. All ledger writes go through `src/lib/server/ledger/` which runs each operation in one synchronous transaction and checks invariants. Envelope math in `src/lib/server/budget/envelope.ts` is pure: it takes plain arrays and returns numbers, so it is tested without a database and reused by the query layer.

**Tech Stack:** Node 24, SvelteKit 2 (Svelte 5, adapter-node), TypeScript, drizzle-orm 0.45 + drizzle-kit 0.31, better-sqlite3 13, vitest 5, fast-check 4.

**Spec:** `docs/superpowers/specs/2026-09-04-shiso-phase1-foundation-design.md`. Sections cited as §N below.

Plans 1B (sync, post-processing, bills) and 1C (screens, deployment, sheet import) follow this one and consume the interfaces in each task's **Produces** block.

## Global Constraints

- All money is integer cents. No floats touch a stored amount (§2).
- Sign convention: amounts are from the account's point of view; a card purchase is negative, a payment to the card is positive (§2).
- Dates are ISO `YYYY-MM-DD` strings; timestamps are ISO 8601 UTC strings. No `Date` objects in the schema.
- Ready-to-assign reads only accounts with `on_budget = 1 AND type IN ('checking','savings','cash')`; the three types are named explicitly in code (§4.1).
- Nothing writes `transactions`, `transaction_splits`, `budget_assignments`, `bill_occurrence_transactions`, or `bill_occurrences` except the ledger service (§9).
- Every definition in §7 lives in exactly one function. Do not restate a formula in a second place.
- Commit messages: conventional prefix (`feat:`, `test:`, `chore:`), no reference to AI tooling.
- Run the whole suite (`npm test`) before every commit.

---

### Task 1: Scaffold the project

**Files:**
- Create: `package.json`, `svelte.config.js`, `vite.config.ts`, `tsconfig.json`, `src/app.html`, `src/routes/+page.svelte` (from `sv create`)
- Create: `.env.example`
- Modify: `.gitignore`
- Test: `src/lib/smoke.test.ts`

**Interfaces:**
- Produces: `npm run dev`, `npm run build`, `npm test`, `npm run check`.

- [ ] **Step 1: Scaffold into the existing directory**

The directory already holds `docs/`, `assets/`, `.gitignore`, and `.git`, so scaffold into a temp dir and move the result in.

```bash
cd /Users/justin/developer/shiso
npx sv@0.17.0 create scaffold-tmp --template minimal --types ts --no-add-ons --no-install
rsync -a scaffold-tmp/ ./
rm -rf scaffold-tmp
```

- [ ] **Step 2: Install dependencies**

```bash
npm install
npm install @sveltejs/adapter-node drizzle-orm better-sqlite3 node-cron
npm install -D drizzle-kit @types/better-sqlite3 @types/node-cron vitest fast-check
```

- [ ] **Step 3: Switch to adapter-node**

Replace the contents of `svelte.config.js`:

```js
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: { adapter: adapter() }
};

export default config;
```

- [ ] **Step 4: Configure vitest**

Replace `vite.config.ts`:

```ts
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
```

Add to `package.json` scripts:

```json
"test": "vitest run",
"test:watch": "vitest",
"db:generate": "drizzle-kit generate"
```

- [ ] **Step 5: Write the smoke test**

`src/lib/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('toolchain', () => {
	it('runs tests', () => {
		expect(1 + 1).toBe(2);
	});
});
```

- [ ] **Step 6: Run it**

Run: `npm test`
Expected: 1 passed.

- [ ] **Step 7: Environment template and ignore rules**

`.env.example`:

```
# Copy to .env. Never commit .env.
SHISO_DB_PATH=./data/shiso.db
SHISO_BACKUP_DIR=./data/backups
SHISO_APP_KEY=replace-with-32-bytes-base64
SHISO_TZ=America/New_York
# Where drizzle/ lives. Defaults to the repo's drizzle/ in dev; must be set in production (Plan 1C ships it beside build/).
SHISO_MIGRATIONS_DIR=
PLAID_CLIENT_ID=
PLAID_SECRET=
PLAID_ENV=sandbox
```

Append to `.gitignore`:

```
data/
.svelte-kit/
build/
```

- [ ] **Step 8: Verify dev server and type check**

Run: `npm run check`
Expected: 0 errors.

Run: `npm run build`
Expected: build completes, `build/` directory exists.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold sveltekit project with drizzle, vitest, adapter-node"
```

---

### Task 2: Money and date utilities

**Files:**
- Create: `src/lib/money.ts`, `src/lib/dates.ts`
- Test: `src/lib/money.test.ts`, `src/lib/dates.test.ts`

**Interfaces:**
- Produces:
  - `decimalToCents(s: string | number): number` — parses `"12.34"`, `"-12.34"`, `12.3`, `"1,234.50"` to integer cents; throws on more than 2 decimals or NaN.
  - `formatCents(cents: number): string` — `-123456` → `"-$1,234.56"`.
  - `isoDate(d: Date): string` — UTC `YYYY-MM-DD`.
  - `addDays(iso: string, n: number): string`
  - `endOfMonth(iso: string): string`
  - `compareIso(a: string, b: string): number`
  - `isoDateInZone(d: Date, timeZone: string): string` — the calendar date of an instant in an IANA zone.
  - `todayIso(timeZone: string): string` — the local calendar date. Period boundaries, the current period, and overdue checks all use this; provider posted dates are calendar dates, so budget semantics must never use UTC.
  - `nowIso(): string` — UTC timestamp for `created_at`-style columns only.

- [ ] **Step 1: Write the failing money tests**

`src/lib/money.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decimalToCents, formatCents } from './money';

describe('decimalToCents', () => {
	it('parses plain decimals', () => {
		expect(decimalToCents('12.34')).toBe(1234);
		expect(decimalToCents('-12.34')).toBe(-1234);
		expect(decimalToCents('0.5')).toBe(50);
		expect(decimalToCents('7')).toBe(700);
	});
	it('parses numbers without float drift', () => {
		expect(decimalToCents(0.1 + 0.2)).toBe(30);
		expect(decimalToCents(1234.56)).toBe(123456);
	});
	it('strips thousands separators and currency symbols', () => {
		expect(decimalToCents('$1,234.50')).toBe(123450);
		expect(decimalToCents('($1,234.50)')).toBe(-123450);
	});
	it('rejects more than two decimals', () => {
		expect(() => decimalToCents('1.234')).toThrow();
	});
	it('rejects garbage', () => {
		expect(() => decimalToCents('abc')).toThrow();
	});
});

describe('formatCents', () => {
	it('formats with sign and grouping', () => {
		expect(formatCents(123456)).toBe('$1,234.56');
		expect(formatCents(-123456)).toBe('-$1,234.56');
		expect(formatCents(5)).toBe('$0.05');
		expect(formatCents(0)).toBe('$0.00');
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/money.test.ts`
Expected: FAIL, cannot find module './money'.

- [ ] **Step 3: Implement money.ts**

```ts
/** Parse a decimal string or number into integer cents. Throws on invalid input. */
export function decimalToCents(input: string | number): number {
	let s = typeof input === 'number' ? input.toFixed(2) : input.trim();
	let negative = false;
	if (s.startsWith('(') && s.endsWith(')')) {
		negative = true;
		s = s.slice(1, -1);
	}
	s = s.replace(/[$,\s]/g, '');
	if (s.startsWith('-')) {
		negative = !negative;
		s = s.slice(1);
	}
	const m = /^(\d*)(?:\.(\d{1,2}))?$/.exec(s);
	if (!m || (m[1] === '' && m[2] === undefined)) {
		throw new Error(`invalid money value: ${JSON.stringify(input)}`);
	}
	const whole = m[1] === '' ? 0 : parseInt(m[1], 10);
	const frac = m[2] === undefined ? 0 : parseInt(m[2].padEnd(2, '0'), 10);
	const cents = whole * 100 + frac;
	return negative ? -cents : cents;
}

/** Format integer cents as a US dollar string. */
export function formatCents(cents: number): string {
	const sign = cents < 0 ? '-' : '';
	const abs = Math.abs(cents);
	const whole = Math.floor(abs / 100).toLocaleString('en-US');
	const frac = String(abs % 100).padStart(2, '0');
	return `${sign}$${whole}.${frac}`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/money.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing date tests**

`src/lib/dates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isoDate, addDays, endOfMonth, compareIso, isoDateInZone, todayIso } from './dates';

describe('dates', () => {
	it('formats UTC dates', () => {
		expect(isoDate(new Date(Date.UTC(2026, 8, 4)))).toBe('2026-09-04');
	});
	it('adds days across month and year boundaries', () => {
		expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
	});
	it('finds end of month including leap years', () => {
		expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
		expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
		expect(endOfMonth('2026-09-16')).toBe('2026-09-30');
	});
	it('compares lexically', () => {
		expect(compareIso('2026-01-01', '2026-01-02')).toBeLessThan(0);
		expect(compareIso('2026-01-02', '2026-01-02')).toBe(0);
	});
	it('resolves the calendar date in a zone, not UTC', () => {
		// 01:00 UTC on the 5th is still the 4th in New York.
		const instant = new Date('2026-09-05T01:00:00Z');
		expect(isoDateInZone(instant, 'America/New_York')).toBe('2026-09-04');
		expect(isoDateInZone(instant, 'UTC')).toBe('2026-09-05');
		expect(todayIso('America/New_York')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run src/lib/dates.test.ts`
Expected: FAIL, cannot find module './dates'.

- [ ] **Step 7: Implement dates.ts**

```ts
/** All dates are ISO YYYY-MM-DD strings interpreted in UTC. */
export function isoDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

export function parseIso(iso: string): Date {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) throw new Error(`invalid ISO date: ${iso}`);
	return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

export function addDays(iso: string, n: number): string {
	const d = parseIso(iso);
	d.setUTCDate(d.getUTCDate() + n);
	return isoDate(d);
}

export function endOfMonth(iso: string): string {
	const d = parseIso(iso);
	return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

export function startOfMonth(iso: string): string {
	return iso.slice(0, 8) + '01';
}

export function compareIso(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Calendar date of `d` in an IANA time zone. en-CA formats as YYYY-MM-DD. */
export function isoDateInZone(d: Date, timeZone: string): string {
	return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Today's calendar date in the app's zone. Budget semantics use this; never `isoDate(new Date())`. */
export function todayIso(timeZone: string): string {
	return isoDateInZone(new Date(), timeZone);
}

export function nowIso(): string {
	return new Date().toISOString();
}
```

- [ ] **Step 8: Run to verify pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/money.ts src/lib/money.test.ts src/lib/dates.ts src/lib/dates.test.ts
git commit -m "feat: money and date primitives"
```

---

### Task 3: Schema and first migration

**Files:**
- Create: `src/lib/server/db/schema.ts`, `drizzle.config.ts`
- Create (generated): `drizzle/0000_*.sql`, `drizzle/meta/*`
- Test: `src/lib/server/db/schema.test.ts`

**Interfaces:**
- Produces: every table export named below, plus the enum-like string unions `AccountType`, `CategoryKind`, `TransactionSource`, `Provider`, `ConnectionStatus`, `OccurrenceStatus`. Column property names are camelCase in TypeScript and snake_case in SQL exactly as written here; later plans import from this file.

- [ ] **Step 1: Write the failing schema test**

`src/lib/server/db/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

const EXPECTED_TABLES = [
	'connections', 'accounts', 'account_balances', 'account_terms',
	'transactions', 'transaction_splits', 'bill_occurrence_transactions', 'payee_rules',
	'category_groups', 'categories', 'periods', 'budget_assignments',
	'bills', 'bill_occurrences', 'income_sources', 'income_occurrences',
	'sync_runs', 'settings'
];

describe('schema', () => {
	it('migrates a fresh database to every phase 1 table', () => {
		const sqlite = new Database(':memory:');
		const db = drizzle({ client: sqlite, schema });
		migrate(db, { migrationsFolder: 'drizzle' });
		const rows = sqlite
			.prepare("select name from sqlite_master where type='table' and name not like '\\_\\_%' escape '\\' and name not like 'sqlite_%'")
			.all() as { name: string }[];
		const names = rows.map((r) => r.name).sort();
		expect(names).toEqual([...EXPECTED_TABLES].sort());
	});

	it('enforces unique external id per account', () => {
		const sqlite = new Database(':memory:');
		const db = drizzle({ client: sqlite, schema });
		migrate(db, { migrationsFolder: 'drizzle' });
		sqlite.exec(`
			insert into connections (provider, institution_name, status) values ('manual','Test','active');
			insert into accounts (connection_id, external_id, name, type, on_budget, is_debt) values (1,'x','Chk','checking',1,0);
			insert into periods (start_date, end_date, label) values ('2026-01-01','2026-01-15','Jan 1-15, 2026');
			insert into transactions (account_id, external_id, posted_date, amount, payee_raw, payee, pending, period_id, source)
				values (1,'t1','2026-01-02',-100,'A','A',0,1,'sync');
		`);
		expect(() =>
			sqlite.exec(`insert into transactions (account_id, external_id, posted_date, amount, payee_raw, payee, pending, period_id, source)
				values (1,'t1','2026-01-03',-200,'B','B',0,1,'sync');`)
		).toThrow(/UNIQUE/);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/server/db/schema.test.ts`
Expected: FAIL, cannot find module './schema'.

- [ ] **Step 3: Write drizzle.config.ts**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'sqlite',
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dbCredentials: { url: process.env.SHISO_DB_PATH ?? './data/shiso.db' }
});
```

- [ ] **Step 4: Write schema.ts**

This is the whole of §4 for Phase 1. Column order and names are the contract for Plans 1B and 1C.

```ts
import { sql } from 'drizzle-orm';
import {
	sqliteTable, integer, text, index, uniqueIndex, type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core';

// ---- string unions used as enums --------------------------------------
export const PROVIDERS = ['plaid', 'simplefin', 'manual'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const CONNECTION_STATUSES = ['active', 'needs_relink', 'error', 'disabled'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const ACCOUNT_TYPES = ['checking', 'savings', 'cash', 'credit', 'loan', 'investment'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
/** The only types whose balances count toward ready-to-assign (§4.1). */
export const CASH_TYPES = ['checking', 'savings', 'cash'] as const;

export const CATEGORY_KINDS = [
	'spending', 'bill', 'debt_payment', 'interest', 'fee',
	'income', 'transfer', 'savings', 'reconciliation'
] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const TRANSACTION_SOURCES = ['sync', 'manual', 'import', 'opening', 'adjustment'] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

export const OCCURRENCE_STATUSES = ['pending', 'paid', 'overdue', 'skipped'] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

export const BILL_CADENCES = ['monthly', 'semi_monthly', 'every_n_weeks', 'yearly'] as const;
export type BillCadence = (typeof BILL_CADENCES)[number];

const NOW = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
const timestamps = {
	createdAt: text('created_at').notNull().default(NOW),
	updatedAt: text('updated_at').notNull().default(NOW)
};

// ---- 4.1 connections and accounts -------------------------------------
export const connections = sqliteTable('connections', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	provider: text('provider', { enum: PROVIDERS }).notNull(),
	institutionName: text('institution_name').notNull(),
	externalItemId: text('external_item_id'),
	credentialEnc: text('credential_enc'),
	status: text('status', { enum: CONNECTION_STATUSES }).notNull().default('active'),
	cursor: text('cursor'),
	lastSuccessAt: text('last_success_at'),
	lastError: text('last_error'),
	...timestamps
});

export const accounts = sqliteTable('accounts', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	connectionId: integer('connection_id').notNull().references(() => connections.id),
	externalId: text('external_id').notNull(),
	name: text('name').notNull(),
	officialName: text('official_name'),
	mask: text('mask'),
	type: text('type', { enum: ACCOUNT_TYPES }).notNull(),
	onBudget: integer('on_budget', { mode: 'boolean' }).notNull(),
	isDebt: integer('is_debt', { mode: 'boolean' }).notNull(),
	closedAt: text('closed_at'),
	...timestamps
}, (t) => [uniqueIndex('accounts_connection_external').on(t.connectionId, t.externalId)]);

export const accountBalances = sqliteTable('account_balances', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	accountId: integer('account_id').notNull().references(() => accounts.id),
	asOf: text('as_of').notNull(),
	current: integer('current').notNull(),
	available: integer('available'),
	creditLimit: integer('credit_limit'),
	source: text('source', { enum: ['sync', 'manual', 'import'] }).notNull(),
	createdAt: text('created_at').notNull().default(NOW)
}, (t) => [index('account_balances_account_asof').on(t.accountId, t.asOf)]);

export const accountTerms = sqliteTable('account_terms', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	accountId: integer('account_id').notNull().references(() => accounts.id),
	asOf: text('as_of').notNull(),
	aprBps: integer('apr_bps'),
	promoAprBps: integer('promo_apr_bps'),
	minPayment: integer('min_payment'),
	nextDueDate: text('next_due_date'),
	lastStatementBalance: integer('last_statement_balance'),
	lastStatementDate: text('last_statement_date'),
	annualFee: integer('annual_fee'),
	source: text('source', { enum: ['provider', 'manual'] }).notNull(),
	createdAt: text('created_at').notNull().default(NOW)
}, (t) => [index('account_terms_account_asof').on(t.accountId, t.asOf)]);

// ---- 4.3 budget (declared before ledger because transactions reference periods)
export const categoryGroups = sqliteTable('category_groups', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	sort: integer('sort').notNull().default(0),
	hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
	...timestamps
});

export const categories = sqliteTable('categories', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	groupId: integer('group_id').notNull().references(() => categoryGroups.id),
	name: text('name').notNull(),
	sort: integer('sort').notNull().default(0),
	hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
	kind: text('kind', { enum: CATEGORY_KINDS }).notNull(),
	accountId: integer('account_id').references(() => accounts.id),
	...timestamps
}, (t) => [uniqueIndex('categories_debt_account').on(t.accountId).where(sql`kind = 'debt_payment'`)]);

export const periods = sqliteTable('periods', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	startDate: text('start_date').notNull(),
	endDate: text('end_date').notNull(),
	label: text('label').notNull()
}, (t) => [uniqueIndex('periods_start').on(t.startDate)]);

export const budgetAssignments = sqliteTable('budget_assignments', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	periodId: integer('period_id').notNull().references(() => periods.id),
	categoryId: integer('category_id').notNull().references(() => categories.id),
	assigned: integer('assigned').notNull().default(0),
	...timestamps
}, (t) => [uniqueIndex('budget_assignments_period_category').on(t.periodId, t.categoryId)]);

// ---- 4.2 ledger --------------------------------------------------------
export const transactions = sqliteTable('transactions', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	accountId: integer('account_id').notNull().references(() => accounts.id),
	externalId: text('external_id').notNull(),
	pendingExternalId: text('pending_external_id'),
	postedDate: text('posted_date').notNull(),
	transactedAt: text('transacted_at'),
	amount: integer('amount').notNull(),
	payeeRaw: text('payee_raw').notNull(),
	payee: text('payee').notNull(),
	memo: text('memo'),
	pending: integer('pending', { mode: 'boolean' }).notNull().default(false),
	providerCategory: text('provider_category'),
	periodId: integer('period_id').notNull().references(() => periods.id),
	transferPeerId: integer('transfer_peer_id').references((): AnySQLiteColumn => transactions.id),
	deletedAt: text('deleted_at'),
	replacedById: integer('replaced_by_id').references((): AnySQLiteColumn => transactions.id),
	needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
	reviewReason: text('review_reason'),
	processedAt: text('processed_at'),
	source: text('source', { enum: TRANSACTION_SOURCES }).notNull(),
	...timestamps
}, (t) => [
	uniqueIndex('transactions_account_external').on(t.accountId, t.externalId),
	index('transactions_account_posted').on(t.accountId, t.postedDate),
	index('transactions_period').on(t.periodId),
	index('transactions_unprocessed').on(t.processedAt).where(sql`processed_at is null`)
]);

export const transactionSplits = sqliteTable('transaction_splits', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	transactionId: integer('transaction_id').notNull().references(() => transactions.id),
	categoryId: integer('category_id').notNull().references(() => categories.id),
	amount: integer('amount').notNull(),
	memo: text('memo')
}, (t) => [
	index('transaction_splits_transaction').on(t.transactionId),
	index('transaction_splits_category').on(t.categoryId)
]);

export const payeeRules = sqliteTable('payee_rules', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	pattern: text('pattern').notNull(),
	isRegex: integer('is_regex', { mode: 'boolean' }).notNull().default(false),
	payee: text('payee').notNull(),
	categoryId: integer('category_id').references(() => categories.id),
	priority: integer('priority').notNull().default(100),
	...timestamps
});

// ---- 4.4 bills and income ---------------------------------------------
export const bills = sqliteTable('bills', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	categoryId: integer('category_id').notNull().references(() => categories.id),
	payFromAccountId: integer('pay_from_account_id').notNull().references(() => accounts.id),
	expectedAmount: integer('expected_amount').notNull(),
	toleranceAbs: integer('tolerance_abs').notNull().default(0),
	tolerancePct: integer('tolerance_pct').notNull().default(0),
	cadence: text('cadence', { enum: BILL_CADENCES }).notNull(),
	dueDay: integer('due_day'),
	dueDay2: integer('due_day_2'),
	interval: integer('interval'),
	anchorDate: text('anchor_date'),
	autopay: integer('autopay', { mode: 'boolean' }).notNull().default(false),
	matchPattern: text('match_pattern'),
	linkedDebtAccountId: integer('linked_debt_account_id').references(() => accounts.id),
	active: integer('active', { mode: 'boolean' }).notNull().default(true),
	...timestamps
});

export const billOccurrences = sqliteTable('bill_occurrences', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	billId: integer('bill_id').notNull().references(() => bills.id),
	dueDate: text('due_date').notNull(),
	periodId: integer('period_id').notNull().references(() => periods.id),
	expectedAmount: integer('expected_amount').notNull(),
	statementBalance: integer('statement_balance'),
	status: text('status', { enum: OCCURRENCE_STATUSES }).notNull().default('pending'),
	paidAmount: integer('paid_amount').notNull().default(0),
	extraAmount: integer('extra_amount').notNull().default(0),
	markedBy: text('marked_by', { enum: ['auto', 'manual'] }),
	windowStart: text('window_start').notNull(),
	windowEnd: text('window_end').notNull(),
	needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
	...timestamps
}, (t) => [uniqueIndex('bill_occurrences_bill_due').on(t.billId, t.dueDate)]);

export const billOccurrenceTransactions = sqliteTable('bill_occurrence_transactions', {
	billOccurrenceId: integer('bill_occurrence_id').notNull().references(() => billOccurrences.id),
	transactionId: integer('transaction_id').notNull().references(() => transactions.id)
}, (t) => [uniqueIndex('bill_occurrence_transactions_pk').on(t.billOccurrenceId, t.transactionId)]);

export const incomeSources = sqliteTable('income_sources', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	categoryId: integer('category_id').notNull().references(() => categories.id),
	depositAccountId: integer('deposit_account_id').notNull().references(() => accounts.id),
	expectedAmount: integer('expected_amount').notNull(),
	toleranceAbs: integer('tolerance_abs').notNull().default(0),
	tolerancePct: integer('tolerance_pct').notNull().default(0),
	cadence: text('cadence', { enum: BILL_CADENCES }).notNull(),
	dueDay: integer('due_day'),
	dueDay2: integer('due_day_2'),
	interval: integer('interval'),
	anchorDate: text('anchor_date'),
	matchPattern: text('match_pattern'),
	active: integer('active', { mode: 'boolean' }).notNull().default(true),
	...timestamps
});

export const incomeOccurrences = sqliteTable('income_occurrences', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	incomeSourceId: integer('income_source_id').notNull().references(() => incomeSources.id),
	dueDate: text('due_date').notNull(),
	periodId: integer('period_id').notNull().references(() => periods.id),
	expectedAmount: integer('expected_amount').notNull(),
	status: text('status', { enum: OCCURRENCE_STATUSES }).notNull().default('pending'),
	receivedAmount: integer('received_amount').notNull().default(0),
	markedBy: text('marked_by', { enum: ['auto', 'manual'] }),
	transactionId: integer('transaction_id').references(() => transactions.id),
	windowStart: text('window_start').notNull(),
	windowEnd: text('window_end').notNull(),
	...timestamps
}, (t) => [uniqueIndex('income_occurrences_source_due').on(t.incomeSourceId, t.dueDate)]);

// ---- 4.5 operations ----------------------------------------------------
export const syncRuns = sqliteTable('sync_runs', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	connectionId: integer('connection_id').notNull().references(() => connections.id),
	trigger: text('trigger', { enum: ['cron', 'manual', 'startup'] }).notNull(),
	startedAt: text('started_at').notNull(),
	finishedAt: text('finished_at'),
	status: text('status', { enum: ['running', 'ok', 'error'] }).notNull().default('running'),
	startCursor: text('start_cursor'),
	endCursor: text('end_cursor'),
	added: integer('added').notNull().default(0),
	modified: integer('modified').notNull().default(0),
	removed: integer('removed').notNull().default(0),
	balancesWritten: integer('balances_written').notNull().default(0),
	termsWritten: integer('terms_written').notNull().default(0),
	error: text('error')
}, (t) => [index('sync_runs_connection_started').on(t.connectionId, t.startedAt)]);

export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value', { mode: 'json' }).notNull(),
	updatedAt: text('updated_at').notNull().default(NOW)
});
```

Note on `replaced_by_id`: §5.5 says a soft-deleted pending row keeps "a reference to its replacement"; this column is that reference.

- [ ] **Step 5: Generate the migration**

Run: `npm run db:generate -- --name init`
Expected: `drizzle/0000_init.sql` and `drizzle/meta/_journal.json` created. Open the SQL and confirm 18 `CREATE TABLE` statements and the partial unique index on `categories`.

- [ ] **Step 6: Run the schema test**

Run: `npx vitest run src/lib/server/db/schema.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/db/schema.ts src/lib/server/db/schema.test.ts drizzle.config.ts drizzle/
git commit -m "feat: phase 1 schema and initial migration"
```

---

### Task 4: Open the database with a pre-migration snapshot

**Files:**
- Create: `src/lib/server/db/index.ts`, `src/lib/server/db/migrations.ts`
- Test: `src/lib/server/db/migrations.test.ts`

**Interfaces:**
- Produces:
  - `openDatabase(opts: { path: string; backupDir: string; migrationsFolder?: string }): { db: Db; sqlite: Database.Database; snapshot: string | null }` — opens (creating if missing) with WAL and foreign keys on, snapshots to `backupDir` if migrations are pending, applies migrations, returns the Drizzle handle. `snapshot` is the path written, or null if none was needed.
  - `openMemoryDatabase(): { db: Db; sqlite }` — in-memory, migrated; for tests and later plans' fixtures.
  - `pendingMigrations(sqlite, migrationsFolder): string[]` — tags in the journal not yet in `__drizzle_migrations`.
  - `type Db = BetterSQLite3Database<typeof schema>`
  - `type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]` and `type DbOrTx = Db | Tx`. Every ledger and budget service function takes `DbOrTx`, so it can be called inside another service's transaction; a nested `transaction()` on a `Tx` becomes a SAVEPOINT.

- [ ] **Step 1: Write the failing tests**

`src/lib/server/db/migrations.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, pendingMigrations } from './index';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shiso-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('openDatabase', () => {
	it('creates the file, applies migrations, and does not snapshot an empty database', () => {
		const path = join(dir, 'shiso.db');
		const backupDir = join(dir, 'backups');
		const { sqlite, snapshot } = openDatabase({ path, backupDir });
		expect(existsSync(path)).toBe(true);
		expect(snapshot).toBeNull();
		expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
		expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
		expect(pendingMigrations(sqlite, 'drizzle')).toEqual([]);
		sqlite.close();
	});

	it('snapshots before applying migrations to an existing database', () => {
		const path = join(dir, 'shiso.db');
		const backupDir = join(dir, 'backups');
		// Existing database with no migrations applied: simulates an upgrade.
		const pre = new Database(path);
		pre.exec('create table legacy (x integer)');
		pre.close();
		const { sqlite, snapshot } = openDatabase({ path, backupDir });
		expect(snapshot).not.toBeNull();
		expect(readdirSync(backupDir).some((f) => f.startsWith('pre-migration-'))).toBe(true);
		const copy = new Database(snapshot!, { readonly: true });
		const tables = copy.prepare("select name from sqlite_master where type='table'").all() as { name: string }[];
		expect(tables.map((t) => t.name)).toContain('legacy');
		expect(tables.map((t) => t.name)).not.toContain('accounts');
		copy.close();
		sqlite.close();
	});

	it('reports pending migrations by journal tag', () => {
		const path = join(dir, 'shiso.db');
		const raw = new Database(path);
		const pending = pendingMigrations(raw, 'drizzle');
		expect(pending.length).toBeGreaterThan(0);
		expect(pending[0]).toMatch(/^0000_/);
		raw.close();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/server/db/migrations.test.ts`
Expected: FAIL, cannot find module './index'.

- [ ] **Step 3: Implement migrations.ts**

```ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

type Journal = { entries: { idx: number; tag: string; when: number }[] };

/** Migration tags present in the journal but not recorded in __drizzle_migrations. */
export function pendingMigrations(sqlite: Database.Database, migrationsFolder: string): string[] {
	const journalPath = join(migrationsFolder, 'meta', '_journal.json');
	if (!existsSync(journalPath)) throw new Error(`no migration journal at ${journalPath}`);
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
	const hasTable = sqlite
		.prepare("select 1 from sqlite_master where type='table' and name='__drizzle_migrations'")
		.get();
	if (!hasTable) return journal.entries.map((e) => e.tag);
	// Drizzle records created_at = the journal entry's `when` for each applied migration.
	const applied = new Set(
		(sqlite.prepare('select created_at from __drizzle_migrations').all() as { created_at: number }[])
			.map((r) => r.created_at)
	);
	return journal.entries.filter((e) => !applied.has(e.when)).map((e) => e.tag);
}
```

- [ ] **Step 4: Implement index.ts**

```ts
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';
import { pendingMigrations } from './migrations';

export type Db = BetterSQLite3Database<typeof schema>;
/** The handle a `db.transaction((tx) => …)` callback receives. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Service functions accept either, so they compose inside a caller's transaction. */
export type DbOrTx = Db | Tx;
export { schema };

const DEFAULT_MIGRATIONS = 'drizzle';

function configure(sqlite: Database.Database) {
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');
	sqlite.pragma('busy_timeout = 5000');
}

export function openDatabase(opts: { path: string; backupDir: string; migrationsFolder?: string }) {
	const migrationsFolder = opts.migrationsFolder ?? DEFAULT_MIGRATIONS;
	mkdirSync(dirname(opts.path), { recursive: true });
	const sqlite = new Database(opts.path);
	configure(sqlite);

	let snapshot: string | null = null;
	const pending = pendingMigrations(sqlite, migrationsFolder);
	const isFresh = sqlite.prepare("select count(*) as n from sqlite_master where type='table'").get() as { n: number };
	if (pending.length > 0 && isFresh.n > 0) {
		mkdirSync(opts.backupDir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		snapshot = join(opts.backupDir, `pre-migration-${stamp}-${pending[0]}.db`);
		sqlite.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
	}

	const db = drizzle({ client: sqlite, schema });
	if (pending.length > 0) migrate(db, { migrationsFolder });
	return { db, sqlite, snapshot };
}

export function openMemoryDatabase(migrationsFolder = DEFAULT_MIGRATIONS) {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	const db = drizzle({ client: sqlite, schema });
	migrate(db, { migrationsFolder });
	return { db, sqlite };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/lib/server/db/migrations.test.ts`
Expected: PASS (3 tests). If the "reports pending migrations" test fails on the `created_at` comparison, inspect `select * from __drizzle_migrations` after a migrate and adjust `pendingMigrations` to match what this drizzle-orm version stores; the journal `when` value is what drizzle writes to `created_at`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/db/index.ts src/lib/server/db/migrations.ts src/lib/server/db/migrations.test.ts
git commit -m "feat: open database with WAL and pre-migration snapshot"
```

---

### Task 5: Periods with back-fill

**Files:**
- Create: `src/lib/server/budget/periods.ts`
- Test: `src/lib/server/budget/periods.test.ts`

**Interfaces:**
- Consumes: `DbOrTx` (Task 4), `addDays`, `endOfMonth`, `startOfMonth`, `compareIso` (Task 2).
- Produces:
  - `type Cadence = 'semi_monthly' | 'monthly'`
  - `periodBoundsFor(cadence: Cadence, iso: string): { startDate: string; endDate: string; label: string }` — pure; the period containing a date.
  - `nextPeriodStart(cadence, endDate): string` — pure.
  - `ensurePeriods(db: DbOrTx, cadence: Cadence, fromIso: string, throughIso: string): void` — idempotent; inserts every missing period covering `[fromIso, throughIso]`.
  - `periodIdForDate(db: DbOrTx, iso: string): number` — throws if no period covers the date (callers must `ensurePeriods` first).
  - `currentPeriodId(db: DbOrTx, todayIso: string): number`

- [ ] **Step 1: Write the failing tests**

`src/lib/server/budget/periods.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openMemoryDatabase } from '../db';
import { periodBoundsFor, nextPeriodStart, ensurePeriods, periodIdForDate } from './periods';
import { periods } from '../db/schema';
import { asc } from 'drizzle-orm';

describe('periodBoundsFor', () => {
	it('splits months at the 15th', () => {
		expect(periodBoundsFor('semi_monthly', '2026-09-04')).toEqual({
			startDate: '2026-09-01', endDate: '2026-09-15', label: 'Sep 1–15, 2026'
		});
		expect(periodBoundsFor('semi_monthly', '2026-09-16')).toEqual({
			startDate: '2026-09-16', endDate: '2026-09-30', label: 'Sep 16–30, 2026'
		});
		expect(periodBoundsFor('semi_monthly', '2028-02-29').endDate).toBe('2028-02-29');
	});
	it('handles monthly cadence', () => {
		expect(periodBoundsFor('monthly', '2026-09-20')).toEqual({
			startDate: '2026-09-01', endDate: '2026-09-30', label: 'Sep 2026'
		});
	});
	it('steps to the next period', () => {
		expect(nextPeriodStart('semi_monthly', '2026-09-15')).toBe('2026-09-16');
		expect(nextPeriodStart('semi_monthly', '2026-09-30')).toBe('2026-10-01');
	});
});

describe('ensurePeriods', () => {
	it('back-fills two years of semi-monthly periods and is idempotent', () => {
		const { db } = openMemoryDatabase();
		ensurePeriods(db, 'semi_monthly', '2024-09-04', '2026-09-30');
		const rows = db.select().from(periods).orderBy(asc(periods.startDate)).all();
		expect(rows[0].startDate).toBe('2024-09-01');
		expect(rows[rows.length - 1].endDate).toBe('2026-09-30');
		expect(rows.length).toBe(50); // 25 months × 2
		ensurePeriods(db, 'semi_monthly', '2024-09-04', '2026-09-30');
		expect(db.select().from(periods).all().length).toBe(50);
	});
	it('extends forward without duplicating', () => {
		const { db } = openMemoryDatabase();
		ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-01-31');
		ensurePeriods(db, 'semi_monthly', '2026-01-20', '2026-03-31');
		expect(db.select().from(periods).all().length).toBe(6);
	});
	it('resolves a date to its period id', () => {
		const { db } = openMemoryDatabase();
		ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-02-28');
		const id = periodIdForDate(db, '2026-02-16');
		const row = db.select().from(periods).where(eqId(id)).get();
		expect(row?.startDate).toBe('2026-02-16');
		expect(() => periodIdForDate(db, '2026-03-01')).toThrow(/no period/);
	});
});

import { eq } from 'drizzle-orm';
function eqId(id: number) { return eq(periods.id, id); }
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/server/budget/periods.test.ts`
Expected: FAIL, cannot find module './periods'.

- [ ] **Step 3: Implement periods.ts**

```ts
import { and, gte, lte, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { periods } from '../db/schema';
import { addDays, endOfMonth, startOfMonth, compareIso } from '$lib/dates';

export type Cadence = 'semi_monthly' | 'monthly';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function label(startDate: string, endDate: string, cadence: Cadence): string {
	const y = startDate.slice(0, 4);
	const m = MONTHS[+startDate.slice(5, 7) - 1];
	if (cadence === 'monthly') return `${m} ${y}`;
	return `${m} ${+startDate.slice(8, 10)}–${+endDate.slice(8, 10)}, ${y}`;
}

/** The period (by cadence) containing `iso`. Pure. */
export function periodBoundsFor(cadence: Cadence, iso: string) {
	const som = startOfMonth(iso);
	const eom = endOfMonth(iso);
	if (cadence === 'monthly') return { startDate: som, endDate: eom, label: label(som, eom, cadence) };
	const day = +iso.slice(8, 10);
	const mid = som.slice(0, 8) + '15';
	const [startDate, endDate] = day <= 15 ? [som, mid] : [som.slice(0, 8) + '16', eom];
	return { startDate, endDate, label: label(startDate, endDate, cadence) };
}

export function nextPeriodStart(cadence: Cadence, endDate: string): string {
	return addDays(endDate, 1);
}

/** Insert every period needed so that [fromIso, throughIso] is fully covered. Idempotent. */
export function ensurePeriods(db: DbOrTx, cadence: Cadence, fromIso: string, throughIso: string): void {
	const existing = new Set(db.select({ s: periods.startDate }).from(periods).all().map((r) => r.s));
	const rows: { startDate: string; endDate: string; label: string }[] = [];
	let cursor = periodBoundsFor(cadence, fromIso);
	while (compareIso(cursor.startDate, throughIso) <= 0) {
		if (!existing.has(cursor.startDate)) rows.push(cursor);
		cursor = periodBoundsFor(cadence, nextPeriodStart(cadence, cursor.endDate));
	}
	if (rows.length > 0) db.insert(periods).values(rows).run();
}

export function periodIdForDate(db: DbOrTx, iso: string): number {
	const row = db
		.select({ id: periods.id })
		.from(periods)
		.where(and(lte(periods.startDate, iso), gte(periods.endDate, iso)))
		.get();
	if (!row) throw new Error(`no period covers ${iso}; call ensurePeriods first`);
	return row.id;
}

export function currentPeriodId(db: DbOrTx, todayIso: string): number {
	return periodIdForDate(db, todayIso);
}

/** Earliest and latest period start dates, or null when none exist. */
export function periodRange(db: DbOrTx): { first: string; last: string } | null {
	const row = db
		.select({ first: sql<string>`min(${periods.startDate})`, last: sql<string>`max(${periods.startDate})` })
		.from(periods)
		.get();
	return row && row.first ? { first: row.first, last: row.last } : null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/server/budget/periods.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/budget/periods.ts src/lib/server/budget/periods.test.ts
git commit -m "feat: semi-monthly periods with back-fill"
```

---

### Task 6: Categories and groups

**Files:**
- Create: `src/lib/server/ledger/categories.ts`, `src/lib/server/ledger/errors.ts`
- Test: `src/lib/server/ledger/categories.test.ts`

**Interfaces:**
- Consumes: `DbOrTx`, `schema` (Task 4).
- Produces:
  - `class InvariantError extends Error { code: string }`
  - `createGroup(db, name): number`
  - `createCategory(db, input: { groupId: number; name: string; kind: CategoryKind; accountId?: number | null }): number` — throws `InvariantError('DEBT_CATEGORY_NEEDS_ACCOUNT')` when kind is `debt_payment` and no account; `InvariantError('DEBT_CATEGORY_ACCOUNT_NOT_DEBT')` when the account is not `is_debt`; `InvariantError('DEBT_CATEGORY_DUPLICATE')` when the account already has one.
  - `renameCategory(db, id, name)`, `hideCategory(db, id, hidden)`, `moveCategory(db, id, groupId, sort)`
  - `paymentCategoryForAccount(db, accountId): number | null`
  - `seedDefaultCategories(db): void` — creates the groups and categories a fresh install needs: group "System" with kinds `income` ("Income"), `transfer` ("Transfer"), `reconciliation` ("Reconciliation"), `interest` ("Interest"), `fee` ("Fees"); group "Bills"; group "Spending" with "Uncategorized" (`spending`); group "Debt Payments"; group "Savings". Idempotent (no-op when "System" exists).
  - `systemCategoryId(db, kind: 'income'|'transfer'|'reconciliation'|'interest'|'fee'): number` and `uncategorizedId(db): number`

- [ ] **Step 1: Write errors.ts**

```ts
export class InvariantError extends Error {
	constructor(public readonly code: string, message?: string) {
		super(message ?? code);
		this.name = 'InvariantError';
	}
}
```

- [ ] **Step 2: Write the failing tests**

`src/lib/server/ledger/categories.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, connections, categories } from '../db/schema';
import {
	createGroup, createCategory, seedDefaultCategories, paymentCategoryForAccount,
	systemCategoryId, uncategorizedId
} from './categories';
import { InvariantError } from './errors';
import { eq } from 'drizzle-orm';

let db: Db;
let cardId: number;
let checkingId: number;

beforeEach(() => {
	db = openMemoryDatabase().db;
	const conn = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get();
	cardId = db.insert(accounts).values({ connectionId: conn.id, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
	checkingId = db.insert(accounts).values({ connectionId: conn.id, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
});

describe('debt payment category invariants', () => {
	it('requires an account', () => {
		const g = createGroup(db, 'Debt');
		expect(() => createCategory(db, { groupId: g, name: 'Card', kind: 'debt_payment' }))
			.toThrow(InvariantError);
	});
	it('requires the account to be a debt account', () => {
		const g = createGroup(db, 'Debt');
		expect(() => createCategory(db, { groupId: g, name: 'Chk', kind: 'debt_payment', accountId: checkingId }))
			.toThrowError(/DEBT_CATEGORY_ACCOUNT_NOT_DEBT/);
	});
	it('allows one per account and finds it', () => {
		const g = createGroup(db, 'Debt');
		const id = createCategory(db, { groupId: g, name: 'Card', kind: 'debt_payment', accountId: cardId });
		expect(paymentCategoryForAccount(db, cardId)).toBe(id);
		expect(() => createCategory(db, { groupId: g, name: 'Card again', kind: 'debt_payment', accountId: cardId }))
			.toThrowError(/DEBT_CATEGORY_DUPLICATE/);
	});
	it('ignores account on non-debt kinds', () => {
		const g = createGroup(db, 'Spending');
		const id = createCategory(db, { groupId: g, name: 'Groceries', kind: 'spending', accountId: cardId });
		expect(db.select().from(categories).where(eq(categories.id, id)).get()?.accountId).toBeNull();
	});
});

describe('seedDefaultCategories', () => {
	it('creates system categories once', () => {
		seedDefaultCategories(db);
		seedDefaultCategories(db);
		expect(systemCategoryId(db, 'income')).toBeGreaterThan(0);
		expect(systemCategoryId(db, 'transfer')).toBeGreaterThan(0);
		expect(uncategorizedId(db)).toBeGreaterThan(0);
		expect(db.select().from(categories).all().filter((c) => c.kind === 'income').length).toBe(1);
	});
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/lib/server/ledger/categories.test.ts`
Expected: FAIL, cannot find module './categories'.

- [ ] **Step 4: Implement categories.ts**

```ts
import { and, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, categories, categoryGroups, type CategoryKind } from '../db/schema';
import { InvariantError } from './errors';

export function createGroup(db: DbOrTx, name: string, sort = 0): number {
	return db.insert(categoryGroups).values({ name, sort }).returning({ id: categoryGroups.id }).get().id;
}

export function createCategory(
	db: DbOrTx,
	input: { groupId: number; name: string; kind: CategoryKind; accountId?: number | null; sort?: number }
): number {
	let accountId: number | null = null;
	if (input.kind === 'debt_payment') {
		if (input.accountId == null) throw new InvariantError('DEBT_CATEGORY_NEEDS_ACCOUNT');
		const acct = db.select().from(accounts).where(eq(accounts.id, input.accountId)).get();
		if (!acct) throw new InvariantError('DEBT_CATEGORY_NEEDS_ACCOUNT', `account ${input.accountId} not found`);
		if (!acct.isDebt) throw new InvariantError('DEBT_CATEGORY_ACCOUNT_NOT_DEBT');
		if (paymentCategoryForAccount(db, input.accountId) != null) throw new InvariantError('DEBT_CATEGORY_DUPLICATE');
		accountId = input.accountId;
	}
	return db
		.insert(categories)
		.values({ groupId: input.groupId, name: input.name, kind: input.kind, accountId, sort: input.sort ?? 0 })
		.returning({ id: categories.id })
		.get().id;
}

export function renameCategory(db: DbOrTx, id: number, name: string): void {
	db.update(categories).set({ name, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` }).where(eq(categories.id, id)).run();
}

export function hideCategory(db: DbOrTx, id: number, hidden: boolean): void {
	db.update(categories).set({ hidden }).where(eq(categories.id, id)).run();
}

export function moveCategory(db: DbOrTx, id: number, groupId: number, sort: number): void {
	db.update(categories).set({ groupId, sort }).where(eq(categories.id, id)).run();
}

export function paymentCategoryForAccount(db: DbOrTx, accountId: number): number | null {
	const row = db
		.select({ id: categories.id })
		.from(categories)
		.where(and(eq(categories.kind, 'debt_payment'), eq(categories.accountId, accountId)))
		.get();
	return row?.id ?? null;
}

type SystemKind = 'income' | 'transfer' | 'reconciliation' | 'interest' | 'fee';
const SYSTEM: { kind: SystemKind; name: string }[] = [
	{ kind: 'income', name: 'Income' },
	{ kind: 'transfer', name: 'Transfer' },
	{ kind: 'reconciliation', name: 'Reconciliation' },
	{ kind: 'interest', name: 'Interest' },
	{ kind: 'fee', name: 'Fees' }
];

export function seedDefaultCategories(db: DbOrTx): void {
	const exists = db.select().from(categoryGroups).where(eq(categoryGroups.name, 'System')).get();
	if (exists) return;
	db.transaction((tx) => {
		const system = createGroup(tx, 'System', 0);
		SYSTEM.forEach((s, i) => createCategory(tx, { groupId: system, name: s.name, kind: s.kind, sort: i }));
		createGroup(tx, 'Bills', 1);
		const spending = createGroup(tx, 'Spending', 2);
		createCategory(tx, { groupId: spending, name: 'Uncategorized', kind: 'spending', sort: 999 });
		createGroup(tx, 'Debt Payments', 3);
		createGroup(tx, 'Savings', 4);
	});
}

export function systemCategoryId(db: DbOrTx, kind: SystemKind): number {
	const row = db.select({ id: categories.id }).from(categories).where(eq(categories.kind, kind)).get();
	if (!row) throw new Error(`system category ${kind} missing; run seedDefaultCategories`);
	return row.id;
}

export function uncategorizedId(db: DbOrTx): number {
	const row = db
		.select({ id: categories.id })
		.from(categories)
		.where(and(eq(categories.kind, 'spending'), eq(categories.name, 'Uncategorized')))
		.get();
	if (!row) throw new Error('Uncategorized category missing; run seedDefaultCategories');
	return row.id;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/lib/server/ledger/categories.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/ledger/
git commit -m "feat: category service with debt payment invariants"
```

---

### Task 7: Transactions and splits

**Files:**
- Create: `src/lib/server/ledger/transactions.ts`
- Test: `src/lib/server/ledger/transactions.test.ts`

**Interfaces:**
- Consumes: `DbOrTx`, `schema`, `InvariantError`, `periodIdForDate`, `ensurePeriods`.
- Produces:
  - `type SplitInput = { categoryId: number; amount: number; memo?: string | null }`
  - `type NewTransaction = { accountId; externalId; postedDate; transactedAt?; amount; payeeRaw; payee?; memo?; pending?; providerCategory?; pendingExternalId?; source: TransactionSource; splits?: SplitInput[]; periodId?: number }`
  - `createTransaction(db, input: NewTransaction): number` — when `splits` omitted, one split for the whole amount to `categoryId` = Uncategorized; when `periodId` omitted, resolved from posted date (pending rows use `transactedAt`'s date if set). Throws `InvariantError('SPLITS_DO_NOT_SUM')`.
  - `setSplits(db, transactionId, splits: SplitInput[]): void` — replaces; same invariant.
  - `setPeriod(db, transactionId, periodId)`, `setPayee(db, transactionId, payee)`, `setMemo(...)`
  - `linkTransfer(db, aId, bId): void` — throws `InvariantError('TRANSFER_NOT_OPPOSITE')` unless amounts are equal and opposite and accounts differ; `InvariantError('TRANSFER_ALREADY_LINKED')` if either has a peer. Sets both splits to the transfer category.
  - `unlinkTransfer(db, id): void` — clears both sides; leaves categories as they are but flags both `needsReview` with reason `'transfer_unlinked'`.
  - `softDelete(db, id, reason?: string): void`
  - `flagForReview(db, id, reason: string)`, `clearReview(db, id)`
  - `markProcessed(db, ids: number[])`
  - `getTransaction(db, id)` returning the row plus `splits`.

- [ ] **Step 1: Write the failing tests**

`src/lib/server/ledger/transactions.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, connections, transactions, transactionSplits } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, uncategorizedId, systemCategoryId } from './categories';
import { ensurePeriods, periodIdForDate } from '../budget/periods';
import { createTransaction, setSplits, linkTransfer, unlinkTransfer, softDelete, getTransaction } from './transactions';
import { InvariantError } from './errors';
import { eq } from 'drizzle-orm';

let db: Db;
let checking: number;
let card: number;
let groceries: number;

beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-12-31');
	const conn = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get();
	checking = db.insert(accounts).values({ connectionId: conn.id, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
	card = db.insert(accounts).values({ connectionId: conn.id, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
	const g = createGroup(db, 'Spending');
	groceries = createCategory(db, { groupId: g, name: 'Groceries', kind: 'spending' });
});

describe('createTransaction', () => {
	it('defaults to one uncategorized split and the posted period', () => {
		const id = createTransaction(db, {
			accountId: checking, externalId: 'a', postedDate: '2026-03-20', amount: -1234, payeeRaw: 'SHOP', source: 'manual'
		});
		const t = getTransaction(db, id);
		expect(t.splits).toEqual([expect.objectContaining({ categoryId: uncategorizedId(db), amount: -1234 })]);
		expect(t.periodId).toBe(periodIdForDate(db, '2026-03-20'));
		expect(t.payee).toBe('SHOP');
	});
	it('uses the transacted date for the period while pending', () => {
		const id = createTransaction(db, {
			accountId: checking, externalId: 'p', postedDate: '2026-03-16', transactedAt: '2026-03-15T22:00:00Z',
			amount: -500, payeeRaw: 'X', pending: true, source: 'sync'
		});
		expect(getTransaction(db, id).periodId).toBe(periodIdForDate(db, '2026-03-15'));
	});
	it('rejects splits that do not sum to the amount', () => {
		expect(() => createTransaction(db, {
			accountId: checking, externalId: 'b', postedDate: '2026-03-20', amount: -1000, payeeRaw: 'X', source: 'manual',
			splits: [{ categoryId: groceries, amount: -600 }, { categoryId: groceries, amount: -300 }]
		})).toThrowError(/SPLITS_DO_NOT_SUM/);
		expect(db.select().from(transactions).all().length).toBe(0);
	});
});

describe('setSplits', () => {
	it('replaces splits atomically', () => {
		const id = createTransaction(db, { accountId: checking, externalId: 'a', postedDate: '2026-03-20', amount: -1000, payeeRaw: 'X', source: 'manual' });
		setSplits(db, id, [{ categoryId: groceries, amount: -700 }, { categoryId: uncategorizedId(db), amount: -300 }]);
		expect(getTransaction(db, id).splits.map((s) => s.amount).sort()).toEqual([-700, -300].sort());
		expect(() => setSplits(db, id, [{ categoryId: groceries, amount: -1 }])).toThrow(InvariantError);
		expect(getTransaction(db, id).splits.length).toBe(2);
	});
});

describe('transfers', () => {
	it('links equal and opposite transactions and sets the transfer category', () => {
		const a = createTransaction(db, { accountId: checking, externalId: 'a', postedDate: '2026-03-20', amount: -25000, payeeRaw: 'PAYMENT', source: 'manual' });
		const b = createTransaction(db, { accountId: card, externalId: 'b', postedDate: '2026-03-21', amount: 25000, payeeRaw: 'PAYMENT THANK YOU', source: 'manual' });
		linkTransfer(db, a, b);
		const ta = getTransaction(db, a);
		const tb = getTransaction(db, b);
		expect(ta.transferPeerId).toBe(b);
		expect(tb.transferPeerId).toBe(a);
		expect(ta.splits[0].categoryId).toBe(systemCategoryId(db, 'transfer'));
		expect(tb.splits[0].categoryId).toBe(systemCategoryId(db, 'transfer'));
	});
	it('rejects mismatched amounts and double links', () => {
		const a = createTransaction(db, { accountId: checking, externalId: 'a', postedDate: '2026-03-20', amount: -25000, payeeRaw: 'P', source: 'manual' });
		const b = createTransaction(db, { accountId: card, externalId: 'b', postedDate: '2026-03-21', amount: 24000, payeeRaw: 'P', source: 'manual' });
		const c = createTransaction(db, { accountId: card, externalId: 'c', postedDate: '2026-03-21', amount: 25000, payeeRaw: 'P', source: 'manual' });
		expect(() => linkTransfer(db, a, b)).toThrowError(/TRANSFER_NOT_OPPOSITE/);
		linkTransfer(db, a, c);
		const d = createTransaction(db, { accountId: card, externalId: 'd', postedDate: '2026-03-22', amount: 25000, payeeRaw: 'P', source: 'manual' });
		expect(() => linkTransfer(db, a, d)).toThrowError(/TRANSFER_ALREADY_LINKED/);
	});
	it('unlinks both sides and flags them', () => {
		const a = createTransaction(db, { accountId: checking, externalId: 'a', postedDate: '2026-03-20', amount: -100, payeeRaw: 'P', source: 'manual' });
		const b = createTransaction(db, { accountId: card, externalId: 'b', postedDate: '2026-03-20', amount: 100, payeeRaw: 'P', source: 'manual' });
		linkTransfer(db, a, b);
		unlinkTransfer(db, a);
		expect(getTransaction(db, a).transferPeerId).toBeNull();
		expect(getTransaction(db, b).transferPeerId).toBeNull();
		expect(getTransaction(db, b).needsReview).toBe(true);
	});
});

describe('softDelete', () => {
	it('sets deleted_at and keeps the row and splits', () => {
		const id = createTransaction(db, { accountId: checking, externalId: 'a', postedDate: '2026-03-20', amount: -100, payeeRaw: 'P', source: 'sync' });
		softDelete(db, id);
		expect(getTransaction(db, id).deletedAt).not.toBeNull();
		expect(db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, id)).all().length).toBe(1);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/server/ledger/transactions.test.ts`
Expected: FAIL, cannot find module './transactions'.

- [ ] **Step 3: Implement transactions.ts**

```ts
import { eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { transactions, transactionSplits, type TransactionSource } from '../db/schema';
import { periodIdForDate } from '../budget/periods';
import { systemCategoryId, uncategorizedId } from './categories';
import { InvariantError } from './errors';
import { nowIso } from '$lib/dates';

export type SplitInput = { categoryId: number; amount: number; memo?: string | null };

export type NewTransaction = {
	accountId: number;
	externalId: string;
	postedDate: string;
	transactedAt?: string | null;
	amount: number;
	payeeRaw: string;
	payee?: string;
	memo?: string | null;
	pending?: boolean;
	providerCategory?: string | null;
	pendingExternalId?: string | null;
	source: TransactionSource;
	splits?: SplitInput[];
	periodId?: number;
};

const touch = () => ({ updatedAt: nowIso() });

function assertSplitsSum(amount: number, splits: SplitInput[]): void {
	if (splits.length === 0) throw new InvariantError('SPLITS_DO_NOT_SUM', 'a transaction needs at least one split');
	const sum = splits.reduce((s, x) => s + x.amount, 0);
	if (sum !== amount) throw new InvariantError('SPLITS_DO_NOT_SUM', `splits sum ${sum} ≠ amount ${amount}`);
}

export function createTransaction(db: DbOrTx, input: NewTransaction): number {
	const splits = input.splits ?? [{ categoryId: uncategorizedId(db), amount: input.amount }];
	assertSplitsSum(input.amount, splits);
	const dateForPeriod = input.pending && input.transactedAt ? input.transactedAt.slice(0, 10) : input.postedDate;
	const periodId = input.periodId ?? periodIdForDate(db, dateForPeriod);
	return db.transaction((tx) => {
		const id = tx
			.insert(transactions)
			.values({
				accountId: input.accountId,
				externalId: input.externalId,
				pendingExternalId: input.pendingExternalId ?? null,
				postedDate: input.postedDate,
				transactedAt: input.transactedAt ?? null,
				amount: input.amount,
				payeeRaw: input.payeeRaw,
				payee: input.payee ?? input.payeeRaw,
				memo: input.memo ?? null,
				pending: input.pending ?? false,
				providerCategory: input.providerCategory ?? null,
				periodId,
				source: input.source
			})
			.returning({ id: transactions.id })
			.get().id;
		tx.insert(transactionSplits).values(splits.map((s) => ({ transactionId: id, categoryId: s.categoryId, amount: s.amount, memo: s.memo ?? null }))).run();
		return id;
	});
}

export function getTransaction(db: DbOrTx, id: number) {
	const row = db.select().from(transactions).where(eq(transactions.id, id)).get();
	if (!row) throw new Error(`transaction ${id} not found`);
	const splits = db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, id)).all();
	return { ...row, splits };
}

export function setSplits(db: DbOrTx, transactionId: number, splits: SplitInput[]): void {
	const row = db.select({ amount: transactions.amount }).from(transactions).where(eq(transactions.id, transactionId)).get();
	if (!row) throw new Error(`transaction ${transactionId} not found`);
	assertSplitsSum(row.amount, splits);
	db.transaction((tx) => {
		tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, transactionId)).run();
		tx.insert(transactionSplits).values(splits.map((s) => ({ transactionId, categoryId: s.categoryId, amount: s.amount, memo: s.memo ?? null }))).run();
		tx.update(transactions).set(touch()).where(eq(transactions.id, transactionId)).run();
	});
}

export function setPeriod(db: DbOrTx, transactionId: number, periodId: number): void {
	db.update(transactions).set({ periodId, ...touch() }).where(eq(transactions.id, transactionId)).run();
}

export function setPayee(db: DbOrTx, transactionId: number, payee: string): void {
	db.update(transactions).set({ payee, ...touch() }).where(eq(transactions.id, transactionId)).run();
}

export function setMemo(db: DbOrTx, transactionId: number, memo: string | null): void {
	db.update(transactions).set({ memo, ...touch() }).where(eq(transactions.id, transactionId)).run();
}

export function linkTransfer(db: DbOrTx, aId: number, bId: number): void {
	const a = db.select().from(transactions).where(eq(transactions.id, aId)).get();
	const b = db.select().from(transactions).where(eq(transactions.id, bId)).get();
	if (!a || !b) throw new Error('transfer: transaction not found');
	if (a.transferPeerId != null || b.transferPeerId != null) throw new InvariantError('TRANSFER_ALREADY_LINKED');
	if (a.accountId === b.accountId || a.amount !== -b.amount) throw new InvariantError('TRANSFER_NOT_OPPOSITE');
	const transferCat = systemCategoryId(db, 'transfer');
	db.transaction((tx) => {
		tx.update(transactions).set({ transferPeerId: bId, ...touch() }).where(eq(transactions.id, aId)).run();
		tx.update(transactions).set({ transferPeerId: aId, ...touch() }).where(eq(transactions.id, bId)).run();
		for (const [id, amount] of [[aId, a.amount], [bId, b.amount]] as const) {
			tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, id)).run();
			tx.insert(transactionSplits).values({ transactionId: id, categoryId: transferCat, amount }).run();
		}
	});
}

export function unlinkTransfer(db: DbOrTx, id: number): void {
	const a = db.select().from(transactions).where(eq(transactions.id, id)).get();
	if (!a || a.transferPeerId == null) return;
	const peer = a.transferPeerId;
	db.transaction((tx) => {
		for (const x of [id, peer]) {
			tx.update(transactions)
				.set({ transferPeerId: null, needsReview: true, reviewReason: 'transfer_unlinked', ...touch() })
				.where(eq(transactions.id, x))
				.run();
		}
	});
}

export function softDelete(db: DbOrTx, id: number, reason?: string): void {
	// Leave an existing review reason alone unless the caller supplies a new one.
	db.update(transactions)
		.set({ deletedAt: nowIso(), ...(reason ? { reviewReason: reason } : {}), ...touch() })
		.where(eq(transactions.id, id))
		.run();
}

export function flagForReview(db: DbOrTx, id: number, reason: string): void {
	db.update(transactions).set({ needsReview: true, reviewReason: reason, ...touch() }).where(eq(transactions.id, id)).run();
}

export function clearReview(db: DbOrTx, id: number): void {
	db.update(transactions).set({ needsReview: false, reviewReason: null, ...touch() }).where(eq(transactions.id, id)).run();
}

export function markProcessed(db: DbOrTx, ids: number[]): void {
	if (ids.length === 0) return;
	db.update(transactions).set({ processedAt: nowIso() }).where(inArray(transactions.id, ids)).run();
}

export const unprocessedWhere = sql`${transactions.processedAt} is null and ${transactions.deletedAt} is null`;
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/server/ledger/transactions.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/ledger/transactions.ts src/lib/server/ledger/transactions.test.ts
git commit -m "feat: transaction and split service with invariants"
```

---

### Task 8: Assignments and moving money

**Files:**
- Create: `src/lib/server/ledger/assignments.ts`
- Test: `src/lib/server/ledger/assignments.test.ts`

**Interfaces:**
- Consumes: `DbOrTx`, `schema`, `InvariantError`.
- Produces:
  - `assign(db, periodId, categoryId, assigned: number): void` — upsert; throws `InvariantError('ASSIGN_NO_ENVELOPE')` for kinds `income`, `transfer`, `reconciliation`.
  - `moveMoney(db, periodId, fromCategoryId, toCategoryId, amount: number): void` — `amount > 0`; adjusts both assignments in one transaction; same kind check.
  - `assignmentsForPeriod(db, periodId): { categoryId: number; assigned: number }[]`

- [ ] **Step 1: Write the failing tests**

`src/lib/server/ledger/assignments.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { seedDefaultCategories, createGroup, createCategory, systemCategoryId } from './categories';
import { ensurePeriods, periodIdForDate } from '../budget/periods';
import { assign, moveMoney, assignmentsForPeriod } from './assignments';

let db: Db; let p: number; let a: number; let b: number;
beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-01-31');
	p = periodIdForDate(db, '2026-01-05');
	const g = createGroup(db, 'Spending');
	a = createCategory(db, { groupId: g, name: 'A', kind: 'spending' });
	b = createCategory(db, { groupId: g, name: 'B', kind: 'spending' });
});

describe('assign', () => {
	it('upserts', () => {
		assign(db, p, a, 5000);
		assign(db, p, a, 7000);
		expect(assignmentsForPeriod(db, p)).toEqual([{ categoryId: a, assigned: 7000 }]);
	});
	it('refuses kinds without an envelope', () => {
		expect(() => assign(db, p, systemCategoryId(db, 'income'), 100)).toThrowError(/ASSIGN_NO_ENVELOPE/);
		expect(() => assign(db, p, systemCategoryId(db, 'transfer'), 100)).toThrowError(/ASSIGN_NO_ENVELOPE/);
	});
});

describe('moveMoney', () => {
	it('moves between envelopes in one step', () => {
		assign(db, p, a, 5000);
		moveMoney(db, p, a, b, 2000);
		const rows = Object.fromEntries(assignmentsForPeriod(db, p).map((r) => [r.categoryId, r.assigned]));
		expect(rows[a]).toBe(3000);
		expect(rows[b]).toBe(2000);
	});
	it('rejects non-positive amounts', () => {
		expect(() => moveMoney(db, p, a, b, 0)).toThrow();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/server/ledger/assignments.test.ts`
Expected: FAIL, cannot find module './assignments'.

- [ ] **Step 3: Implement assignments.ts**

```ts
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { budgetAssignments, categories } from '../db/schema';
import { InvariantError } from './errors';
import { nowIso } from '$lib/dates';

const NO_ENVELOPE = new Set(['income', 'transfer', 'reconciliation']);

function assertHasEnvelope(db: DbOrTx, categoryId: number): void {
	const c = db.select({ kind: categories.kind }).from(categories).where(eq(categories.id, categoryId)).get();
	if (!c) throw new Error(`category ${categoryId} not found`);
	if (NO_ENVELOPE.has(c.kind)) throw new InvariantError('ASSIGN_NO_ENVELOPE', `${c.kind} categories have no envelope`);
}

function upsert(db: DbOrTx, periodId: number, categoryId: number, delta: number, absolute: boolean): void {
	const existing = db
		.select()
		.from(budgetAssignments)
		.where(and(eq(budgetAssignments.periodId, periodId), eq(budgetAssignments.categoryId, categoryId)))
		.get();
	const next = absolute ? delta : (existing?.assigned ?? 0) + delta;
	if (existing) {
		db.update(budgetAssignments).set({ assigned: next, updatedAt: nowIso() }).where(eq(budgetAssignments.id, existing.id)).run();
	} else {
		db.insert(budgetAssignments).values({ periodId, categoryId, assigned: next }).run();
	}
}

export function assign(db: DbOrTx, periodId: number, categoryId: number, assigned: number): void {
	assertHasEnvelope(db, categoryId);
	upsert(db, periodId, categoryId, assigned, true);
}

export function moveMoney(db: DbOrTx, periodId: number, fromCategoryId: number, toCategoryId: number, amount: number): void {
	if (!(amount > 0)) throw new InvariantError('MOVE_AMOUNT_NOT_POSITIVE');
	assertHasEnvelope(db, fromCategoryId);
	assertHasEnvelope(db, toCategoryId);
	db.transaction((tx) => {
		upsert(tx, periodId, fromCategoryId, -amount, false);
		upsert(tx, periodId, toCategoryId, amount, false);
	});
}

export function assignmentsForPeriod(db: DbOrTx, periodId: number): { categoryId: number; assigned: number }[] {
	return db
		.select({ categoryId: budgetAssignments.categoryId, assigned: budgetAssignments.assigned })
		.from(budgetAssignments)
		.where(eq(budgetAssignments.periodId, periodId))
		.all();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/server/ledger/assignments.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/ledger/assignments.ts src/lib/server/ledger/assignments.test.ts
git commit -m "feat: budget assignments and move money"
```

---

### Task 9: Envelope math (pure)

This task is the heart of the plan. Every formula in spec §7 lives here and nowhere else. The function takes plain arrays and returns numbers; it never touches the database.

**Files:**
- Create: `src/lib/server/budget/envelope.ts`
- Test: `src/lib/server/budget/envelope.test.ts`

**Interfaces:**
- Consumes: `CASH_TYPES`, `AccountType`, `CategoryKind`, `TransactionSource` from schema (types only).
- Produces:

```ts
export type EnvAccount = { id: number; type: AccountType; onBudget: boolean };
export type EnvCategory = { id: number; kind: CategoryKind; accountId: number | null };
export type EnvPeriod = { id: number; startDate: string };
/** One split, flattened with what the math needs from its transaction. */
export type EnvSplit = {
	transactionId: number; accountId: number; periodId: number; categoryId: number;
	amount: number; transferPeerAccountId: number | null; source: TransactionSource;
};
export type EnvAssignment = { periodId: number; categoryId: number; assigned: number };
export type EnvBalance = { accountId: number; current: number };
export type BudgetInput = {
	accounts: EnvAccount[]; categories: EnvCategory[]; periods: EnvPeriod[];
	splits: EnvSplit[]; assignments: EnvAssignment[]; balances: EnvBalance[];
};
export type CategoryPeriod = {
	carried: number; assigned: number; activity: number; available: number;
	creditOverspend: number; cashOverspend: number;
};
export type BudgetResult = {
	byPeriod: Map<number, Map<number, CategoryPeriod>>; // periodId → categoryId
	readyToAssign: number;                               // §7.3 for currentPeriodId
	readyToAssignFromFlows: number;                      // §7.5 for currentPeriodId
	underfunded: Map<number, number>;                    // card accountId → cents (§7.4)
	cardBalanceOwed: Map<number, number>;
};
export function computeBudget(input: BudgetInput, currentPeriodId: number): BudgetResult;
export function isCashAccount(a: EnvAccount): boolean;
```

- [ ] **Step 1: Write the failing scenario tests**

`src/lib/server/budget/envelope.test.ts`. Scenario helpers build inputs; ids are fixed constants so failures read clearly.

```ts
import { describe, it, expect } from 'vitest';
import { computeBudget, type BudgetInput, type EnvSplit } from './envelope';

// Fixed ids
const CHECKING = 1, SAVINGS = 2, CARD = 3, LOAN = 4;
const INCOME = 10, TRANSFER = 11, RECON = 12;
const GROCERIES = 20, RENT = 21, INTEREST = 22;
const CARD_ENV = 30, LOAN_ENV = 31, SAVINGS_ENV = 32;
const P1 = 1, P2 = 2, P3 = 3;

function base(): BudgetInput {
	return {
		accounts: [
			{ id: CHECKING, type: 'checking', onBudget: true },
			{ id: SAVINGS, type: 'savings', onBudget: true },
			{ id: CARD, type: 'credit', onBudget: true },
			{ id: LOAN, type: 'loan', onBudget: false }
		],
		categories: [
			{ id: INCOME, kind: 'income', accountId: null },
			{ id: TRANSFER, kind: 'transfer', accountId: null },
			{ id: RECON, kind: 'reconciliation', accountId: null },
			{ id: GROCERIES, kind: 'spending', accountId: null },
			{ id: RENT, kind: 'bill', accountId: null },
			{ id: INTEREST, kind: 'interest', accountId: null },
			{ id: CARD_ENV, kind: 'debt_payment', accountId: CARD },
			{ id: LOAN_ENV, kind: 'debt_payment', accountId: LOAN },
			{ id: SAVINGS_ENV, kind: 'savings', accountId: null }
		],
		periods: [
			{ id: P1, startDate: '2026-01-01' },
			{ id: P2, startDate: '2026-01-16' },
			{ id: P3, startDate: '2026-02-01' }
		],
		splits: [],
		assignments: [],
		balances: []
	};
}

let nextTx = 1000;
function split(p: Partial<EnvSplit> & Pick<EnvSplit, 'accountId' | 'periodId' | 'categoryId' | 'amount'>): EnvSplit {
	return { transactionId: nextTx++, transferPeerAccountId: null, source: 'sync', ...p };
}
/** Opening balance on a cash account. */
function opening(accountId: number, periodId: number, amount: number): EnvSplit {
	return split({ accountId, periodId, categoryId: RECON, amount, source: 'opening' });
}
/** Both halves of a transfer from `from` to `to` of `amount` (positive). */
function transfer(from: number, to: number, periodId: number, amount: number): EnvSplit[] {
	return [
		split({ accountId: from, periodId, categoryId: TRANSFER, amount: -amount, transferPeerAccountId: to }),
		split({ accountId: to, periodId, categoryId: TRANSFER, amount, transferPeerAccountId: from })
	];
}
/** Balances derived from splits: a reconciled ledger. */
function reconcile(input: BudgetInput): BudgetInput {
	const totals = new Map<number, number>();
	for (const s of input.splits) totals.set(s.accountId, (totals.get(s.accountId) ?? 0) + s.amount);
	return { ...input, balances: input.accounts.map((a) => ({ accountId: a.id, current: totals.get(a.id) ?? 0 })) };
}
function avail(r: ReturnType<typeof computeBudget>, p: number, c: number) {
	return r.byPeriod.get(p)!.get(c)!.available;
}

describe('§7 hand-built scenarios', () => {
	it('$80 on the card with $50 available: credit overspend never reaches RTA', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P1, categoryId: GROCERIES, assigned: 5000 });
		const before = computeBudget(reconcile(input), P1);
		expect(before.readyToAssign).toBe(95000);

		input.splits.push(split({ accountId: CARD, periodId: P1, categoryId: GROCERIES, amount: -8000 }));
		const r = computeBudget(reconcile(input), P1);
		expect(avail(r, P1, GROCERIES)).toBe(-3000);
		expect(r.byPeriod.get(P1)!.get(GROCERIES)!.creditOverspend).toBe(3000);
		expect(r.byPeriod.get(P1)!.get(GROCERIES)!.cashOverspend).toBe(0);
		expect(avail(r, P1, CARD_ENV)).toBe(5000);   // only the covered $50 moved
		expect(r.readyToAssign).toBe(95000);         // unchanged: no cash moved
		expect(r.readyToAssignFromFlows).toBe(95000);
		expect(r.underfunded.get(CARD)).toBe(3000);  // card owes 80, envelope holds 50
	});

	it('cash overspend leaves RTA immediately and is zeroed at rollover', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P1, categoryId: GROCERIES, assigned: 5000 });
		input.splits.push(split({ accountId: CHECKING, periodId: P1, categoryId: GROCERIES, amount: -8000 }));
		const r1 = computeBudget(reconcile(input), P1);
		expect(avail(r1, P1, GROCERIES)).toBe(-3000);
		expect(r1.byPeriod.get(P1)!.get(GROCERIES)!.cashOverspend).toBe(3000);
		expect(r1.readyToAssign).toBe(92000);
		expect(r1.readyToAssignFromFlows).toBe(92000);
		const r2 = computeBudget(reconcile(input), P2);
		expect(r2.byPeriod.get(P2)!.get(GROCERIES)!.carried).toBe(0);
		expect(r2.readyToAssign).toBe(92000);
		expect(r2.readyToAssignFromFlows).toBe(92000);
	});

	it('cash and card overspend in the same period charge card spending first', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P1, categoryId: GROCERIES, assigned: 5000 });
		input.splits.push(split({ accountId: CHECKING, periodId: P1, categoryId: GROCERIES, amount: -4000 }));
		input.splits.push(split({ accountId: CARD, periodId: P1, categoryId: GROCERIES, amount: -3000 }));
		const r = computeBudget(reconcile(input), P1);
		const g = r.byPeriod.get(P1)!.get(GROCERIES)!;
		expect(g.available).toBe(-2000);
		expect(g.creditOverspend).toBe(2000);
		expect(g.cashOverspend).toBe(0);
		expect(avail(r, P1, CARD_ENV)).toBe(1000); // 3000 spent, 2000 uncovered
		expect(r.readyToAssign).toBe(r.readyToAssignFromFlows);
	});

	it('paying the card above its envelope drives the envelope negative and RTA down', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P1, categoryId: CARD_ENV, assigned: 5000 });
		input.splits.push(...transfer(CHECKING, CARD, P1, 10000));
		const r = computeBudget(reconcile(input), P1);
		expect(avail(r, P1, CARD_ENV)).toBe(-5000);
		expect(r.readyToAssign).toBe(90000);          // cash 90000; the negative envelope adds nothing to positive available
		expect(r.readyToAssignFromFlows).toBe(90000); // 100000 − 5000 assigned − 5000 negative card envelope
		const r2 = computeBudget(reconcile(input), P2);
		expect(r2.byPeriod.get(P2)!.get(CARD_ENV)!.carried).toBe(-5000); // no floor
	});

	it('a loan payment is spending-like and leaves the budget through cash', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P1, categoryId: LOAN_ENV, assigned: 87829 });
		input.splits.push(split({ accountId: CHECKING, periodId: P1, categoryId: LOAN_ENV, amount: -87829, transferPeerAccountId: LOAN }));
		const r = computeBudget(reconcile(input), P1);
		expect(avail(r, P1, LOAN_ENV)).toBe(0);
		expect(r.readyToAssign).toBe(100000 - 87829);
		expect(r.readyToAssign).toBe(r.readyToAssignFromFlows);
	});

	it('a late transaction reassigned into a past period changes every carry after it', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P1, categoryId: GROCERIES, assigned: 5000 });
		const r0 = computeBudget(reconcile(input), P3);
		expect(r0.byPeriod.get(P3)!.get(GROCERIES)!.carried).toBe(5000);
		input.splits.push(split({ accountId: CHECKING, periodId: P1, categoryId: GROCERIES, amount: -2000 }));
		const r1 = computeBudget(reconcile(input), P3);
		expect(r1.byPeriod.get(P2)!.get(GROCERIES)!.carried).toBe(3000);
		expect(r1.byPeriod.get(P3)!.get(GROCERIES)!.carried).toBe(3000);
	});

	it('a refund on the card in a net-refund period does not create negative overspend', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.splits.push(split({ accountId: CARD, periodId: P1, categoryId: GROCERIES, amount: 2500 }));
		const r = computeBudget(reconcile(input), P1);
		const g = r.byPeriod.get(P1)!.get(GROCERIES)!;
		expect(g.creditOverspend).toBe(0);
		expect(g.available).toBe(2500);
		expect(avail(r, P1, CARD_ENV)).toBe(-2500); // the card owes less; money leaves the envelope
		expect(r.readyToAssign).toBe(r.readyToAssignFromFlows);
	});

	it('future assignments reduce current RTA', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P2, categoryId: RENT, assigned: 20000 });
		const r = computeBudget(reconcile(input), P1);
		expect(r.readyToAssign).toBe(80000);
		expect(r.readyToAssignFromFlows).toBe(80000);
	});

	it('a period with no assignments and income only', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 0));
		input.splits.push(split({ accountId: CHECKING, periodId: P1, categoryId: INCOME, amount: 319200 }));
		const r = computeBudget(reconcile(input), P1);
		expect(r.readyToAssign).toBe(319200);
		expect(r.readyToAssignFromFlows).toBe(319200);
	});

	it('interest charged on the card moves money from the Interest envelope into the card envelope', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P1, categoryId: INTEREST, assigned: 3000 });
		input.splits.push(split({ accountId: CARD, periodId: P1, categoryId: INTEREST, amount: -2600 }));
		const r = computeBudget(reconcile(input), P1);
		expect(avail(r, P1, INTEREST)).toBe(400);
		expect(avail(r, P1, CARD_ENV)).toBe(2600);
		expect(r.readyToAssign).toBe(97000);
		expect(r.readyToAssign).toBe(r.readyToAssignFromFlows);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/server/budget/envelope.test.ts`
Expected: FAIL, cannot find module './envelope'.

- [ ] **Step 3: Implement envelope.ts**

```ts
import { CASH_TYPES, type AccountType, type CategoryKind, type TransactionSource } from '../db/schema';

export type EnvAccount = { id: number; type: AccountType; onBudget: boolean };
export type EnvCategory = { id: number; kind: CategoryKind; accountId: number | null };
export type EnvPeriod = { id: number; startDate: string };
export type EnvSplit = {
	transactionId: number; accountId: number; periodId: number; categoryId: number;
	amount: number; transferPeerAccountId: number | null; source: TransactionSource;
};
export type EnvAssignment = { periodId: number; categoryId: number; assigned: number };
export type EnvBalance = { accountId: number; current: number };
export type BudgetInput = {
	accounts: EnvAccount[]; categories: EnvCategory[]; periods: EnvPeriod[];
	splits: EnvSplit[]; assignments: EnvAssignment[]; balances: EnvBalance[];
};
export type CategoryPeriod = {
	carried: number; assigned: number; activity: number; available: number;
	creditOverspend: number; cashOverspend: number;
};
export type BudgetResult = {
	byPeriod: Map<number, Map<number, CategoryPeriod>>;
	readyToAssign: number;
	readyToAssignFromFlows: number;
	underfunded: Map<number, number>;
	cardBalanceOwed: Map<number, number>;
};

const NO_ENVELOPE: ReadonlySet<CategoryKind> = new Set(['income', 'transfer', 'reconciliation']);

/** §4.1: the only accounts whose cash counts toward ready-to-assign. */
export function isCashAccount(a: EnvAccount): boolean {
	return a.onBudget && (CASH_TYPES as readonly string[]).includes(a.type);
}

const key2 = (a: number, b: number) => `${a}:${b}`;
const key3 = (a: number, b: number, c: number) => `${a}:${b}:${c}`;
const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

/** Distribute `total` across `weights` proportionally with largest-remainder rounding. */
function apportion(total: number, weights: Map<number, number>): Map<number, number> {
	const out = new Map<number, number>();
	const sum = [...weights.values()].reduce((s, w) => s + w, 0);
	if (total === 0 || sum === 0) return out;
	let allocated = 0;
	const rem: { id: number; frac: number }[] = [];
	for (const [id, w] of weights) {
		const exact = (total * w) / sum;
		const floor = Math.floor(exact);
		out.set(id, floor);
		allocated += floor;
		rem.push({ id, frac: exact - floor });
	}
	rem.sort((a, b) => b.frac - a.frac);
	for (let i = 0; allocated < total && i < rem.length; i++, allocated++) {
		out.set(rem[i].id, out.get(rem[i].id)! + 1);
	}
	return out;
}

export function computeBudget(input: BudgetInput, currentPeriodId: number): BudgetResult {
	const periods = [...input.periods].sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
	const periodIndex = new Map(periods.map((p, i) => [p.id, i]));
	if (!periodIndex.has(currentPeriodId)) throw new Error(`period ${currentPeriodId} not in input`);
	const currentIdx = periodIndex.get(currentPeriodId)!;

	const cashIds = new Set(input.accounts.filter(isCashAccount).map((a) => a.id));
	const onBudgetIds = new Set(input.accounts.filter((a) => a.onBudget).map((a) => a.id));
	const cardIds = new Set(input.accounts.filter((a) => a.onBudget && a.type === 'credit').map((a) => a.id));

	const kindById = new Map(input.categories.map((c) => [c.id, c.kind]));
	const isCardEnvelope = (c: EnvCategory) => c.kind === 'debt_payment' && c.accountId != null && cardIds.has(c.accountId);
	const isSpendingLike = (c: EnvCategory) => !NO_ENVELOPE.has(c.kind) && !isCardEnvelope(c);
	const spendingLike = input.categories.filter(isSpendingLike);
	const cardEnvelopes = input.categories.filter(isCardEnvelope);

	// ---- index the ledger ------------------------------------------------
	const splitsByPC = new Map<string, number>();       // period:category → Σ amount on on-budget accounts
	const cardSplitsByPCX = new Map<string, number>();  // period:category:card → Σ amount on that card
	const paymentsByPX = new Map<string, number>();     // period:card → Σ payments from cash to card (positive)
	const cashInflowsByP = new Map<number, number>();   // period → opening + adjustment + income on cash accounts
	const cardOwedAll = new Map<number, number>();      // card → −Σ amounts (balance owed) from splits
	for (const s of input.splits) {
		if (onBudgetIds.has(s.accountId)) bump(splitsByPC, key2(s.periodId, s.categoryId), s.amount);
		if (cardIds.has(s.accountId)) {
			bump(cardSplitsByPCX, key3(s.periodId, s.categoryId, s.accountId), s.amount);
			cardOwedAll.set(s.accountId, (cardOwedAll.get(s.accountId) ?? 0) - s.amount);
		}
		if (cashIds.has(s.accountId) && s.transferPeerAccountId != null && cardIds.has(s.transferPeerAccountId)) {
			bump(paymentsByPX, key2(s.periodId, s.transferPeerAccountId), -s.amount);
		}
		if (cashIds.has(s.accountId)) {
			if (s.source === 'opening' || s.source === 'adjustment' || kindById.get(s.categoryId) === 'income') {
				cashInflowsByP.set(s.periodId, (cashInflowsByP.get(s.periodId) ?? 0) + s.amount);
			}
		}
	}
	const assignedByPC = new Map<string, number>();
	const assignedByP = new Map<number, number>();
	for (const a of input.assignments) {
		bump(assignedByPC, key2(a.periodId, a.categoryId), a.assigned);
		assignedByP.set(a.periodId, (assignedByP.get(a.periodId) ?? 0) + a.assigned);
	}

	// ---- walk periods in order --------------------------------------------
	const byPeriod = new Map<number, Map<number, CategoryPeriod>>();
	const carried = new Map<number, number>();
	const cashOverspendByP = new Map<number, number>();

	for (const p of periods) {
		const row = new Map<number, CategoryPeriod>();
		const creditOsOnCard = new Map<number, number>();   // card → Σ credit overspend attributed this period
		let cashOsTotal = 0;

		// Pass 1: spending-like categories (§7.1, §7.2 first bullet)
		for (const c of spendingLike) {
			const carry = carried.get(c.id) ?? 0;
			const assigned = assignedByPC.get(key2(p.id, c.id)) ?? 0;
			const activity = splitsByPC.get(key2(p.id, c.id)) ?? 0;
			const gross = carry + assigned + activity;
			const overspend = Math.max(0, -gross);
			const purchasesByCard = new Map<number, number>();
			let cardNet = 0;
			for (const x of cardIds) {
				const cs = cardSplitsByPCX.get(key3(p.id, c.id, x)) ?? 0;
				cardNet += cs;
				if (cs < 0) purchasesByCard.set(x, -cs);
			}
			const creditOverspend = Math.min(overspend, Math.max(0, -cardNet));
			const cashOverspend = overspend - creditOverspend;
			for (const [x, share] of apportion(creditOverspend, purchasesByCard)) {
				creditOsOnCard.set(x, (creditOsOnCard.get(x) ?? 0) + share);
			}
			cashOsTotal += cashOverspend;
			row.set(c.id, { carried: carry, assigned, activity, available: gross, creditOverspend, cashOverspend });
			carried.set(c.id, Math.max(0, gross));
		}

		// Pass 2: card payment envelopes (§7.2 second bullet)
		for (const c of cardEnvelopes) {
			const x = c.accountId!;
			const carry = carried.get(c.id) ?? 0;
			const assigned = assignedByPC.get(key2(p.id, c.id)) ?? 0;
			let moneyIn = 0;
			for (const sc of spendingLike) moneyIn -= cardSplitsByPCX.get(key3(p.id, sc.id, x)) ?? 0;
			const activity = moneyIn - (creditOsOnCard.get(x) ?? 0) - (paymentsByPX.get(key2(p.id, x)) ?? 0);
			const available = carry + assigned + activity;
			row.set(c.id, { carried: carry, assigned, activity, available, creditOverspend: 0, cashOverspend: 0 });
			carried.set(c.id, available);
		}

		cashOverspendByP.set(p.id, cashOsTotal);
		byPeriod.set(p.id, row);
	}

	// ---- §7.3 ready to assign from balances --------------------------------
	const cash = input.balances.filter((b) => cashIds.has(b.accountId)).reduce((s, b) => s + b.current, 0);
	const current = byPeriod.get(currentPeriodId)!;
	let positiveAvailable = 0;
	let negativeCardEnvelopes = 0;
	for (const c of input.categories) {
		const cp = current.get(c.id);
		if (!cp) continue;
		positiveAvailable += Math.max(0, cp.available);
		if (isCardEnvelope(c)) negativeCardEnvelopes += Math.max(0, -cp.available);
	}
	let futureAssigned = 0;
	for (const p of periods) if (periodIndex.get(p.id)! > currentIdx) futureAssigned += assignedByP.get(p.id) ?? 0;
	const readyToAssign = cash - positiveAvailable - futureAssigned;

	// ---- §7.5 ready to assign from flows ------------------------------------
	let inflows = 0, assignedThrough = 0, cashOsThrough = 0;
	for (const p of periods) {
		if (periodIndex.get(p.id)! > currentIdx) continue;
		inflows += cashInflowsByP.get(p.id) ?? 0;
		assignedThrough += assignedByP.get(p.id) ?? 0;
		cashOsThrough += cashOverspendByP.get(p.id) ?? 0;
	}
	const readyToAssignFromFlows = inflows - assignedThrough - cashOsThrough - negativeCardEnvelopes - futureAssigned;

	// ---- §7.4 card underfunding ---------------------------------------------
	const underfunded = new Map<number, number>();
	const cardBalanceOwed = new Map<number, number>();
	for (const c of cardEnvelopes) {
		const x = c.accountId!;
		const bal = input.balances.find((b) => b.accountId === x);
		const owed = bal ? -bal.current : (cardOwedAll.get(x) ?? 0);
		cardBalanceOwed.set(x, owed);
		underfunded.set(x, Math.max(0, owed - current.get(c.id)!.available));
	}

	return { byPeriod, readyToAssign, readyToAssignFromFlows, underfunded, cardBalanceOwed };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/server/budget/envelope.test.ts`
Expected: PASS (10 tests). Every expected number in these tests was derived by hand from spec §7; if one fails, re-derive it from the spec before changing either the test or the code.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/budget/envelope.ts src/lib/server/budget/envelope.test.ts
git commit -m "feat: pure envelope math per spec section 7"
```

---

### Task 10: Conservation property test

**Files:**
- Test: `src/lib/server/budget/envelope.property.test.ts`

**Interfaces:**
- Consumes: `computeBudget`, `BudgetInput`, `EnvSplit` (Task 9); `fast-check`.

- [ ] **Step 1: Write the property test**

```ts
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeBudget, type BudgetInput, type EnvSplit } from './envelope';

const CHECKING = 1, SAVINGS = 2, CARD = 3, CARD2 = 5, LOAN = 4;
const INCOME = 10, TRANSFER = 11, RECON = 12;
const GROCERIES = 20, RENT = 21, INTEREST = 22, FEES = 23;
const CARD_ENV = 30, CARD2_ENV = 33, LOAN_ENV = 31, SAVINGS_ENV = 32;
const ENVELOPES = [GROCERIES, RENT, INTEREST, FEES, CARD_ENV, CARD2_ENV, LOAN_ENV, SAVINGS_ENV];
const SPENDING = [GROCERIES, RENT, INTEREST, FEES];

function skeleton(nPeriods: number): BudgetInput {
	return {
		accounts: [
			{ id: CHECKING, type: 'checking', onBudget: true },
			{ id: SAVINGS, type: 'savings', onBudget: true },
			{ id: CARD, type: 'credit', onBudget: true },
			{ id: CARD2, type: 'credit', onBudget: true },
			{ id: LOAN, type: 'loan', onBudget: false }
		],
		categories: [
			{ id: INCOME, kind: 'income', accountId: null },
			{ id: TRANSFER, kind: 'transfer', accountId: null },
			{ id: RECON, kind: 'reconciliation', accountId: null },
			{ id: GROCERIES, kind: 'spending', accountId: null },
			{ id: RENT, kind: 'bill', accountId: null },
			{ id: INTEREST, kind: 'interest', accountId: null },
			{ id: FEES, kind: 'fee', accountId: null },
			{ id: CARD_ENV, kind: 'debt_payment', accountId: CARD },
			{ id: CARD2_ENV, kind: 'debt_payment', accountId: CARD2 },
			{ id: LOAN_ENV, kind: 'debt_payment', accountId: LOAN },
			{ id: SAVINGS_ENV, kind: 'savings', accountId: null }
		],
		periods: Array.from({ length: nPeriods }, (_, i) => ({ id: i + 1, startDate: `2026-${String(Math.floor(i / 2) + 1).padStart(2, '0')}-${i % 2 === 0 ? '01' : '16'}` })),
		splits: [], assignments: [], balances: []
	};
}

type Event =
	| { t: 'income'; amount: number }
	| { t: 'purchase'; account: number; category: number; amount: number }
	| { t: 'refund'; account: number; category: number; amount: number }
	| { t: 'payment'; card: number; amount: number }
	| { t: 'loan'; amount: number }
	| { t: 'save'; amount: number }
	| { t: 'assign'; category: number; amount: number }
	| { t: 'adjust'; amount: number };

const cents = (max: number) => fc.integer({ min: 1, max });
const event: fc.Arbitrary<Event> = fc.oneof(
	fc.record({ t: fc.constant('income' as const), amount: cents(400000) }),
	fc.record({ t: fc.constant('purchase' as const), account: fc.constantFrom(CHECKING, CARD, CARD2), category: fc.constantFrom(...SPENDING), amount: cents(30000) }),
	fc.record({ t: fc.constant('refund' as const), account: fc.constantFrom(CHECKING, CARD, CARD2), category: fc.constantFrom(...SPENDING), amount: cents(5000) }),
	fc.record({ t: fc.constant('payment' as const), card: fc.constantFrom(CARD, CARD2), amount: cents(50000) }),
	fc.record({ t: fc.constant('loan' as const), amount: cents(90000) }),
	fc.record({ t: fc.constant('save' as const), amount: cents(60000) }),
	fc.record({ t: fc.constant('assign' as const), category: fc.constantFrom(...ENVELOPES), amount: fc.integer({ min: -20000, max: 60000 }) }),
	fc.record({ t: fc.constant('adjust' as const), amount: fc.integer({ min: -3000, max: 3000 }) })
);

const ledger = fc
	.tuple(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 800000 }))
	.chain(([n, opening]) =>
		fc.array(fc.array(event, { minLength: 0, maxLength: 12 }), { minLength: n, maxLength: n })
			.map((perPeriod) => build(n, opening, perPeriod))
	);

function build(n: number, opening: number, perPeriod: Event[][]): BudgetInput {
	const input = skeleton(n);
	let tx = 1;
	const push = (s: Omit<EnvSplit, 'transactionId'>) => input.splits.push({ transactionId: tx++, ...s });
	push({ accountId: CHECKING, periodId: 1, categoryId: RECON, amount: opening, transferPeerAccountId: null, source: 'opening' });
	perPeriod.forEach((events, i) => {
		const p = i + 1;
		for (const e of events) {
			switch (e.t) {
				case 'income': push({ accountId: CHECKING, periodId: p, categoryId: INCOME, amount: e.amount, transferPeerAccountId: null, source: 'sync' }); break;
				case 'purchase': push({ accountId: e.account, periodId: p, categoryId: e.category, amount: -e.amount, transferPeerAccountId: null, source: 'sync' }); break;
				case 'refund': push({ accountId: e.account, periodId: p, categoryId: e.category, amount: e.amount, transferPeerAccountId: null, source: 'sync' }); break;
				case 'payment':
					push({ accountId: CHECKING, periodId: p, categoryId: TRANSFER, amount: -e.amount, transferPeerAccountId: e.card, source: 'sync' });
					push({ accountId: e.card, periodId: p, categoryId: TRANSFER, amount: e.amount, transferPeerAccountId: CHECKING, source: 'sync' });
					break;
				case 'loan': push({ accountId: CHECKING, periodId: p, categoryId: LOAN_ENV, amount: -e.amount, transferPeerAccountId: LOAN, source: 'sync' }); break;
				case 'save':
					push({ accountId: CHECKING, periodId: p, categoryId: TRANSFER, amount: -e.amount, transferPeerAccountId: SAVINGS, source: 'sync' });
					push({ accountId: SAVINGS, periodId: p, categoryId: TRANSFER, amount: e.amount, transferPeerAccountId: CHECKING, source: 'sync' });
					break;
				case 'assign': input.assignments.push({ periodId: p, categoryId: e.category, assigned: e.amount }); break;
				case 'adjust': push({ accountId: CHECKING, periodId: p, categoryId: RECON, amount: e.amount, transferPeerAccountId: null, source: 'adjustment' }); break;
			}
		}
	});
	return input;
}

/** Balances as of the end of period P, i.e. a reconciled ledger viewed from P. */
function balancesThrough(input: BudgetInput, P: number): BudgetInput['balances'] {
	const totals = new Map<number, number>();
	for (const s of input.splits) if (s.periodId <= P) totals.set(s.accountId, (totals.get(s.accountId) ?? 0) + s.amount);
	return input.accounts.map((a) => ({ accountId: a.id, current: totals.get(a.id) ?? 0 }));
}

describe('§7.5 conservation', () => {
	it('ready-to-assign from balances equals ready-to-assign from flows for every period of any reconciled ledger', () => {
		fc.assert(
			fc.property(ledger, (input) => {
				for (const p of input.periods) {
					const r = computeBudget({ ...input, balances: balancesThrough(input, p.id) }, p.id);
					expect(r.readyToAssign).toBe(r.readyToAssignFromFlows);
				}
			}),
			{ numRuns: 500 }
		);
	});
});
```

Note on future assignments: `balancesThrough` excludes future-period splits but `computeBudget` still subtracts future assignments in both formulas, so the identity holds for every P.

- [ ] **Step 2: Run it**

Run: `npx vitest run src/lib/server/budget/envelope.property.test.ts`
Expected: PASS. If it fails, fast-check prints a shrunk counterexample: a minimal list of events. Reproduce it as a hand-built scenario in `envelope.test.ts` before touching `envelope.ts`, and check the derivation in spec §7.5 to decide whether the code or the spec is wrong. Do not change the flows formula to match the balances formula without a derivation.

- [ ] **Step 3: Commit**

```bash
git add src/lib/server/budget/envelope.property.test.ts
git commit -m "test: two-way ready-to-assign conservation property"
```

---

### Task 11: Load the envelope input from the database

**Files:**
- Create: `src/lib/server/budget/load.ts`
- Test: `src/lib/server/budget/load.test.ts`

**Interfaces:**
- Consumes: `DbOrTx`, `schema`, `BudgetInput`, ledger service functions.
- Produces:
  - `loadBudgetInput(db: DbOrTx): BudgetInput` — non-deleted transactions only; `transferPeerAccountId` resolved via self-join; balances = latest `account_balances` row per account (by `as_of` then `id`), falling back to the transaction sum when an account has no balance row.
  - `budgetForPeriod(db: DbOrTx, periodId: number): BudgetResult` — convenience wrapper.

- [ ] **Step 1: Write the failing integration test**

`src/lib/server/budget/load.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openMemoryDatabase } from '../db';
import { accounts, accountBalances, connections } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, systemCategoryId } from '../ledger/categories';
import { createTransaction, linkTransfer, softDelete } from '../ledger/transactions';
import { assign } from '../ledger/assignments';
import { ensurePeriods, periodIdForDate } from './periods';
import { loadBudgetInput, budgetForPeriod } from './load';

describe('loadBudgetInput', () => {
	it('reproduces the $80 grocery scenario end to end through the database', () => {
		const { db } = openMemoryDatabase();
		seedDefaultCategories(db);
		ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-01-31');
		const p1 = periodIdForDate(db, '2026-01-05');
		const conn = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get();
		const checking = db.insert(accounts).values({ connectionId: conn.id, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
		const card = db.insert(accounts).values({ connectionId: conn.id, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
		const g = createGroup(db, 'Spending');
		const groceries = createCategory(db, { groupId: g, name: 'Groceries', kind: 'spending' });
		const dg = createGroup(db, 'Debt');
		const cardEnv = createCategory(db, { groupId: dg, name: 'Card', kind: 'debt_payment', accountId: card });

		createTransaction(db, { accountId: checking, externalId: 'open', postedDate: '2026-01-01', amount: 100000, payeeRaw: 'Opening', source: 'opening',
			splits: [{ categoryId: systemCategoryId(db, 'reconciliation'), amount: 100000 }] });
		db.insert(accountBalances).values({ accountId: checking, asOf: '2026-01-10', current: 100000, source: 'manual' }).run();
		db.insert(accountBalances).values({ accountId: card, asOf: '2026-01-10', current: -8000, source: 'manual' }).run();
		assign(db, p1, groceries, 5000);
		createTransaction(db, { accountId: card, externalId: 'g', postedDate: '2026-01-06', amount: -8000, payeeRaw: 'GROCER', source: 'sync',
			splits: [{ categoryId: groceries, amount: -8000 }] });

		const input = loadBudgetInput(db);
		expect(input.splits.length).toBe(2);
		expect(input.balances.find((b) => b.accountId === card)?.current).toBe(-8000);

		const r = budgetForPeriod(db, p1);
		expect(r.byPeriod.get(p1)!.get(groceries)!.available).toBe(-3000);
		expect(r.byPeriod.get(p1)!.get(cardEnv)!.available).toBe(5000);
		expect(r.readyToAssign).toBe(95000);
		expect(r.readyToAssignFromFlows).toBe(95000);
		expect(r.underfunded.get(card)).toBe(3000);
	});

	it('resolves transfer peers and ignores soft-deleted rows', () => {
		const { db } = openMemoryDatabase();
		seedDefaultCategories(db);
		ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-01-31');
		const conn = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get();
		const checking = db.insert(accounts).values({ connectionId: conn.id, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
		const card = db.insert(accounts).values({ connectionId: conn.id, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
		const a = createTransaction(db, { accountId: checking, externalId: 'a', postedDate: '2026-01-06', amount: -500, payeeRaw: 'P', source: 'sync' });
		const b = createTransaction(db, { accountId: card, externalId: 'b', postedDate: '2026-01-06', amount: 500, payeeRaw: 'P', source: 'sync' });
		linkTransfer(db, a, b);
		const gone = createTransaction(db, { accountId: checking, externalId: 'z', postedDate: '2026-01-07', amount: -999, payeeRaw: 'Z', source: 'sync' });
		softDelete(db, gone);
		const input = loadBudgetInput(db);
		expect(input.splits.length).toBe(2);
		expect(input.splits.find((s) => s.accountId === checking)?.transferPeerAccountId).toBe(card);
		expect(input.balances.find((bb) => bb.accountId === checking)?.current).toBe(-500); // fallback: sum of live transactions
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/server/budget/load.test.ts`
Expected: FAIL, cannot find module './load'.

- [ ] **Step 3: Implement load.ts**

```ts
import { alias } from 'drizzle-orm/sqlite-core';
import { desc, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, accountBalances, budgetAssignments, categories, periods, transactions, transactionSplits } from '../db/schema';
import { computeBudget, type BudgetInput, type BudgetResult } from './envelope';

export function loadBudgetInput(db: DbOrTx): BudgetInput {
	const accountRows = db.select({ id: accounts.id, type: accounts.type, onBudget: accounts.onBudget }).from(accounts).all();
	const categoryRows = db.select({ id: categories.id, kind: categories.kind, accountId: categories.accountId }).from(categories).all();
	const periodRows = db.select({ id: periods.id, startDate: periods.startDate }).from(periods).all();

	const peer = alias(transactions, 'peer');
	const splitRows = db
		.select({
			transactionId: transactionSplits.transactionId,
			accountId: transactions.accountId,
			periodId: transactions.periodId,
			categoryId: transactionSplits.categoryId,
			amount: transactionSplits.amount,
			transferPeerAccountId: peer.accountId,
			source: transactions.source
		})
		.from(transactionSplits)
		.innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
		.leftJoin(peer, eq(transactions.transferPeerId, peer.id))
		.where(isNull(transactions.deletedAt))
		.all();

	// Latest balance row per account; fall back to the live transaction sum.
	const latest = new Map<number, number>();
	const balanceRows = db
		.select({ accountId: accountBalances.accountId, current: accountBalances.current })
		.from(accountBalances)
		.orderBy(desc(accountBalances.asOf), desc(accountBalances.id))
		.all();
	for (const b of balanceRows) if (!latest.has(b.accountId)) latest.set(b.accountId, b.current);
	const sums = db
		.select({ accountId: transactions.accountId, total: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
		.from(transactions)
		.where(isNull(transactions.deletedAt))
		.groupBy(transactions.accountId)
		.all();
	const sumBy = new Map(sums.map((s) => [s.accountId, s.total]));
	const balances = accountRows.map((a) => ({ accountId: a.id, current: latest.get(a.id) ?? sumBy.get(a.id) ?? 0 }));

	const assignmentRows = db
		.select({ periodId: budgetAssignments.periodId, categoryId: budgetAssignments.categoryId, assigned: budgetAssignments.assigned })
		.from(budgetAssignments)
		.all();

	return {
		accounts: accountRows,
		categories: categoryRows,
		periods: periodRows,
		splits: splitRows.map((s) => ({ ...s, transferPeerAccountId: s.transferPeerAccountId ?? null })),
		assignments: assignmentRows,
		balances
	};
}

export function budgetForPeriod(db: DbOrTx, periodId: number): BudgetResult {
	return computeBudget(loadBudgetInput(db), periodId);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/server/budget/load.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/budget/load.ts src/lib/server/budget/load.test.ts
git commit -m "feat: load envelope input from the ledger"
```

---

### Task 12: Startup, config, and health route

**Files:**
- Create: `src/lib/server/config.ts`, `src/lib/server/db/instance.ts`, `src/lib/server/startup.ts`, `src/hooks.server.ts`, `src/routes/api/health/+server.ts`
- Test: `src/lib/server/config.test.ts`, `src/lib/server/startup.test.ts`

**Interfaces:**
- Consumes: `openDatabase`, `seedDefaultCategories`, `ensurePeriods`, `periodRange`, `pendingMigrations`.
- Produces:
  - `loadConfig(env: Record<string, string | undefined>): Config` — throws naming the first missing required variable. Required: `SHISO_DB_PATH`, `SHISO_BACKUP_DIR`, `SHISO_APP_KEY` (≥ 32 chars). Optional with defaults: `SHISO_TZ` (`America/New_York`), `SHISO_MIGRATIONS_DIR` (the repo's `drizzle/` resolved from `import.meta.url`), `SHISO_CADENCE` (`semi_monthly`), `SHISO_SYNC_HOUR` (`3`), `SHISO_BALANCE_HOUR` (`7`), `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (`sandbox`).
  - `setConfig(c)` / `getConfig(): Config` — module-level store set by `hooks.server.ts`; routes read the zone and migrations dir from it.
  - `startup(config: Config, todayIso: string): StartupReport` — opens the database with `config.migrationsDir`, seeds categories, ensures periods from the earliest of (earliest existing period, earliest transaction, earliest balance, today) through the period after the current one, stores the handle; returns `{ snapshot, periodsCreated, pendingMigrations }`. Starting from the earliest existing period closes any gap left by downtime across a boundary.
  - `getDb(): Db` from `instance.ts`; throws if `startup` has not run.
  - `GET /api/health` → `{ ok: true, db: 'ok', pendingMigrations: number, currentPeriod: string, lastSync: null }`. (`lastSync` is populated by Plan 1B.)

- [ ] **Step 1: Write the failing config test**

`src/lib/server/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from './config';

const good = {
	SHISO_DB_PATH: '/tmp/x.db', SHISO_BACKUP_DIR: '/tmp/b',
	SHISO_APP_KEY: 'a'.repeat(44)
};

describe('loadConfig', () => {
	it('names the first missing variable', () => {
		expect(() => loadConfig({})).toThrowError(/SHISO_DB_PATH/);
		expect(() => loadConfig({ SHISO_DB_PATH: 'x' })).toThrowError(/SHISO_BACKUP_DIR/);
	});
	it('rejects a short app key', () => {
		expect(() => loadConfig({ ...good, SHISO_APP_KEY: 'short' })).toThrowError(/SHISO_APP_KEY/);
	});
	it('applies defaults', () => {
		const c = loadConfig(good);
		expect(c.cadence).toBe('semi_monthly');
		expect(c.syncHour).toBe(3);
		expect(c.plaid.env).toBe('sandbox');
		expect(c.timeZone).toBe('America/New_York');
		expect(c.migrationsDir.endsWith('drizzle')).toBe(true);
	});
	it('rejects an unknown time zone', () => {
		expect(() => loadConfig({ ...good, SHISO_TZ: 'Mars/Olympus' })).toThrowError(/SHISO_TZ/);
	});
});
```

- [ ] **Step 2: Implement config.ts**

```ts
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Cadence } from './budget/periods';

export type Config = {
	dbPath: string;
	backupDir: string;
	appKey: string;
	timeZone: string;
	migrationsDir: string;
	cadence: Cadence;
	syncHour: number;
	balanceHour: number;
	plaid: { clientId: string | null; secret: string | null; env: 'sandbox' | 'production' };
};

function required(env: Record<string, string | undefined>, key: string): string {
	const v = env[key];
	if (!v) throw new Error(`missing required environment variable ${key}`);
	return v;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
	const dbPath = required(env, 'SHISO_DB_PATH');
	const backupDir = required(env, 'SHISO_BACKUP_DIR');
	const appKey = required(env, 'SHISO_APP_KEY');
	if (appKey.length < 32) throw new Error('SHISO_APP_KEY must be at least 32 characters');
	const cadence = (env.SHISO_CADENCE ?? 'semi_monthly') as Cadence;
	if (cadence !== 'semi_monthly' && cadence !== 'monthly') throw new Error(`SHISO_CADENCE must be semi_monthly or monthly`);
	const plaidEnv = (env.PLAID_ENV ?? 'sandbox') as 'sandbox' | 'production';
	const timeZone = env.SHISO_TZ ?? 'America/New_York';
	try {
		new Intl.DateTimeFormat('en-CA', { timeZone });
	} catch {
		throw new Error(`SHISO_TZ is not a valid IANA time zone: ${timeZone}`);
	}
	// src/lib/server/config.ts → ../../../drizzle in dev. Production sets SHISO_MIGRATIONS_DIR.
	const migrationsDir = env.SHISO_MIGRATIONS_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../../../drizzle');
	return {
		dbPath, backupDir, appKey, cadence, timeZone, migrationsDir,
		syncHour: Number(env.SHISO_SYNC_HOUR ?? 3),
		balanceHour: Number(env.SHISO_BALANCE_HOUR ?? 7),
		plaid: { clientId: env.PLAID_CLIENT_ID ?? null, secret: env.PLAID_SECRET ?? null, env: plaidEnv }
	};
}

let current: Config | null = null;
export function setConfig(c: Config): void { current = c; }
export function getConfig(): Config {
	if (!current) throw new Error('config not initialised; hooks.server.ts init has not run');
	return current;
}
```

- [ ] **Step 3: Run the config test**

Run: `npx vitest run src/lib/server/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Write the failing startup test**

`src/lib/server/startup.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startup, resetForTests } from './startup';
import { getDb } from './db/instance';
import { periods, categories } from './db/schema';
import { asc } from 'drizzle-orm';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shiso-start-')); resetForTests(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); resetForTests(); });

const cfg = (d: string) => ({
	dbPath: join(d, 'shiso.db'), backupDir: join(d, 'backups'), appKey: 'k'.repeat(40),
	timeZone: 'America/New_York', migrationsDir: 'drizzle',
	cadence: 'semi_monthly' as const, syncHour: 3, balanceHour: 7,
	plaid: { clientId: null, secret: null, env: 'sandbox' as const }
});

describe('startup', () => {
	it('opens, seeds, and creates the current and next period on a fresh database', () => {
		const report = startup(cfg(dir), '2026-09-04');
		const db = getDb();
		const rows = db.select().from(periods).orderBy(asc(periods.startDate)).all();
		expect(rows.map((r) => r.startDate)).toEqual(['2026-09-01', '2026-09-16']);
		expect(db.select().from(categories).all().some((c) => c.kind === 'income')).toBe(true);
		expect(report.pendingMigrations).toBe(0);
		expect(report.snapshot).toBeNull();
	});
	it('is idempotent across restarts', () => {
		startup(cfg(dir), '2026-09-04');
		resetForTests();
		startup(cfg(dir), '2026-09-20');
		const db = getDb();
		expect(db.select().from(periods).all().length).toBe(3); // Sep a, Sep b, Oct a
	});
	it('closes a gap left by downtime across a boundary', () => {
		startup(cfg(dir), '2026-09-04');
		resetForTests();
		startup(cfg(dir), '2026-11-20'); // process was down for October
		const db = getDb();
		const starts = db.select().from(periods).orderBy(asc(periods.startDate)).all().map((r) => r.startDate);
		expect(starts).toEqual(['2026-09-01', '2026-09-16', '2026-10-01', '2026-10-16', '2026-11-01', '2026-11-16', '2026-12-01']);
	});
});
```

- [ ] **Step 5: Implement instance.ts and startup.ts**

`src/lib/server/db/instance.ts`:

```ts
import type Database from 'better-sqlite3';
import type { Db } from './index';

let current: { db: Db; sqlite: Database.Database } | null = null;

export function setDb(handle: { db: Db; sqlite: Database.Database }): void {
	current = handle;
}

export function getDb(): Db {
	if (!current) throw new Error('database not initialised; startup() has not run');
	return current.db;
}

export function getSqlite(): Database.Database {
	if (!current) throw new Error('database not initialised; startup() has not run');
	return current.sqlite;
}

export function closeDb(): void {
	current?.sqlite.close();
	current = null;
}
```

`src/lib/server/startup.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { Config } from './config';
import { openDatabase } from './db';
import { pendingMigrations } from './db/migrations';
import { setDb, closeDb } from './db/instance';
import { seedDefaultCategories } from './ledger/categories';
import { ensurePeriods, periodBoundsFor, nextPeriodStart, periodRange } from './budget/periods';
import { transactions, accountBalances, periods } from './db/schema';

export type StartupReport = { snapshot: string | null; periodsCreated: number; pendingMigrations: number };

export function startup(config: Config, todayIso: string): StartupReport {
	const handle = openDatabase({ path: config.dbPath, backupDir: config.backupDir, migrationsFolder: config.migrationsDir });
	setDb(handle);
	const { db, sqlite } = handle;

	seedDefaultCategories(db);

	const minTx = db.select({ d: sql<string | null>`min(${transactions.postedDate})` }).from(transactions).get()?.d ?? null;
	const minBal = db.select({ d: sql<string | null>`min(${accountBalances.asOf})` }).from(accountBalances).get()?.d ?? null;
	const firstPeriod = periodRange(db)?.first ?? null;
	const earliest = [firstPeriod, minTx, minBal, todayIso].filter((x): x is string => x != null).sort()[0];
	const before = db.select({ n: sql<number>`count(*)` }).from(periods).get()?.n ?? 0;
	const current = periodBoundsFor(config.cadence, todayIso);
	const next = periodBoundsFor(config.cadence, nextPeriodStart(config.cadence, current.endDate));
	ensurePeriods(db, config.cadence, earliest, next.endDate);
	const after = db.select({ n: sql<number>`count(*)` }).from(periods).get()?.n ?? 0;

	return { snapshot: handle.snapshot, periodsCreated: after - before, pendingMigrations: pendingMigrations(sqlite, config.migrationsDir).length };
}

export function resetForTests(): void {
	closeDb();
}
```

- [ ] **Step 6: Run the startup test**

Run: `npx vitest run src/lib/server/startup.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Wire hooks.server.ts and the health route**

`src/hooks.server.ts`:

```ts
import type { ServerInit } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { loadConfig, setConfig } from '$lib/server/config';
import { startup } from '$lib/server/startup';
import { todayIso } from '$lib/dates';

export const init: ServerInit = async () => {
	const config = loadConfig(env);
	setConfig(config);
	const report = startup(config, todayIso(config.timeZone));
	console.log(`[shiso] database ready; periods created: ${report.periodsCreated}; snapshot: ${report.snapshot ?? 'none'}`);
};
```

`src/routes/api/health/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb, getSqlite } from '$lib/server/db/instance';
import { pendingMigrations } from '$lib/server/db/migrations';
import { periods } from '$lib/server/db/schema';
import { periodIdForDate } from '$lib/server/budget/periods';
import { getConfig } from '$lib/server/config';
import { todayIso } from '$lib/dates';
import { eq } from 'drizzle-orm';

export const GET: RequestHandler = () => {
	const db = getDb();
	const config = getConfig();
	const id = periodIdForDate(db, todayIso(config.timeZone));
	const current = db.select({ label: periods.label }).from(periods).where(eq(periods.id, id)).get();
	return json({
		ok: true,
		db: 'ok',
		pendingMigrations: pendingMigrations(getSqlite(), config.migrationsDir).length,
		currentPeriod: current?.label ?? null,
		lastSync: null
	});
};
```

- [ ] **Step 8: Run it for real**

Create `.env` from `.env.example` with a real 44-character app key (`openssl rand -base64 32`), then:

Run: `npm run dev`
Then: `curl -s localhost:5173/api/health`
Expected: `{"ok":true,"db":"ok","pendingMigrations":0,"currentPeriod":"Sep 1–15, 2026","lastSync":null}` (label reflects today's date). `data/shiso.db` exists.

Run: `npm run check && npm test`
Expected: 0 type errors; all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/server/config.ts src/lib/server/config.test.ts src/lib/server/db/instance.ts src/lib/server/startup.ts src/lib/server/startup.test.ts src/hooks.server.ts src/routes/api/health/
git commit -m "feat: startup with config, seeding, period back-fill, and health route"
```

---

## Handoff to Plan 1B

Plan 1B (sync, post-processing, reconciliation, bills and income) builds on these exact interfaces:

- `openMemoryDatabase()` for provider fixture tests.
- `createTransaction`, `setSplits`, `setPayee`, `linkTransfer`, `unlinkTransfer`, `softDelete`, `flagForReview`, `markProcessed`, `unprocessedWhere` for the apply and post-processing steps.
- `ensurePeriods` and `periodIdForDate` before any insert; `startup` already back-fills from the earliest date, and the sync apply step must call `ensurePeriods` for the batch's date range before creating rows. That range starts at the minimum over rows of `min(transactedAt date, postedDate)`, because a pending row takes its period from the transacted date, which can fall in the period before its posted date.
- `todayIso(getConfig().timeZone)` for anything that is a calendar date (overdue checks, occurrence windows, the current period); `nowIso()` only for timestamps.
- Card-to-card transfers (a balance transfer) touch no envelope in Phase 1; see spec §12. Do not add a `paymentsByPX` case for a card source without the Phase 2 rule.
- `paymentCategoryForAccount` for transfer-to-off-budget defaulting.
- `systemCategoryId(db, 'reconciliation')` for opening-balance and adjustment transactions.
- `budgetForPeriod` for the Month and Budget pages in Plan 1C.
- `connections.credentialEnc` is written by 1B using an `encrypt(appKey, plaintext)` helper that 1B defines.

### Amendments from the Plan 1A final review

- **`updateTransaction` is Plan 1B's first task.** The ledger service has no updater for amount, dates, pending flag, raw payee, or provider category. 1B adds it to `src/lib/server/ledger/transactions.ts` (not a workaround: the service is the only writer) implementing spec §5.6's modified rule: amount change on a single-split row moves the split; on a multi-split row flags `needs_review` with reason `amount_changed`.
- **Delivered beyond the original interfaces:** `createTransaction` throws `InvariantError('DUPLICATE_EXTERNAL_ID')` on the account/external-id unique index; `setReplacedBy(db, pendingId, replacementId)` records pending-to-posted replacement; `softDelete` clears a transfer link on both sides and flags the survivor with reason `transfer_peer_deleted`, so 1B need not unlink first; `currentPeriodId(db, cadence, todayIso)` self-heals periods through the period after today; `categories.is_system` marks seeded rows and `systemCategoryId`/`uncategorizedId` look up by it; `NO_ENVELOPE_KINDS` is exported from `envelope.ts`; closed accounts report zero cash in `loadBudgetInput`; the health route returns 503 `{ ok: false }` instead of throwing.
- **Sync apply must call `ensurePeriods` over the batch's `min(transactedAt date, postedDate)` and today** before inserting, and `markProcessed` should chunk ids at a few thousand per statement for a large initial pull.
- **Decide where cash-back rewards land before the first real sync.** An income-kind split posted to a card reduces the card's balance owed but does not fund its payment envelope.
- **1C:** batch the Budget page onto one `loadBudgetInput` call rather than one per period; `computeBudget` needs the full period set to compute carries; category management must not change a system category's kind.
