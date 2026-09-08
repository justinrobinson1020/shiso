# shiso Plan 1B: Sync, post-processing, reconciliation, bills and income

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bank data flows into the ledger on a schedule: Plaid, SimpleFIN, and CSV feed one provider-agnostic apply step; new rows are cleaned, linked, and matched to bills and income; drift is measurable; every run is recorded.

**Architecture:** Providers only fetch (async, network). A single synchronous `applyBatch` writes a whole batch in one transaction, including pending-to-posted reconciliation and opening balances. Post-processing runs over `processed_at IS NULL` rows regardless of which run inserted them. Bills and income are materialized occurrences matched from transactions, with debt bills matched by transfer peer. A runner serializes runs per connection and records every one in `sync_runs`; node-cron drives it inside the same process, and thin API routes expose it.

**Tech Stack:** Node 24, SvelteKit 2, TypeScript, drizzle-orm 0.45 + better-sqlite3 13, vitest 5, `plaid` 47, `node-cron` 4, `csv-parse` 7, Node `crypto` (AES-256-GCM).

**Spec:** `docs/superpowers/specs/2026-09-04-shiso-phase1-foundation-design.md` §3.2–3.4, §4.1, §4.2, §4.4, §4.5, §5 (all), §6 (all), §9, §10. Plan 1A's handoff amendments are in `docs/superpowers/plans/2026-09-04-shiso-1a-core.md` (bottom).

## Global Constraints

- Integer cents everywhere; provider decimals convert through `decimalToCents` at the boundary and never elsewhere (§2).
- Sign convention: amounts are from the account's point of view; a card purchase is negative, a payment to the card positive. Plaid reports outflows as positive and must be negated; SimpleFIN and Apple Card CSV are handled as stated in their tasks (§2).
- Dates are ISO `YYYY-MM-DD` strings in the configured zone; timestamps ISO 8601 UTC. `todayIso(config.timeZone)` for calendar dates, `nowIso()` for timestamps (§3.3).
- Nothing outside `src/lib/server/ledger/` writes `transactions`, `transaction_splits`, `budget_assignments`, `bill_occurrence_transactions`, or `bill_occurrences` status fields except the bills service in `src/lib/server/bills/` for occurrence tables (§9). Sync and post-processing call the ledger service.
- Providers only fetch; `applyBatch` is synchronous and runs in one `db.transaction` (§5.1). No write lock is held across a network call.
- Post-processing selects `processed_at IS NULL` and sets `processed_at` when done; it is never batch-scoped (§5.1).
- Every sync run opens a `sync_runs` row first and closes it last; failures are per connection (§5.1, §9).
- Sync never guesses: ambiguity goes to `needs_review` with a reason (§9). Reasons used in this plan: `amount_changed`, `pending_ambiguous`, `transfer_ambiguous`, `transfer_off_budget_uncategorized`, `transfer_unlinked`, `transfer_peer_deleted`, `provider_removed`, `bill_match_tied`.
- Per-connection credentials are stored encrypted in `connections.credential_enc` with the app key; only Plaid client credentials and the app key live in the environment (§3.3).
- Service functions take `DbOrTx`; `InvariantError` carries the code only.
- Commit messages: conventional prefix, no trailer, no reference to AI tooling. Run `npm test` and `npm run check` before every commit.
- Do not use Drizzle's relational query API (`db.query.<table>.findFirst/findMany`) anywhere: on the synchronous better-sqlite3 driver it returns a lazy object that needs `.sync()`, and plain property access silently yields `undefined`. Use `db.select().from(...).get()/.all()`.

## File structure

```
src/lib/server/ledger/transactions.ts        (modify) updateTransaction, TransactionPatch
src/lib/server/settings.ts                   getSetting / setSetting over the settings table
src/lib/server/sync/crypto.ts                encryptSecret / decryptSecret (AES-256-GCM, app key)
src/lib/server/sync/types.ts                 SyncBatch, SyncProvider, ProviderError, FetchInput
src/lib/server/sync/hash.ts                  contentHash for id-less rows
src/lib/server/sync/connections.ts           connections + accounts + balances + terms service
src/lib/server/sync/apply.ts                 applyBatch (one transaction), pending reconciliation, opening balances
src/lib/server/sync/payees.ts                payee rules
src/lib/server/sync/transfers.ts             transfer detection
src/lib/server/sync/postprocess.ts           orchestrates rules → transfers → matching → default category
src/lib/server/sync/runner.ts                runSync / runAllSyncs, mutex, sync_runs
src/lib/server/sync/scheduler.ts             node-cron wiring
src/lib/server/sync/providers/manual.ts
src/lib/server/sync/providers/plaid.ts       PlaidProvider + link helpers (client injected)
src/lib/server/sync/providers/simplefin.ts   SimpleFinProvider + claimSetupToken (fetch injected)
src/lib/server/sync/providers/index.ts       buildProviders(config)
src/lib/server/sync/import/csv.ts            Apple Card CSV → transactions
src/lib/server/bills/schedule.ts             due-date generation (pure) + generateOccurrences
src/lib/server/bills/bills.ts                bill / income source CRUD
src/lib/server/bills/matching.ts             auto-match, overdue, manual actions, unwind
src/lib/server/reconcile.ts                  drift per account, adjustment transactions
src/routes/api/sync/+server.ts               POST run all
src/routes/api/sync/[connectionId]/+server.ts  POST run one
src/routes/api/plaid/link-token/+server.ts   POST
src/routes/api/plaid/exchange/+server.ts     POST
src/routes/api/simplefin/claim/+server.ts    POST
src/routes/api/health/+server.ts             (modify) lastSync
src/hooks.server.ts                          (modify) start scheduler
```

---

### Task 1: `updateTransaction` in the ledger service

**Files:**
- Modify: `src/lib/server/ledger/transactions.ts`
- Test: `src/lib/server/ledger/transactions.test.ts` (append)

**Interfaces:**
- Consumes: `transactions`, `transactionSplits` schema; `flagForReview`; `touch`.
- Produces:
  - `type TransactionPatch = { amount?: number; postedDate?: string; transactedAt?: string | null; pending?: boolean; payeeRaw?: string; providerCategory?: string | null }` — memo is a user edit and is deliberately absent (spec §5.6; corrected by the Task 1 review ruling)
  - `updateTransaction(db: DbOrTx, id: number, patch: TransactionPatch): { amountChanged: boolean; flagged: boolean }` — spec §5.6 modified rule: a changed amount moves the split when there is exactly one split; with several splits the row is flagged `amount_changed` and the splits are left alone (the invariant that splits sum to the amount is deliberately broken until the user fixes it, and `needs_review` says so). `periodId`, `payee`, and user-edited fields are never touched.

- [ ] **Step 1: Write the failing tests** (append to `transactions.test.ts`)

```ts
describe('updateTransaction', () => {
	it('moves a single split when the amount changes', () => {
		const id = createTransaction(db, { accountId: checking, externalId: 'u1', postedDate: '2026-03-20', amount: -1000, payeeRaw: 'X', source: 'sync' });
		const r = updateTransaction(db, id, { amount: -1250, payeeRaw: 'X INC' });
		const t = getTransaction(db, id);
		expect(r).toEqual({ amountChanged: true, flagged: false });
		expect(t.amount).toBe(-1250);
		expect(t.splits[0].amount).toBe(-1250);
		expect(t.payeeRaw).toBe('X INC');
		expect(t.needsReview).toBe(false);
	});
	it('flags a multi-split transaction instead of guessing', () => {
		const id = createTransaction(db, { accountId: checking, externalId: 'u2', postedDate: '2026-03-20', amount: -1000, payeeRaw: 'X', source: 'sync',
			splits: [{ categoryId: groceries, amount: -600 }, { categoryId: uncategorizedId(db), amount: -400 }] });
		const r = updateTransaction(db, id, { amount: -900 });
		const t = getTransaction(db, id);
		expect(r).toEqual({ amountChanged: true, flagged: true });
		expect(t.amount).toBe(-900);
		expect(t.splits.map((s) => s.amount).sort()).toEqual([-600, -400].sort());
		expect(t.needsReview).toBe(true);
		expect(t.reviewReason).toBe('amount_changed');
	});
	it('leaves period, payee, and memo alone', () => {
		const id = createTransaction(db, { accountId: checking, externalId: 'u3', postedDate: '2026-03-20', amount: -100, payeeRaw: 'RAW', payee: 'Clean', memo: 'note', source: 'sync' });
		const before = getTransaction(db, id);
		updateTransaction(db, id, { postedDate: '2026-04-02', pending: false, payeeRaw: 'RAW2' });
		const t = getTransaction(db, id);
		expect(t.periodId).toBe(before.periodId);
		expect(t.payee).toBe('Clean');
		expect(t.memo).toBe('note');
		expect(t.postedDate).toBe('2026-04-02');
	});
});
```

Add `updateTransaction` to the existing import line from `./transactions`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/server/ledger/transactions.test.ts`
Expected: FAIL, `updateTransaction` is not exported.

- [ ] **Step 3: Implement** (append to `transactions.ts`)

```ts
export type TransactionPatch = {
	amount?: number;
	postedDate?: string;
	transactedAt?: string | null;
	pending?: boolean;
	payeeRaw?: string;
	providerCategory?: string | null;
};

/** Spec §5.6: provider modifications touch amount, dates, pending, raw payee, provider category. */
export function updateTransaction(db: DbOrTx, id: number, patch: TransactionPatch): { amountChanged: boolean; flagged: boolean } {
	const row = db.select().from(transactions).where(eq(transactions.id, id)).get();
	if (!row) throw new Error(`transaction ${id} not found`);
	const amountChanged = patch.amount !== undefined && patch.amount !== row.amount;
	return db.transaction((tx) => {
		const set: Partial<typeof transactions.$inferInsert> = { ...touch() };
		if (patch.amount !== undefined) set.amount = patch.amount;
		if (patch.postedDate !== undefined) set.postedDate = patch.postedDate;
		if (patch.transactedAt !== undefined) set.transactedAt = patch.transactedAt;
		if (patch.pending !== undefined) set.pending = patch.pending;
		if (patch.payeeRaw !== undefined) set.payeeRaw = patch.payeeRaw;
		if (patch.providerCategory !== undefined) set.providerCategory = patch.providerCategory;
		let flagged = false;
		if (amountChanged) {
			const splits = tx.select().from(transactionSplits).where(eq(transactionSplits.transactionId, id)).all();
			if (splits.length === 1) {
				tx.update(transactionSplits).set({ amount: patch.amount! }).where(eq(transactionSplits.id, splits[0].id)).run();
			} else {
				set.needsReview = true;
				set.reviewReason = 'amount_changed';
				flagged = true;
			}
		}
		tx.update(transactions).set(set).where(eq(transactions.id, id)).run();
		return { amountChanged, flagged };
	});
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/server/ledger/transactions.test.ts`
Expected: PASS (all, including 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/ledger/transactions.ts src/lib/server/ledger/transactions.test.ts
git commit -m "feat: updateTransaction with the modified-amount rule"
```

---

### Task 2: Settings, credential encryption, and the connections service

**Files:**
- Create: `src/lib/server/settings.ts`, `src/lib/server/sync/crypto.ts`, `src/lib/server/sync/connections.ts`
- Test: `src/lib/server/settings.test.ts`, `src/lib/server/sync/crypto.test.ts`, `src/lib/server/sync/connections.test.ts`

**Interfaces:**
- Consumes: `settings`, `connections`, `accounts`, `accountBalances`, `accountTerms` schema; `DbOrTx`; `nowIso`.
- Produces:
  - `getSetting<T>(db, key, fallback: T): T`, `setSetting(db, key, value: unknown): void`
  - `encryptSecret(appKey: string, plaintext: string): string` → `v1.<iv b64>.<tag b64>.<ct b64>`; `decryptSecret(appKey, enc): string`; throws `Error('bad ciphertext')` on tamper.
  - `createConnection(db, input: { provider: Provider; institutionName: string; externalItemId?: string | null; credential?: string | null; appKey: string }): number`
  - `getCredential(db, connectionId, appKey): string | null`
  - `setConnectionStatus(db, connectionId, status: ConnectionStatus, error?: string | null): void`
  - `recordConnectionSuccess(db, connectionId, cursor: string | null, at: string): void`
  - `listActiveConnections(db): { id: number; provider: Provider; institutionName: string; cursor: string | null }[]` — the runnable set: status `active` or `error` (a transient provider failure is retried next run); only `needs_relink` and `disabled` are excluded (Task 10 review ruling).
  - `upsertAccount(db, connectionId, a: { externalId: string; name: string; officialName?: string | null; mask?: string | null; type: AccountType }): { id: number; created: boolean }` — updates name/officialName/mask on existing rows; never changes `type`, `onBudget`, `isDebt`, `closedAt` after creation. On creation: `onBudget = type in (checking, savings, cash, credit)`, `isDebt = type in (credit, loan)`.
  - `appendBalance(db, accountId, b: { asOf: string; current: number; available?: number | null; creditLimit?: number | null; source: 'sync' | 'manual' | 'import' }): number`
  - `appendTermsIfChanged(db, accountId, t: { asOf: string; aprBps?: number | null; promoAprBps?: number | null; minPayment?: number | null; nextDueDate?: string | null; lastStatementBalance?: number | null; lastStatementDate?: string | null; annualFee?: number | null; source: 'provider' | 'manual' }): boolean` — inserts only when any value differs from the latest row (by `asOf`, `id`); manual always inserts.
  - `latestTerms(db, accountId)` → the latest row or null; `latestBalance(db, accountId)` → row or null.

- [ ] **Step 1: Failing tests**

`src/lib/server/settings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openMemoryDatabase } from './db';
import { getSetting, setSetting } from './settings';

describe('settings', () => {
	it('round-trips JSON values with a fallback', () => {
		const { db } = openMemoryDatabase();
		expect(getSetting(db, 'grace_days', 3)).toBe(3);
		setSetting(db, 'grace_days', 5);
		expect(getSetting(db, 'grace_days', 3)).toBe(5);
		setSetting(db, 'map', { a: 1 });
		expect(getSetting<Record<string, number>>(db, 'map', {})).toEqual({ a: 1 });
	});
});
```

`src/lib/server/sync/crypto.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from './crypto';

const KEY = 'k'.repeat(44);
describe('secret encryption', () => {
	it('round-trips and never repeats ciphertext', () => {
		const a = encryptSecret(KEY, 'access-sandbox-123');
		const b = encryptSecret(KEY, 'access-sandbox-123');
		expect(a).not.toBe(b);
		expect(a.startsWith('v1.')).toBe(true);
		expect(decryptSecret(KEY, a)).toBe('access-sandbox-123');
	});
	it('rejects a wrong key and a tampered payload', () => {
		const enc = encryptSecret(KEY, 'secret');
		expect(() => decryptSecret('x'.repeat(44), enc)).toThrow();
		const parts = enc.split('.');
		parts[3] = parts[3].slice(0, -2) + 'AA';
		expect(() => decryptSecret(KEY, parts.join('.'))).toThrow();
	});
});
```

`src/lib/server/sync/connections.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { accountBalances, accountTerms, connections } from '../db/schema';
import {
	createConnection, getCredential, setConnectionStatus, recordConnectionSuccess, listActiveConnections,
	upsertAccount, appendBalance, appendTermsIfChanged, latestTerms, latestBalance
} from './connections';
import { eq } from 'drizzle-orm';

const KEY = 'k'.repeat(44);
let db: Db;
beforeEach(() => { db = openMemoryDatabase().db; });

describe('connections', () => {
	it('stores the credential encrypted and reads it back', () => {
		const id = createConnection(db, { provider: 'plaid', institutionName: 'Chase', externalItemId: 'item-1', credential: 'access-1', appKey: KEY });
		const row = db.select().from(connections).where(eq(connections.id, id)).get()!;
		expect(row.credentialEnc).not.toContain('access-1');
		expect(getCredential(db, id, KEY)).toBe('access-1');
		expect(getCredential(db, createConnection(db, { provider: 'manual', institutionName: 'Cash', appKey: KEY }), KEY)).toBeNull();
	});
	it('tracks status, errors, cursor, and success time', () => {
		const id = createConnection(db, { provider: 'simplefin', institutionName: 'SF', credential: 'https://u:p@bridge/x', appKey: KEY });
		setConnectionStatus(db, id, 'error', 'boom');
		expect(db.select().from(connections).where(eq(connections.id, id)).get()!.lastError).toBe('boom');
		recordConnectionSuccess(db, id, 'cursor-9', '2026-09-08T03:00:00.000Z');
		const row = db.select().from(connections).where(eq(connections.id, id)).get()!;
		expect(row.cursor).toBe('cursor-9');
		expect(row.lastSuccessAt).toBe('2026-09-08T03:00:00.000Z');
		expect(row.status).toBe('active');
		expect(row.lastError).toBeNull();
		setConnectionStatus(db, id, 'disabled');
		expect(listActiveConnections(db).map((c) => c.id)).not.toContain(id);
	});
});

describe('accounts, balances, terms', () => {
	it('upserts accounts without touching type or flags after creation', () => {
		const c = createConnection(db, { provider: 'plaid', institutionName: 'Chase', appKey: KEY });
		const a = upsertAccount(db, c, { externalId: 'acc-1', name: 'Sapphire', mask: '1234', type: 'credit' });
		expect(a.created).toBe(true);
		const again = upsertAccount(db, c, { externalId: 'acc-1', name: 'Sapphire Preferred', mask: '1234', type: 'checking' });
		expect(again).toEqual({ id: a.id, created: false });
		const row = db.query.accounts.findFirst({ where: (t, { eq }) => eq(t.id, a.id) })!;
		expect(row.name).toBe('Sapphire Preferred');
		expect(row.type).toBe('credit');
		expect(row.onBudget).toBe(true);
		expect(row.isDebt).toBe(true);
	});
	it('appends balances and terms only on change', () => {
		const c = createConnection(db, { provider: 'plaid', institutionName: 'Chase', appKey: KEY });
		const a = upsertAccount(db, c, { externalId: 'acc-1', name: 'Card', type: 'credit' }).id;
		appendBalance(db, a, { asOf: '2026-09-07', current: -50000, source: 'sync' });
		appendBalance(db, a, { asOf: '2026-09-08', current: -51000, source: 'sync' });
		expect(latestBalance(db, a)?.current).toBe(-51000);
		expect(db.select().from(accountBalances).all().length).toBe(2);
		expect(appendTermsIfChanged(db, a, { asOf: '2026-09-07', aprBps: 2749, minPayment: 3500, nextDueDate: '2026-09-15', source: 'provider' })).toBe(true);
		expect(appendTermsIfChanged(db, a, { asOf: '2026-09-08', aprBps: 2749, minPayment: 3500, nextDueDate: '2026-09-15', source: 'provider' })).toBe(false);
		expect(appendTermsIfChanged(db, a, { asOf: '2026-09-09', aprBps: 2724, minPayment: 3500, nextDueDate: '2026-09-15', source: 'provider' })).toBe(true);
		expect(appendTermsIfChanged(db, a, { asOf: '2026-09-09', aprBps: 2724, source: 'manual' })).toBe(true);
		expect(db.select().from(accountTerms).all().length).toBe(3);
		expect(latestTerms(db, a)?.aprBps).toBe(2724);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/server/settings.test.ts src/lib/server/sync/crypto.test.ts src/lib/server/sync/connections.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement settings.ts**

```ts
import { eq } from 'drizzle-orm';
import type { DbOrTx } from './db';
import { settings } from './db/schema';
import { nowIso } from '$lib/dates';

export function getSetting<T>(db: DbOrTx, key: string, fallback: T): T {
	const row = db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
	return row ? (row.value as T) : fallback;
}

export function setSetting(db: DbOrTx, key: string, value: unknown): void {
	db.insert(settings)
		.values({ key, value: value as never, updatedAt: nowIso() })
		.onConflictDoUpdate({ target: settings.key, set: { value: value as never, updatedAt: nowIso() } })
		.run();
}
```

- [ ] **Step 4: Implement crypto.ts**

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function keyBytes(appKey: string): Buffer {
	return createHash('sha256').update(appKey, 'utf8').digest();
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, all base64url. */
export function encryptSecret(appKey: string, plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', keyBytes(appKey), iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(appKey: string, enc: string): string {
	const [v, ivB, tagB, ctB] = enc.split('.');
	if (v !== 'v1' || !ivB || !tagB || !ctB) throw new Error('bad ciphertext');
	try {
		const decipher = createDecipheriv('aes-256-gcm', keyBytes(appKey), Buffer.from(ivB, 'base64url'));
		decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
		return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
	} catch {
		throw new Error('bad ciphertext');
	}
}
```

- [ ] **Step 5: Implement connections.ts**

```ts
import { and, desc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import {
	accounts, accountBalances, accountTerms, connections,
	CASH_TYPES, type AccountType, type ConnectionStatus, type Provider
} from '../db/schema';
import { encryptSecret, decryptSecret } from './crypto';
import { nowIso } from '$lib/dates';

const touch = () => ({ updatedAt: nowIso() });

export function createConnection(db: DbOrTx, input: {
	provider: Provider; institutionName: string; externalItemId?: string | null; credential?: string | null; appKey: string;
}): number {
	return db.insert(connections).values({
		provider: input.provider,
		institutionName: input.institutionName,
		externalItemId: input.externalItemId ?? null,
		credentialEnc: input.credential ? encryptSecret(input.appKey, input.credential) : null
	}).returning({ id: connections.id }).get().id;
}

export function setCredential(db: DbOrTx, connectionId: number, credential: string, appKey: string): void {
	db.update(connections).set({ credentialEnc: encryptSecret(appKey, credential), ...touch() }).where(eq(connections.id, connectionId)).run();
}

export function getCredential(db: DbOrTx, connectionId: number, appKey: string): string | null {
	const row = db.select({ enc: connections.credentialEnc }).from(connections).where(eq(connections.id, connectionId)).get();
	if (!row) throw new Error(`connection ${connectionId} not found`);
	return row.enc ? decryptSecret(appKey, row.enc) : null;
}

export function setConnectionStatus(db: DbOrTx, connectionId: number, status: ConnectionStatus, error?: string | null): void {
	db.update(connections).set({ status, lastError: error ?? null, ...touch() }).where(eq(connections.id, connectionId)).run();
}

export function recordConnectionSuccess(db: DbOrTx, connectionId: number, cursor: string | null, at: string): void {
	db.update(connections)
		.set({ cursor, lastSuccessAt: at, status: 'active', lastError: null, ...touch() })
		.where(eq(connections.id, connectionId))
		.run();
}

export function getConnection(db: DbOrTx, connectionId: number) {
	const row = db.select().from(connections).where(eq(connections.id, connectionId)).get();
	if (!row) throw new Error(`connection ${connectionId} not found`);
	return row;
}

export function listActiveConnections(db: DbOrTx) {
	return db
		.select({ id: connections.id, provider: connections.provider, institutionName: connections.institutionName, cursor: connections.cursor })
		.from(connections)
		.where(eq(connections.status, 'active'))
		.all();
}

export function upsertAccount(db: DbOrTx, connectionId: number, a: {
	externalId: string; name: string; officialName?: string | null; mask?: string | null; type: AccountType;
}): { id: number; created: boolean } {
	const existing = db
		.select({ id: accounts.id })
		.from(accounts)
		.where(and(eq(accounts.connectionId, connectionId), eq(accounts.externalId, a.externalId)))
		.get();
	if (existing) {
		db.update(accounts)
			.set({ name: a.name, officialName: a.officialName ?? null, mask: a.mask ?? null, ...touch() })
			.where(eq(accounts.id, existing.id))
			.run();
		return { id: existing.id, created: false };
	}
	const id = db.insert(accounts).values({
		connectionId,
		externalId: a.externalId,
		name: a.name,
		officialName: a.officialName ?? null,
		mask: a.mask ?? null,
		type: a.type,
		onBudget: (CASH_TYPES as readonly string[]).includes(a.type) || a.type === 'credit',
		isDebt: a.type === 'credit' || a.type === 'loan'
	}).returning({ id: accounts.id }).get().id;
	return { id, created: true };
}

export function accountsForConnection(db: DbOrTx, connectionId: number) {
	return db.select().from(accounts).where(eq(accounts.connectionId, connectionId)).all();
}

export function appendBalance(db: DbOrTx, accountId: number, b: {
	asOf: string; current: number; available?: number | null; creditLimit?: number | null; source: 'sync' | 'manual' | 'import';
}): number {
	return db.insert(accountBalances).values({
		accountId, asOf: b.asOf, current: b.current, available: b.available ?? null, creditLimit: b.creditLimit ?? null, source: b.source
	}).returning({ id: accountBalances.id }).get().id;
}

export function latestBalance(db: DbOrTx, accountId: number) {
	return db.select().from(accountBalances).where(eq(accountBalances.accountId, accountId))
		.orderBy(desc(accountBalances.asOf), desc(accountBalances.id)).get() ?? null;
}

export function latestTerms(db: DbOrTx, accountId: number) {
	return db.select().from(accountTerms).where(eq(accountTerms.accountId, accountId))
		.orderBy(desc(accountTerms.asOf), desc(accountTerms.id)).get() ?? null;
}

export type TermsInput = {
	asOf: string; aprBps?: number | null; promoAprBps?: number | null; minPayment?: number | null; nextDueDate?: string | null;
	lastStatementBalance?: number | null; lastStatementDate?: string | null; annualFee?: number | null; source: 'provider' | 'manual';
};

const TERM_FIELDS = ['aprBps', 'promoAprBps', 'minPayment', 'nextDueDate', 'lastStatementBalance', 'lastStatementDate', 'annualFee'] as const;

/** §4.1: append-only, insert on change. Manual edits always insert. */
export function appendTermsIfChanged(db: DbOrTx, accountId: number, t: TermsInput): boolean {
	const prev = latestTerms(db, accountId);
	if (t.source === 'provider' && prev) {
		const same = TERM_FIELDS.every((f) => (t[f] ?? null) === (prev[f] ?? null));
		if (same) return false;
	}
	db.insert(accountTerms).values({
		accountId, asOf: t.asOf, source: t.source,
		aprBps: t.aprBps ?? null, promoAprBps: t.promoAprBps ?? null, minPayment: t.minPayment ?? null,
		nextDueDate: t.nextDueDate ?? null, lastStatementBalance: t.lastStatementBalance ?? null,
		lastStatementDate: t.lastStatementDate ?? null, annualFee: t.annualFee ?? null
	}).run();
	return true;
}
```

The `db.query.accounts.findFirst` call in the test needs the relational query API, which `drizzle({ client, schema })` in Plan 1A already enables.

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/lib/server/settings.test.ts src/lib/server/sync/crypto.test.ts src/lib/server/sync/connections.test.ts`
Expected: PASS (1 + 2 + 4).

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/settings.ts src/lib/server/settings.test.ts src/lib/server/sync/
git commit -m "feat: settings, credential encryption, and connection service"
```

---

### Task 3: Sync types, content hash, and the manual provider

**Files:**
- Create: `src/lib/server/sync/types.ts`, `src/lib/server/sync/hash.ts`, `src/lib/server/sync/providers/manual.ts`
- Test: `src/lib/server/sync/hash.test.ts`

**Interfaces:**
- Produces (the contract every provider and the apply step share):

```ts
export type BatchAccount = { externalId: string; name: string; officialName?: string | null; mask?: string | null; type: AccountType };
export type BatchBalance = { accountExternalId: string; asOf: string; current: number; available?: number | null; creditLimit?: number | null };
export type BatchTransaction = {
	accountExternalId: string; externalId: string; pendingExternalId?: string | null;
	postedDate: string; transactedAt?: string | null; amount: number; payeeRaw: string; memo?: string | null;
	pending: boolean; providerCategory?: string | null;
};
export type BatchRemoval = { accountExternalId: string; externalId: string };
export type BatchTerms = { accountExternalId: string } & Omit<TermsInput, 'source'>;
export type SyncBatch = {
	accounts: BatchAccount[]; balances: BatchBalance[]; terms: BatchTerms[];
	added: BatchTransaction[]; modified: BatchTransaction[]; removed: BatchRemoval[];
	nextCursor: string | null;
	sendsRemovals: boolean;      // Plaid true; SimpleFIN and manual false → heuristic pending reconciliation
	coversFrom: string | null;   // earliest posted date this fetch could have returned (SimpleFIN start-date); null = full history/unknown
};
export type FetchMode = 'full' | 'balances';
export type FetchInput = { credential: string | null; cursor: string | null; mode: FetchMode; todayIso: string };
export interface SyncProvider { readonly kind: Provider; fetch(input: FetchInput): Promise<SyncBatch>; }
export class ProviderError extends Error { constructor(public readonly code: string, message: string, public readonly needsRelink = false) }
export function emptyBatch(cursor: string | null): SyncBatch
export function contentHash(parts: { accountKey: string; date: string; amount: number; description: string; ordinal: number }): string  // 'h1:' + 16 hex chars of sha256
export class ManualProvider implements SyncProvider  // kind 'manual', fetch → emptyBatch(cursor)
```

- [ ] **Step 1: Failing hash test**

```ts
import { describe, it, expect } from 'vitest';
import { contentHash } from './hash';

describe('contentHash', () => {
	it('is stable, ordinal-sensitive, and short', () => {
		const a = contentHash({ accountKey: 'acc', date: '2026-01-02', amount: -1234, description: 'COFFEE', ordinal: 0 });
		const b = contentHash({ accountKey: 'acc', date: '2026-01-02', amount: -1234, description: 'COFFEE', ordinal: 1 });
		expect(a).toBe(contentHash({ accountKey: 'acc', date: '2026-01-02', amount: -1234, description: 'COFFEE', ordinal: 0 }));
		expect(a).not.toBe(b);
		expect(a).toMatch(/^h1:[0-9a-f]{16}$/);
		expect(contentHash({ accountKey: 'acc', date: '2026-01-02', amount: -1234, description: '  coffee ', ordinal: 0 })).toBe(a);
	});
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/server/sync/hash.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement**

`hash.ts`:

```ts
import { createHash } from 'node:crypto';

/** Deterministic id for rows whose provider gives none. Description is normalised (trim, collapse spaces, lower-case). */
export function contentHash(p: { accountKey: string; date: string; amount: number; description: string; ordinal: number }): string {
	const desc = p.description.trim().replace(/\s+/g, ' ').toLowerCase();
	const h = createHash('sha256').update(`${p.accountKey}|${p.date}|${p.amount}|${desc}|${p.ordinal}`).digest('hex');
	return `h1:${h.slice(0, 16)}`;
}
```

`types.ts`:

```ts
import type { AccountType, Provider } from '../db/schema';
import type { TermsInput } from './connections';

export type BatchAccount = { externalId: string; name: string; officialName?: string | null; mask?: string | null; type: AccountType };
export type BatchBalance = { accountExternalId: string; asOf: string; current: number; available?: number | null; creditLimit?: number | null };
export type BatchTransaction = {
	accountExternalId: string;
	externalId: string;
	pendingExternalId?: string | null;
	postedDate: string;
	transactedAt?: string | null;
	amount: number;
	payeeRaw: string;
	memo?: string | null;
	pending: boolean;
	providerCategory?: string | null;
};
export type BatchRemoval = { accountExternalId: string; externalId: string };
export type BatchTerms = { accountExternalId: string } & Omit<TermsInput, 'source'>;

export type SyncBatch = {
	accounts: BatchAccount[];
	balances: BatchBalance[];
	terms: BatchTerms[];
	added: BatchTransaction[];
	modified: BatchTransaction[];
	removed: BatchRemoval[];
	nextCursor: string | null;
	sendsRemovals: boolean;
	coversFrom: string | null;
};

export type FetchMode = 'full' | 'balances';
export type FetchInput = { credential: string | null; cursor: string | null; mode: FetchMode; todayIso: string };

export interface SyncProvider {
	readonly kind: Provider;
	fetch(input: FetchInput): Promise<SyncBatch>;
}

export class ProviderError extends Error {
	constructor(public readonly code: string, message: string, public readonly needsRelink = false) {
		super(message);
		this.name = 'ProviderError';
	}
}

export function emptyBatch(cursor: string | null): SyncBatch {
	return { accounts: [], balances: [], terms: [], added: [], modified: [], removed: [], nextCursor: cursor, sendsRemovals: false, coversFrom: null };
}
```

`providers/manual.ts`:

```ts
import { emptyBatch, type FetchInput, type SyncBatch, type SyncProvider } from '../types';

/** Manual accounts never fetch; balances and CSV imports are entered through the app. */
export class ManualProvider implements SyncProvider {
	readonly kind = 'manual' as const;
	async fetch(input: FetchInput): Promise<SyncBatch> {
		return emptyBatch(input.cursor);
	}
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/server/sync/hash.test.ts` → PASS; `npm run check` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/sync/types.ts src/lib/server/sync/hash.ts src/lib/server/sync/hash.test.ts src/lib/server/sync/providers/manual.ts
git commit -m "feat: sync batch contract, content hash, manual provider"
```

---

### Task 4: `applyBatch` — one transaction per batch

**Files:**
- Create: `src/lib/server/sync/apply.ts`
- Test: `src/lib/server/sync/apply.test.ts`

**Interfaces:**
- Consumes: `SyncBatch`, `BatchTransaction`; `upsertAccount`, `appendBalance`, `appendTermsIfChanged`, `recordConnectionSuccess`; ledger `createTransaction`, `updateTransaction`, `softDelete`, `setReplacedBy`, `setSplits`, `linkTransfer`, `unlinkTransfer`, `clearReview`, `flagForReview`, `markProcessed`, `getTransaction`; `systemCategoryId(db,'reconciliation')`; `ensurePeriods`, `periodBoundsFor`, `nextPeriodStart`; `InvariantError`.
- Produces:
  - `type ApplyResult = { accountsCreated: number; added: number; modified: number; removed: number; balancesWritten: number; termsWritten: number; openingCreated: number; flagged: number; newTransactionIds: number[]; removedTransactionIds: number[] }`
  - `applyBatch(db: Db, connectionId: number, batch: SyncBatch, opts: { cadence: Cadence; todayIso: string; mode: FetchMode; now?: string }): ApplyResult` — everything inside one `db.transaction`; throws `InvariantError('UNKNOWN_ACCOUNT')` (rolling back) if a transaction names an account the batch and database don't know.
  - `PENDING_HEURISTIC_DAYS = 3`

Rules implemented (spec §5.1 step 3, §5.5, §5.6 opening balance, §4.1 pending convention):
- Periods are ensured from the minimum over rows of `min(transactedAt date, postedDate)` (and balance `asOf`) through the period after today.
- `removed` → `softDelete(..., 'provider_removed')`; ids returned so the runner can unwind bill links.
- `modified` → `updateTransaction`; an unknown external id in `modified` is treated as `added`; an already-present external id in `added` is treated as `modified` (idempotent replay).
- Explicit pending reconciliation: an added row with `pendingExternalId` matching a live pending row inherits splits, payee, memo, period, transfer link, and bill links; the pending row is soft-deleted with reason `pending_replaced` and `replaced_by_id` set. If the posted amount differs and the pending row had several splits, the new row gets one split for the full amount and is flagged `amount_changed`.
- Heuristic pending reconciliation (`sendsRemovals === false` only): a posted added row inherits from a live pending row on the same account with the same amount, within ±3 days, whose external id is not in this batch; two candidates flag the new row `pending_ambiguous` and inherit nothing.
- Opening balance (`mode === 'full'` only): for each account with a balance in this batch and no transactions before this batch, insert `opening = current − Σ(this batch's rows for the account, counting pending rows for credit accounts and excluding them for cash-type accounts)`, categorised to the reconciliation kind, `source = 'opening'`, `processed_at` set, dated at the earlier of the earliest posted date and the balance's `asOf`. Zero is not inserted.
- Cursor and `last_success_at` are written in the same transaction.

- [ ] **Step 1: Failing tests**

`src/lib/server/sync/apply.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, accountBalances, accountTerms, bills, billOccurrences, billOccurrenceTransactions, connections, periods, transactions } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, systemCategoryId, uncategorizedId } from '../ledger/categories';
import { createTransaction, getTransaction, linkTransfer, setSplits } from '../ledger/transactions';
import { createConnection } from './connections';
import { applyBatch } from './apply';
import { emptyBatch, type SyncBatch, type BatchTransaction } from './types';

const KEY = 'k'.repeat(44);
const TODAY = '2026-09-08';
let db: Db;
let conn: number;

function tx(p: Partial<BatchTransaction> & Pick<BatchTransaction, 'externalId' | 'amount' | 'postedDate'>): BatchTransaction {
	return { accountExternalId: 'chk', payeeRaw: 'PAYEE', pending: false, ...p };
}
function batch(p: Partial<SyncBatch>): SyncBatch {
	return {
		...emptyBatch('c1'),
		accounts: [
			{ externalId: 'chk', name: 'Checking', type: 'checking' },
			{ externalId: 'card', name: 'Card', type: 'credit' }
		],
		balances: [
			{ accountExternalId: 'chk', asOf: TODAY, current: 100000 },
			{ accountExternalId: 'card', asOf: TODAY, current: -8000 }
		],
		sendsRemovals: true,
		...p
	};
}
const opts = { cadence: 'semi_monthly' as const, todayIso: TODAY, mode: 'full' as const, now: '2026-09-08T03:00:00.000Z' };
const byExt = (ext: string) => db.select().from(transactions).where(eq(transactions.externalId, ext)).get();
const acct = (ext: string) => db.select().from(accounts).where(and(eq(accounts.connectionId, conn), eq(accounts.externalId, ext))).get()!;

beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	conn = createConnection(db, { provider: 'plaid', institutionName: 'T', appKey: KEY });
});

describe('applyBatch first sync', () => {
	it('creates accounts, balances, transactions, periods, and opening balances', () => {
		const r = applyBatch(db, conn, batch({
			added: [
				tx({ externalId: 't1', amount: -2500, postedDate: '2026-09-02' }),
				tx({ externalId: 't2', amount: -1500, postedDate: '2026-09-05', pending: true, transactedAt: '2026-09-04T18:00:00Z' }),
				tx({ externalId: 'c1', accountExternalId: 'card', amount: -8000, postedDate: '2026-09-06' })
			]
		}), opts);
		expect(r.accountsCreated).toBe(2);
		expect(r.added).toBe(3);
		expect(r.balancesWritten).toBe(2);
		expect(r.openingCreated).toBe(1);
		// checking: 100000 = opening + (-2500 posted); pending -1500 excluded for a cash account
		const opening = db.select().from(transactions).where(and(eq(transactions.accountId, acct('chk').id), eq(transactions.source, 'opening'))).get()!;
		expect(opening.amount).toBe(102500);
		expect(opening.postedDate).toBe('2026-09-02');
		expect(opening.processedAt).not.toBeNull();
		// card: -8000 = 0 opening + (-8000); nothing inserted for zero
		expect(db.select().from(transactions).where(and(eq(transactions.accountId, acct('card').id), eq(transactions.source, 'opening'))).all().length).toBe(0);
		// pending row took its period from the transacted date
		const t2 = byExt('t2')!;
		expect(db.select().from(periods).where(eq(periods.id, t2.periodId)).get()!.startDate).toBe('2026-09-01');
		expect(r.newTransactionIds.length).toBe(3);
		expect(db.select().from(connections).where(eq(connections.id, conn)).get()!.cursor).toBe('c1');
	});

	it('is idempotent on replay and treats re-added rows as modifications', () => {
		const b = batch({ added: [tx({ externalId: 't1', amount: -2500, postedDate: '2026-09-02' })] });
		applyBatch(db, conn, b, opts);
		const r = applyBatch(db, conn, { ...b, added: [tx({ externalId: 't1', amount: -2600, postedDate: '2026-09-02' })] }, opts);
		expect(r.added).toBe(0);
		expect(r.modified).toBe(1);
		expect(r.openingCreated).toBe(0);
		expect(db.select().from(transactions).where(eq(transactions.externalId, 't1')).all().length).toBe(1);
		expect(byExt('t1')!.amount).toBe(-2600);
	});

	it('skips opening balances in balances mode', () => {
		const r = applyBatch(db, conn, batch({}), { ...opts, mode: 'balances' });
		expect(r.openingCreated).toBe(0);
		expect(r.balancesWritten).toBe(2);
	});

	it('rolls back everything on an unknown account', () => {
		expect(() => applyBatch(db, conn, batch({ added: [tx({ externalId: 'x', accountExternalId: 'ghost', amount: -1, postedDate: TODAY })] }), opts))
			.toThrowError(/UNKNOWN_ACCOUNT/);
		expect(db.select().from(accounts).all().length).toBe(0);
		expect(db.select().from(accountBalances).all().length).toBe(0);
	});
});

describe('applyBatch pending reconciliation', () => {
	it('explicit: a posted row inherits the pending row\'s edits, links, and bill links', () => {
		applyBatch(db, conn, batch({ added: [tx({ externalId: 'p1', amount: -4200, postedDate: '2026-09-03', pending: true })] }), opts);
		const pendingId = byExt('p1')!.id;
		const g = createGroup(db, 'Spending');
		const groceries = createCategory(db, { groupId: g, name: 'Groceries', kind: 'spending' });
		setSplits(db, pendingId, [{ categoryId: groceries, amount: -4200 }]);
		db.update(transactions).set({ payee: 'Grocer', memo: 'weekly', processedAt: '2026-09-03T00:00:00Z' }).where(eq(transactions.id, pendingId)).run();

		const r = applyBatch(db, conn, batch({
			added: [tx({ externalId: 'q1', pendingExternalId: 'p1', amount: -4200, postedDate: '2026-09-05', pending: false })]
		}), opts);
		expect(r.added).toBe(1);
		const old = getTransaction(db, pendingId);
		const posted = getTransaction(db, byExt('q1')!.id);
		expect(old.deletedAt).not.toBeNull();
		expect(old.replacedById).toBe(posted.id);
		expect(posted.splits[0].categoryId).toBe(groceries);
		expect(posted.payee).toBe('Grocer');
		expect(posted.memo).toBe('weekly');
		expect(posted.periodId).toBe(old.periodId);
		expect(posted.processedAt).not.toBeNull();
		expect(posted.needsReview).toBe(false);
	});

	it('explicit: a changed amount on a multi-split pending row flags the posted row', () => {
		applyBatch(db, conn, batch({ added: [tx({ externalId: 'p2', amount: -1000, postedDate: '2026-09-03', pending: true })] }), opts);
		const id = byExt('p2')!.id;
		setSplits(db, id, [{ categoryId: uncategorizedId(db), amount: -600 }, { categoryId: uncategorizedId(db), amount: -400 }]);
		applyBatch(db, conn, batch({ added: [tx({ externalId: 'q2', pendingExternalId: 'p2', amount: -1100, postedDate: '2026-09-05' })] }), opts);
		const posted = getTransaction(db, byExt('q2')!.id);
		expect(posted.amount).toBe(-1100);
		expect(posted.splits.length).toBe(1);
		expect(posted.reviewReason).toBe('amount_changed');
	});

	it('explicit: re-links a transfer peer and re-points bill occurrence links', () => {
		applyBatch(db, conn, batch({ added: [
			tx({ externalId: 'p3', amount: -25000, postedDate: '2026-09-03', pending: true }),
			tx({ externalId: 'k3', accountExternalId: 'card', amount: 25000, postedDate: '2026-09-03' })
		] }), opts);
		const pendingId = byExt('p3')!.id, peerId = byExt('k3')!.id;
		linkTransfer(db, pendingId, peerId);
		// a bare bill and occurrence (the bills service lands in Task 6); only the link row matters here
		const billId = db.insert(bills).values({ name: 'Card', categoryId: systemCategoryId(db, 'transfer'), payFromAccountId: acct('chk').id, expectedAmount: 25000, cadence: 'monthly', dueDay: 3 }).returning({ id: bills.id }).get().id;
		const occId = db.insert(billOccurrences).values({ billId, dueDate: '2026-09-03', periodId: getTransaction(db, pendingId).periodId, expectedAmount: 25000, windowStart: '2026-08-20', windowEnd: '2026-09-08' }).returning({ id: billOccurrences.id }).get().id;
		db.insert(billOccurrenceTransactions).values({ billOccurrenceId: occId, transactionId: pendingId }).run();

		applyBatch(db, conn, batch({ added: [tx({ externalId: 'q3', pendingExternalId: 'p3', amount: -25000, postedDate: '2026-09-05' })] }), opts);
		const posted = getTransaction(db, byExt('q3')!.id);
		expect(posted.transferPeerId).toBe(peerId);
		expect(getTransaction(db, peerId).transferPeerId).toBe(posted.id);
		expect(getTransaction(db, peerId).needsReview).toBe(false);
		expect(db.select().from(billOccurrenceTransactions).all()).toEqual([{ billOccurrenceId: occId, transactionId: posted.id }]);
	});

	it('heuristic: matches one pending row by amount and date when the provider sends no removals', () => {
		const b = batch({ sendsRemovals: false, added: [tx({ externalId: 'sf-1', amount: -777, postedDate: '2026-09-03', pending: true })] });
		applyBatch(db, conn, b, opts);
		const pendingId = byExt('sf-1')!.id;
		db.update(transactions).set({ payee: 'Cafe' }).where(eq(transactions.id, pendingId)).run();
		const r = applyBatch(db, conn, { ...b, added: [tx({ externalId: 'sf-2', amount: -777, postedDate: '2026-09-05', pending: false })] }, opts);
		expect(r.added).toBe(1);
		expect(getTransaction(db, pendingId).deletedAt).not.toBeNull();
		expect(getTransaction(db, byExt('sf-2')!.id).payee).toBe('Cafe');
	});

	it('heuristic: two candidates flag the new row and inherit nothing', () => {
		const b = batch({ sendsRemovals: false, added: [
			tx({ externalId: 'a', amount: -500, postedDate: '2026-09-03', pending: true }),
			tx({ externalId: 'b', amount: -500, postedDate: '2026-09-04', pending: true })
		] });
		applyBatch(db, conn, b, opts);
		applyBatch(db, conn, { ...b, added: [tx({ externalId: 'c', amount: -500, postedDate: '2026-09-05' })] }, opts);
		expect(getTransaction(db, byExt('c')!.id).reviewReason).toBe('pending_ambiguous');
		expect(getTransaction(db, byExt('a')!.id).deletedAt).toBeNull();
	});
});

describe('applyBatch modified, removed, terms', () => {
	it('applies removals as soft deletes and returns their ids', () => {
		applyBatch(db, conn, batch({ added: [tx({ externalId: 'r1', amount: -100, postedDate: '2026-09-03' })] }), opts);
		const r = applyBatch(db, conn, batch({ removed: [{ accountExternalId: 'chk', externalId: 'r1' }] }), opts);
		expect(r.removed).toBe(1);
		expect(r.removedTransactionIds).toEqual([byExt('r1')!.id]);
		expect(byExt('r1')!.reviewReason).toBe('provider_removed');
	});
	it('applies modifications through updateTransaction', () => {
		applyBatch(db, conn, batch({ added: [tx({ externalId: 'm1', amount: -100, postedDate: '2026-09-03' })] }), opts);
		const r = applyBatch(db, conn, batch({ modified: [tx({ externalId: 'm1', amount: -120, postedDate: '2026-09-04', payeeRaw: 'NEW' })] }), opts);
		expect(r.modified).toBe(1);
		const t = getTransaction(db, byExt('m1')!.id);
		expect(t.amount).toBe(-120);
		expect(t.splits[0].amount).toBe(-120);
		expect(t.payeeRaw).toBe('NEW');
	});
	it('appends terms only on change', () => {
		const terms = [{ accountExternalId: 'card', asOf: TODAY, aprBps: 2749, minPayment: 3500, nextDueDate: '2026-09-15' }];
		expect(applyBatch(db, conn, batch({ terms }), opts).termsWritten).toBe(1);
		expect(applyBatch(db, conn, batch({ terms }), opts).termsWritten).toBe(0);
		expect(db.select().from(accountTerms).all().length).toBe(1);
	});
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/server/sync/apply.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `apply.ts`**

```ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db';
import { accounts, billOccurrenceTransactions, transactions, CASH_TYPES } from '../db/schema';
import { ensurePeriods, periodBoundsFor, nextPeriodStart, type Cadence } from '../budget/periods';
import {
	createTransaction, updateTransaction, softDelete, setReplacedBy, setSplits, linkTransfer, unlinkTransfer,
	clearReview, flagForReview, markProcessed, getTransaction
} from '../ledger/transactions';
import { systemCategoryId } from '../ledger/categories';
import { InvariantError } from '../ledger/errors';
import { upsertAccount, appendBalance, appendTermsIfChanged, recordConnectionSuccess } from './connections';
import type { BatchTransaction, FetchMode, SyncBatch } from './types';
import { compareIso, nowIso, parseIso } from '$lib/dates';

export const PENDING_HEURISTIC_DAYS = 3;

export type ApplyResult = {
	accountsCreated: number; added: number; modified: number; removed: number;
	balancesWritten: number; termsWritten: number; openingCreated: number; flagged: number;
	newTransactionIds: number[]; removedTransactionIds: number[];
};

type AcctInfo = { id: number; type: string; hadTransactions: boolean };

function dayDiff(a: string, b: string): number {
	return Math.abs((parseIso(a).getTime() - parseIso(b).getTime()) / 86_400_000);
}

function liveByExternal(tx: DbOrTx, accountId: number, externalId: string) {
	return tx.select().from(transactions)
		.where(and(eq(transactions.accountId, accountId), eq(transactions.externalId, externalId), isNull(transactions.deletedAt)))
		.get() ?? null;
}

export function applyBatch(db: Db, connectionId: number, batch: SyncBatch, opts: { cadence: Cadence; todayIso: string; mode: FetchMode; now?: string }): ApplyResult {
	const now = opts.now ?? nowIso();
	return db.transaction((tx) => {
		const result: ApplyResult = {
			accountsCreated: 0, added: 0, modified: 0, removed: 0, balancesWritten: 0, termsWritten: 0,
			openingCreated: 0, flagged: 0, newTransactionIds: [], removedTransactionIds: []
		};

		// 1. Periods for every date the batch can touch (§5.1).
		const dates = [opts.todayIso, ...batch.balances.map((b) => b.asOf)];
		for (const t of [...batch.added, ...batch.modified]) {
			dates.push(t.postedDate);
			if (t.transactedAt) dates.push(t.transactedAt.slice(0, 10));
		}
		const from = dates.reduce((m, d) => (compareIso(d, m) < 0 ? d : m));
		const next = periodBoundsFor(opts.cadence, nextPeriodStart(opts.cadence, periodBoundsFor(opts.cadence, opts.todayIso).endDate));
		ensurePeriods(tx, opts.cadence, from, next.endDate);

		// 2. Accounts. Record whether each had transactions before this batch (for opening balances).
		const info = new Map<string, AcctInfo>();
		const known = tx.select().from(accounts).where(eq(accounts.connectionId, connectionId)).all();
		for (const a of known) info.set(a.externalId, { id: a.id, type: a.type, hadTransactions: hasTransactions(tx, a.id) });
		for (const a of batch.accounts) {
			const { id, created } = upsertAccount(tx, connectionId, a);
			if (created) result.accountsCreated++;
			if (!info.has(a.externalId)) info.set(a.externalId, { id, type: a.type, hadTransactions: false });
		}
		const acct = (ext: string): AcctInfo => {
			const a = info.get(ext);
			if (!a) throw new InvariantError('UNKNOWN_ACCOUNT');
			return a;
		};

		// 3. Balances and terms (append-only).
		for (const b of batch.balances) { appendBalance(tx, acct(b.accountExternalId).id, { ...b, source: 'sync' }); result.balancesWritten++; }
		for (const t of batch.terms) if (appendTermsIfChanged(tx, acct(t.accountExternalId).id, { ...t, source: 'provider' })) result.termsWritten++;

		// 4. Removals (§5.7). Bill-link unwinding happens in the runner from removedTransactionIds.
		for (const r of batch.removed) {
			const row = liveByExternal(tx, acct(r.accountExternalId).id, r.externalId);
			if (!row) continue;
			softDelete(tx, row.id, 'provider_removed');
			result.removed++;
			result.removedTransactionIds.push(row.id);
		}

		// 5. Modifications (§5.6). Unknown ids fall through to the add path.
		const toAdd: BatchTransaction[] = [];
		for (const m of batch.modified) {
			const row = liveByExternal(tx, acct(m.accountExternalId).id, m.externalId);
			if (!row) { toAdd.push(m); continue; }
			applyModification(tx, row.id, m, result);
		}

		// 6. Additions with pending reconciliation (§5.5).
		// Every external id returned by this fetch, added or modified: none of them can be a stale pending row (§5.5).
		const batchIds = new Set([...batch.added, ...batch.modified].map((t) => t.externalId));
		const addedPerAccount = new Map<number, { sum: number; earliest: string }>();
		for (const t of [...batch.added, ...toAdd]) {
			const a = acct(t.accountExternalId);
			const existing = liveByExternal(tx, a.id, t.externalId);
			if (existing) { applyModification(tx, existing.id, t, result); continue; }

			let inheritFrom: number | null = null;
			let ambiguous = false;
			if (t.pendingExternalId) {
				const old = liveByExternal(tx, a.id, t.pendingExternalId);
				if (old && old.pending) inheritFrom = old.id;
			} else if (!batch.sendsRemovals && !t.pending) {
				const cands = tx.select({ id: transactions.id, externalId: transactions.externalId, postedDate: transactions.postedDate })
					.from(transactions)
					.where(and(eq(transactions.accountId, a.id), eq(transactions.pending, true), eq(transactions.amount, t.amount), isNull(transactions.deletedAt)))
					.all()
					.filter((c) => !batchIds.has(c.externalId) && dayDiff(c.postedDate, t.postedDate) <= PENDING_HEURISTIC_DAYS);
				if (cands.length === 1) inheritFrom = cands[0].id;
				else if (cands.length > 1) ambiguous = true;
			}

			const newId = inheritFrom != null ? inheritTransaction(tx, inheritFrom, t, a.id, result) : createTransaction(tx, plain(t, a.id));
			if (ambiguous) { flagForReview(tx, newId, 'pending_ambiguous'); result.flagged++; }
			result.added++;
			result.newTransactionIds.push(newId);

			const countsTowardBalance = !t.pending || !(CASH_TYPES as readonly string[]).includes(a.type);
			const agg = addedPerAccount.get(a.id) ?? { sum: 0, earliest: t.postedDate };
			if (countsTowardBalance) agg.sum += t.amount;
			if (compareIso(t.postedDate, agg.earliest) < 0) agg.earliest = t.postedDate;
			addedPerAccount.set(a.id, agg);
		}

		// 7. Opening balances on an account's first full sync (§5.6 step 1).
		if (opts.mode === 'full') {
			const recon = systemCategoryId(tx, 'reconciliation');
			for (const b of batch.balances) {
				const a = acct(b.accountExternalId);
				if (a.hadTransactions) continue;
				const agg = addedPerAccount.get(a.id) ?? { sum: 0, earliest: b.asOf };
				const amount = b.current - agg.sum;
				if (amount === 0) continue;
				const postedDate = compareIso(agg.earliest, b.asOf) < 0 ? agg.earliest : b.asOf;
				const id = createTransaction(tx, {
					accountId: a.id, externalId: 'opening', postedDate, amount, payeeRaw: 'Opening balance', payee: 'Opening balance',
					source: 'opening', splits: [{ categoryId: recon, amount }]
				});
				markProcessed(tx, [id]);
				result.openingCreated++;
				a.hadTransactions = true;
			}
		}

		// 8. Cursor and success in the same transaction (§5.1).
		recordConnectionSuccess(tx, connectionId, batch.nextCursor, now);
		return result;
	});
}

function hasTransactions(tx: DbOrTx, accountId: number): boolean {
	const row = tx.select({ n: sql<number>`count(*)` }).from(transactions).where(eq(transactions.accountId, accountId)).get();
	return (row?.n ?? 0) > 0;
}

function plain(t: BatchTransaction, accountId: number) {
	return {
		accountId, externalId: t.externalId, pendingExternalId: t.pendingExternalId ?? null,
		postedDate: t.postedDate, transactedAt: t.transactedAt ?? null, amount: t.amount,
		payeeRaw: t.payeeRaw, memo: t.memo ?? null, pending: t.pending, providerCategory: t.providerCategory ?? null,
		source: 'sync' as const
	};
}

function applyModification(tx: DbOrTx, id: number, m: BatchTransaction, result: ApplyResult): void {
	const r = updateTransaction(tx, id, {
		amount: m.amount, postedDate: m.postedDate, transactedAt: m.transactedAt ?? null, pending: m.pending,
		payeeRaw: m.payeeRaw, providerCategory: m.providerCategory ?? null
	});
	result.modified++;
	if (r.flagged) result.flagged++;
}

/** Create the posted row as the pending row's successor, carrying every user-facing edit across (§5.5). */
function inheritTransaction(tx: DbOrTx, oldId: number, t: BatchTransaction, accountId: number, result: ApplyResult): number {
	const old = getTransaction(tx, oldId);
	const sameAmount = old.amount === t.amount;
	let splits = old.splits.map((s) => ({ categoryId: s.categoryId, amount: s.amount, memo: s.memo }));
	let flagAmount = false;
	if (!sameAmount) {
		if (splits.length === 1) splits = [{ ...splits[0], amount: t.amount }];
		else { splits = [{ categoryId: splits[0].categoryId, amount: t.amount, memo: null }]; flagAmount = true; }
	}
	const peer = old.transferPeerId;
	if (peer != null) unlinkTransfer(tx, oldId);
	const newId = createTransaction(tx, {
		...plain(t, accountId), pendingExternalId: old.externalId, payee: old.payee, memo: old.memo, periodId: old.periodId, splits
	});
	if (peer != null) {
		linkTransfer(tx, newId, peer);
		setSplits(tx, newId, splits);      // linkTransfer resets both sides to the transfer kind; restore the near side's categorisation
		clearReview(tx, peer);
	}
	tx.update(billOccurrenceTransactions).set({ transactionId: newId }).where(eq(billOccurrenceTransactions.transactionId, oldId)).run();
	softDelete(tx, oldId, 'pending_replaced');
	setReplacedBy(tx, oldId, newId);
	if (old.processedAt) markProcessed(tx, [newId]);
	if (old.needsReview && old.reviewReason) flagForReview(tx, newId, old.reviewReason);
	if (flagAmount) { flagForReview(tx, newId, 'amount_changed'); result.flagged++; }
	return newId;
}
```

Notes for the implementer: `unlinkTransfer` flags both sides with `transfer_unlinked`; the code above re-links and clears the peer's flag, and the old row is about to be soft-deleted so its flag is irrelevant. The `setSplits` after `linkTransfer` keeps a loan-payment categorisation (near side categorised to the loan's payment category, spec §5.6 step 3) intact across pending-to-posted.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/server/sync/apply.test.ts` → PASS (12 tests). Then `npm test` and `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/sync/apply.ts src/lib/server/sync/apply.test.ts
git commit -m "feat: applyBatch with pending reconciliation and opening balances"
```

---

### Task 5: Payee rules and transfer detection

**Files:**
- Create: `src/lib/server/sync/payees.ts`, `src/lib/server/sync/transfers.ts`
- Test: `src/lib/server/sync/payees.test.ts`, `src/lib/server/sync/transfers.test.ts`

**Interfaces:**
- Consumes: `payeeRules`, `transactions`, `transactionSplits`, `accounts` schema; ledger `setPayee`, `setSplits`, `linkTransfer`, `flagForReview`, `getTransaction`; `paymentCategoryForAccount`, `uncategorizedId`; `CASH_TYPES`.
- Produces:
  - `createPayeeRule(db, input: { pattern: string; isRegex?: boolean; payee: string; categoryId?: number | null; priority?: number }): number`
  - `matchPayeeRule(rules: PayeeRule[], payeeRaw: string): PayeeRule | null` — pure; rules sorted by priority ascending then id; substring match is case-insensitive; regex uses flag `i`; an invalid regex never matches.
  - `applyPayeeRules(db, transactionIds: number[]): { renamed: number; categorized: number }` — sets `payee`; sets the category only when the rule has one and the transaction's single split is Uncategorized.
  - `detectTransfers(db, candidateIds: number[], opts: { windowDays: number }): { linked: number; flagged: number; categorized: number }` — spec §5.6 step 3.
  - `PAYMENT_HINT = /payment|pymt|pmt|transfer|xfer|autopay|epay|online pay/i`

- [ ] **Step 1: Failing tests**

`payees.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, connections, payeeRules } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, uncategorizedId } from '../ledger/categories';
import { ensurePeriods } from '../budget/periods';
import { createTransaction, getTransaction, setSplits } from '../ledger/transactions';
import { createPayeeRule, matchPayeeRule, applyPayeeRules } from './payees';

let db: Db; let chk: number; let groceries: number;
beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-12-31');
	const c = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get().id;
	chk = db.insert(accounts).values({ connectionId: c, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
	groceries = createCategory(db, { groupId: createGroup(db, 'Spending'), name: 'Groceries', kind: 'spending' });
});

describe('matchPayeeRule', () => {
	it('picks by priority, matches substrings case-insensitively, and ignores bad regexes', () => {
		createPayeeRule(db, { pattern: 'amzn', payee: 'Amazon', priority: 50 });
		createPayeeRule(db, { pattern: '^AMZN MKTP', isRegex: true, payee: 'Amazon Marketplace', priority: 10 });
		createPayeeRule(db, { pattern: '(', isRegex: true, payee: 'broken', priority: 1 });
		const rules = db.select().from(payeeRules).all();
		expect(matchPayeeRule(rules, 'AMZN MKTP US*2K4')?.payee).toBe('Amazon Marketplace');
		expect(matchPayeeRule(rules, 'Prime Video amzn.com')?.payee).toBe('Amazon');
		expect(matchPayeeRule(rules, 'COSTCO')).toBeNull();
	});
});

describe('applyPayeeRules', () => {
	it('renames and categorises only uncategorised single-split rows', () => {
		createPayeeRule(db, { pattern: 'grocer', payee: 'Grocer', categoryId: groceries });
		const a = createTransaction(db, { accountId: chk, externalId: 'a', postedDate: '2026-03-01', amount: -1000, payeeRaw: 'THE GROCER #12', source: 'sync' });
		const b = createTransaction(db, { accountId: chk, externalId: 'b', postedDate: '2026-03-02', amount: -1000, payeeRaw: 'THE GROCER #12', source: 'sync' });
		setSplits(db, b, [{ categoryId: uncategorizedId(db), amount: -600 }, { categoryId: groceries, amount: -400 }]);
		const r = applyPayeeRules(db, [a, b]);
		expect(r).toEqual({ renamed: 2, categorized: 1 });
		expect(getTransaction(db, a).payee).toBe('Grocer');
		expect(getTransaction(db, a).splits[0].categoryId).toBe(groceries);
		expect(getTransaction(db, b).splits.length).toBe(2);
	});
});
```

`transfers.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, connections } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, systemCategoryId } from '../ledger/categories';
import { ensurePeriods } from '../budget/periods';
import { createTransaction, getTransaction } from '../ledger/transactions';
import { detectTransfers } from './transfers';

let db: Db; let chk: number; let card: number; let loan: number; let savings: number;
const mk = (accountId: number, ext: string, amount: number, postedDate: string, payeeRaw: string) =>
	createTransaction(db, { accountId, externalId: ext, postedDate, amount, payeeRaw, source: 'sync' });

beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-12-31');
	const c = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get().id;
	const add = (ext: string, type: 'checking' | 'savings' | 'credit' | 'loan', onBudget: boolean, isDebt: boolean) =>
		db.insert(accounts).values({ connectionId: c, externalId: ext, name: ext, type, onBudget, isDebt }).returning({ id: accounts.id }).get().id;
	chk = add('chk', 'checking', true, false);
	savings = add('sav', 'savings', true, false);
	card = add('card', 'credit', true, true);
	loan = add('loan', 'loan', false, true);
});

describe('detectTransfers', () => {
	it('links a card payment pair and leaves both as transfer kind', () => {
		const a = mk(chk, 'a', -25000, '2026-03-10', 'CHASE CREDIT CRD AUTOPAY');
		const b = mk(card, 'b', 25000, '2026-03-11', 'Payment Thank You');
		const r = detectTransfers(db, [a, b], { windowDays: 4 });
		expect(r).toEqual({ linked: 1, flagged: 0, categorized: 0 });
		expect(getTransaction(db, a).transferPeerId).toBe(b);
		expect(getTransaction(db, a).splits[0].categoryId).toBe(systemCategoryId(db, 'transfer'));
	});
	it('prefers the payment-looking counterpart over a same-amount refund', () => {
		const pay = mk(chk, 'p', -10000, '2026-03-10', 'ONLINE PAYMENT TO CARD');
		const refund = mk(card, 'r', 10000, '2026-03-09', 'REFUND ACME STORE');
		const recv = mk(card, 'q', 10000, '2026-03-11', 'PAYMENT RECEIVED');
		detectTransfers(db, [pay], { windowDays: 4 });
		expect(getTransaction(db, pay).transferPeerId).toBe(recv);
		expect(getTransaction(db, refund).transferPeerId).toBeNull();
	});
	it('flags an unresolvable tie instead of guessing', () => {
		const pay = mk(chk, 'p', -10000, '2026-03-10', 'XFER');
		mk(card, 'x', 10000, '2026-03-10', 'PAYMENT');
		mk(card, 'y', 10000, '2026-03-11', 'PAYMENT');
		const r = detectTransfers(db, [pay], { windowDays: 4 });
		expect(r.flagged).toBe(1);
		expect(getTransaction(db, pay).reviewReason).toBe('transfer_ambiguous');
		expect(getTransaction(db, pay).transferPeerId).toBeNull();
	});
	it('categorises the near side of an off-budget transfer to the far account\'s payment category', () => {
		const loanEnv = createCategory(db, { groupId: createGroup(db, 'Debt'), name: 'SoFi', kind: 'debt_payment', accountId: loan });
		const near = mk(chk, 'n', -87829, '2026-03-21', 'SOFI LOAN PMT');
		const far = mk(loan, 'f', 87829, '2026-03-21', 'PAYMENT');
		const r = detectTransfers(db, [near], { windowDays: 4 });
		expect(r.categorized).toBe(1);
		expect(getTransaction(db, near).transferPeerId).toBe(far);
		expect(getTransaction(db, near).splits[0].categoryId).toBe(loanEnv);
		expect(getTransaction(db, far).splits[0].categoryId).toBe(systemCategoryId(db, 'transfer'));
	});
	it('flags an off-budget transfer whose far account has no payment category', () => {
		const near = mk(chk, 'n', -500, '2026-03-21', 'LOAN PMT');
		mk(loan, 'f', 500, '2026-03-21', 'PAYMENT');
		const r = detectTransfers(db, [near], { windowDays: 4 });
		expect(r.flagged).toBe(1);
		expect(getTransaction(db, near).reviewReason).toBe('transfer_off_budget_uncategorized');
	});
	it('ignores pairs outside the window and pairs with no cash side', () => {
		const a = mk(chk, 'a', -100, '2026-03-01', 'X');
		mk(savings, 'b', 100, '2026-03-20', 'X');
		const c = mk(card, 'c', -300, '2026-03-05', 'BAL XFER');
		mk(loan, 'd', 300, '2026-03-05', 'BAL XFER');
		const r = detectTransfers(db, [a, c], { windowDays: 4 });
		expect(r.linked).toBe(0);
		expect(getTransaction(db, c).transferPeerId).toBeNull();
	});
});
```

- [ ] **Step 2: Run to verify failure** — both files: FAIL, modules not found.

- [ ] **Step 3: Implement `payees.ts`**

```ts
import { asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { payeeRules } from '../db/schema';
import { getTransaction, setPayee, setSplits } from '../ledger/transactions';
import { uncategorizedId } from '../ledger/categories';

export type PayeeRule = typeof payeeRules.$inferSelect;

export function createPayeeRule(db: DbOrTx, input: { pattern: string; isRegex?: boolean; payee: string; categoryId?: number | null; priority?: number }): number {
	return db.insert(payeeRules).values({
		pattern: input.pattern, isRegex: input.isRegex ?? false, payee: input.payee,
		categoryId: input.categoryId ?? null, priority: input.priority ?? 100
	}).returning({ id: payeeRules.id }).get().id;
}

export function listPayeeRules(db: DbOrTx): PayeeRule[] {
	return db.select().from(payeeRules).orderBy(asc(payeeRules.priority), asc(payeeRules.id)).all();
}

/** First rule (by priority, then id) whose pattern matches. An invalid regex never matches. */
export function matchPayeeRule(rules: PayeeRule[], payeeRaw: string): PayeeRule | null {
	const sorted = [...rules].sort((a, b) => a.priority - b.priority || a.id - b.id);
	const hay = payeeRaw.toLowerCase();
	for (const r of sorted) {
		if (r.isRegex) {
			try { if (new RegExp(r.pattern, 'i').test(payeeRaw)) return r; } catch { /* invalid pattern: skip */ }
		} else if (hay.includes(r.pattern.toLowerCase())) {
			return r;
		}
	}
	return null;
}

export function applyPayeeRules(db: DbOrTx, transactionIds: number[]): { renamed: number; categorized: number } {
	const rules = listPayeeRules(db);
	const uncategorized = uncategorizedId(db);
	let renamed = 0, categorized = 0;
	for (const id of transactionIds) {
		const t = getTransaction(db, id);
		const rule = matchPayeeRule(rules, t.payeeRaw);
		if (!rule) continue;
		if (t.payee !== rule.payee) { setPayee(db, id, rule.payee); renamed++; }
		if (rule.categoryId != null && t.splits.length === 1 && t.splits[0].categoryId === uncategorized) {
			setSplits(db, id, [{ categoryId: rule.categoryId, amount: t.amount }]);
			categorized++;
		}
	}
	return { renamed, categorized };
}
```

- [ ] **Step 4: Implement `transfers.ts`**

```ts
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, transactions, CASH_TYPES } from '../db/schema';
import { flagForReview, getTransaction, linkTransfer, setSplits } from '../ledger/transactions';
import { paymentCategoryForAccount } from '../ledger/categories';
import { parseIso } from '$lib/dates';

export const PAYMENT_HINT = /payment|pymt|pmt|transfer|xfer|autopay|epay|online pay/i;

function dayDiff(a: string, b: string): number {
	return Math.abs((parseIso(a).getTime() - parseIso(b).getTime()) / 86_400_000);
}

/**
 * Spec §5.6 step 3. For each candidate: find the unique equal-and-opposite counterpart on another
 * account inside the window, requiring a cash-type on-budget side. Link both. If the far account is
 * off-budget, categorise the near side to that account's payment category or flag it.
 */
export function detectTransfers(db: DbOrTx, candidateIds: number[], opts: { windowDays: number }): { linked: number; flagged: number; categorized: number } {
	const acctById = new Map(db.select().from(accounts).all().map((a) => [a.id, a]));
	const isCash = (id: number) => { const a = acctById.get(id)!; return a.onBudget && (CASH_TYPES as readonly string[]).includes(a.type); };
	let linked = 0, flagged = 0, categorized = 0;

	for (const id of candidateIds) {
		const t = db.select().from(transactions).where(eq(transactions.id, id)).get();
		if (!t || t.deletedAt || t.transferPeerId != null) continue;
		const cands = db.select().from(transactions)
			.where(and(
				eq(transactions.amount, -t.amount), ne(transactions.accountId, t.accountId), ne(transactions.id, id),
				isNull(transactions.transferPeerId), isNull(transactions.deletedAt)
			))
			.all()
			.filter((c) => dayDiff(c.postedDate, t.postedDate) <= opts.windowDays)
			.filter((c) => isCash(t.accountId) || isCash(c.accountId));
		if (cands.length === 0) continue;

		let chosen = cands;
		if (chosen.length > 1) {
			// Only the counterpart's payee can discriminate; the near side's own payee is common to every candidate pair.
			const hinted = chosen.filter((c) => PAYMENT_HINT.test(c.payeeRaw));
			if (hinted.length >= 1) chosen = hinted;
		}
		if (chosen.length > 1) { flagForReview(db, id, 'transfer_ambiguous'); flagged++; continue; }

		const peer = chosen[0];
		linkTransfer(db, id, peer.id);
		linked++;

		// Off-budget far side: the on-budget near side keeps a budget category (§5.6 step 3).
		for (const [near, far] of [[t, peer], [peer, t]] as const) {
			const nearAcct = acctById.get(near.accountId)!, farAcct = acctById.get(far.accountId)!;
			if (!nearAcct.onBudget || farAcct.onBudget) continue;
			const payCat = paymentCategoryForAccount(db, farAcct.id);
			const full = getTransaction(db, near.id);
			if (payCat != null) { setSplits(db, near.id, [{ categoryId: payCat, amount: full.amount }]); categorized++; }
			else { flagForReview(db, near.id, 'transfer_off_budget_uncategorized'); flagged++; }
		}
	}
	return { linked, flagged, categorized };
}
```

- [ ] **Step 5: Run to verify pass** — `npx vitest run src/lib/server/sync/payees.test.ts src/lib/server/sync/transfers.test.ts` → PASS (2 + 6). Then `npm test`, `npm run check`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/sync/payees.ts src/lib/server/sync/payees.test.ts src/lib/server/sync/transfers.ts src/lib/server/sync/transfers.test.ts
git commit -m "feat: payee rules and transfer detection"
```

---

### Task 6: Bills and income definitions, occurrence generation

**Files:**
- Create: `src/lib/server/bills/schedule.ts`, `src/lib/server/bills/bills.ts`
- Test: `src/lib/server/bills/schedule.test.ts`, `src/lib/server/bills/bills.test.ts`

**Interfaces:**
- Consumes: `bills`, `billOccurrences`, `incomeSources`, `incomeOccurrences` schema; `latestTerms`; `ensurePeriods`, `periodIdForDate`, `periodBoundsFor`, `nextPeriodStart`; `addDays`, `endOfMonth`, `compareIso`, `parseIso`, `isoDate`.
- Produces:
  - `type Schedule = { cadence: BillCadence; dueDay?: number | null; dueDay2?: number | null; interval?: number | null; anchorDate?: string | null }`
  - `dueDatesBetween(s: Schedule, fromIso: string, throughIso: string): string[]` — pure, ascending, inclusive; monthly clamps to month end; `every_n_weeks` steps `interval × 7` days from `anchorDate`; yearly repeats `anchorDate`'s month and day.
  - `createBill(db, input: NewBill): number`, `updateBill(db, id, patch: Partial<NewBill>)`, `setBillActive(db, id, active)`, `listBills(db)`; `createIncomeSource(db, input: NewIncome): number`, `updateIncomeSource`, `setIncomeActive`, `listIncomeSources(db)`.
  - `generateOccurrences(db, opts: { todayIso: string; cadence: Cadence; graceDays: number }): { billsCreated: number; incomeCreated: number }` — idempotent; horizon is the end of the period after today; floor is today − 31 days (a definition added mid-period still gets that period's earlier occurrence; the lookback bounds back-fill); a debt bill whose latest `account_terms` has `next_due_date` takes that date, `min_payment` as expected, `last_statement_balance` on the occurrence, and window `[last_statement_date ?? due − 25, due + grace]`; other bills use `[due − 10, due + grace]`; income uses `[due − 5, due + grace]`.
  - `DEBT_WINDOW_BEFORE = 25`, `BILL_WINDOW_BEFORE = 10`, `INCOME_WINDOW_BEFORE = 5`

- [ ] **Step 1: Failing tests**

`schedule.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { dueDatesBetween } from './schedule';

describe('dueDatesBetween', () => {
	it('monthly clamps to month end and stays inside the range', () => {
		expect(dueDatesBetween({ cadence: 'monthly', dueDay: 31 }, '2026-01-15', '2026-04-10'))
			.toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
	});
	it('semi-monthly emits both days', () => {
		expect(dueDatesBetween({ cadence: 'semi_monthly', dueDay: 1, dueDay2: 15 }, '2026-02-01', '2026-03-01'))
			.toEqual(['2026-02-01', '2026-02-15', '2026-03-01']);
	});
	it('every N weeks steps from the anchor', () => {
		expect(dueDatesBetween({ cadence: 'every_n_weeks', interval: 2, anchorDate: '2026-01-02' }, '2026-01-10', '2026-02-15'))
			.toEqual(['2026-01-16', '2026-01-30', '2026-02-13']);
	});
	it('yearly repeats the anchor month and day', () => {
		expect(dueDatesBetween({ cadence: 'yearly', anchorDate: '2024-06-20' }, '2026-01-01', '2027-12-31'))
			.toEqual(['2026-06-20', '2027-06-20']);
	});
});
```

`bills.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, bills, billOccurrences, connections, incomeOccurrences } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, systemCategoryId } from '../ledger/categories';
import { ensurePeriods } from '../budget/periods';
import { appendTermsIfChanged } from '../sync/connections';
import { createBill, createIncomeSource, listBills } from './bills';
import { generateOccurrences } from './schedule';

let db: Db; let chk: number; let card: number; let rentCat: number; let cardEnv: number;
const TODAY = '2026-09-08';
const gen = () => generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });

beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-12-31');
	const c = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get().id;
	chk = db.insert(accounts).values({ connectionId: c, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
	card = db.insert(accounts).values({ connectionId: c, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
	rentCat = createCategory(db, { groupId: createGroup(db, 'Bills'), name: 'Rent', kind: 'bill' });
	cardEnv = createCategory(db, { groupId: createGroup(db, 'Debt'), name: 'Card', kind: 'debt_payment', accountId: card });
});

describe('generateOccurrences', () => {
	it('creates monthly occurrences through the next period, idempotently, with bill windows', () => {
		createBill(db, { name: 'Rent', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 225000, cadence: 'monthly', dueDay: 1, matchPattern: 'landlord' });
		// today Sep 8 → current period Sep 1-15, horizon = end of Sep 16-30; floor = Aug 8. Only Sep 1 qualifies.
		expect(gen()).toEqual({ billsCreated: 1, incomeCreated: 0 });
		expect(gen()).toEqual({ billsCreated: 0, incomeCreated: 0 });
		const rows = db.select().from(billOccurrences).all().sort((a, b) => a.dueDate.localeCompare(b.dueDate));
		expect(rows.map((r) => r.dueDate)).toEqual(['2026-09-01']);
		expect(rows[0].windowStart).toBe('2026-08-22');
		expect(rows[0].windowEnd).toBe('2026-09-04');
		expect(rows[0].expectedAmount).toBe(225000);
		expect(rows[0].status).toBe('pending');
	});
	it('a debt bill follows account terms: due date, minimum, statement balance, statement window', () => {
		createBill(db, { name: 'Card', categoryId: cardEnv, payFromAccountId: chk, expectedAmount: 5000, cadence: 'monthly', dueDay: 20, linkedDebtAccountId: card });
		appendTermsIfChanged(db, card, { asOf: TODAY, minPayment: 3560, nextDueDate: '2026-09-26', lastStatementBalance: 1177095, lastStatementDate: '2026-09-01', source: 'provider' });
		expect(gen().billsCreated).toBe(1);
		const o = db.select().from(billOccurrences).get()!;
		expect(o.dueDate).toBe('2026-09-26');
		expect(o.expectedAmount).toBe(3560);
		expect(o.statementBalance).toBe(1177095);
		expect(o.windowStart).toBe('2026-09-01');
		expect(o.windowEnd).toBe('2026-09-29');
	});
	it('back-fills at most 31 days for a new definition', () => {
		createBill(db, { name: 'New', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 100, cadence: 'semi_monthly', dueDay: 5, dueDay2: 20 });
		gen();
		// floor Aug 8, horizon Sep 30: Aug 5 is out, Aug 20 / Sep 5 / Sep 20 are in
		expect(db.select().from(billOccurrences).all().map((r) => r.dueDate).sort()).toEqual(['2026-08-20', '2026-09-05', '2026-09-20']);
	});
	it('generates income occurrences with the income window', () => {
		createIncomeSource(db, { name: 'Salary', categoryId: systemCategoryId(db, 'income'), depositAccountId: chk, expectedAmount: 319200, cadence: 'semi_monthly', dueDay: 15, dueDay2: 30, matchPattern: 'employer' });
		expect(gen().incomeCreated).toBe(4); // floor Aug 8 .. horizon Sep 30
		const rows = db.select().from(incomeOccurrences).all().map((r) => r.dueDate).sort();
		expect(rows).toEqual(['2026-08-15', '2026-08-30', '2026-09-15', '2026-09-30']);
	});
	it('lists bills with their category and account', () => {
		createBill(db, { name: 'Rent', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 1, cadence: 'monthly', dueDay: 1 });
		expect(listBills(db)[0]).toMatchObject({ name: 'Rent', payFromAccountId: chk });
	});
});
```

- [ ] **Step 2: Run to verify failure** — both files: FAIL, modules not found.

- [ ] **Step 3: Implement `bills.ts`**

```ts
import { asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { bills, incomeSources, type BillCadence } from '../db/schema';
import { nowIso } from '$lib/dates';

export type NewBill = {
	name: string; categoryId: number; payFromAccountId: number; expectedAmount: number;
	toleranceAbs?: number; tolerancePct?: number; cadence: BillCadence; dueDay?: number | null; dueDay2?: number | null;
	interval?: number | null; anchorDate?: string | null; autopay?: boolean; matchPattern?: string | null; linkedDebtAccountId?: number | null;
};
export type NewIncome = {
	name: string; categoryId: number; depositAccountId: number; expectedAmount: number;
	toleranceAbs?: number; tolerancePct?: number; cadence: BillCadence; dueDay?: number | null; dueDay2?: number | null;
	interval?: number | null; anchorDate?: string | null; matchPattern?: string | null;
};
const touch = () => ({ updatedAt: nowIso() });

export function createBill(db: DbOrTx, input: NewBill): number {
	return db.insert(bills).values({
		name: input.name, categoryId: input.categoryId, payFromAccountId: input.payFromAccountId, expectedAmount: input.expectedAmount,
		toleranceAbs: input.toleranceAbs ?? 0, tolerancePct: input.tolerancePct ?? 0, cadence: input.cadence,
		dueDay: input.dueDay ?? null, dueDay2: input.dueDay2 ?? null, interval: input.interval ?? null, anchorDate: input.anchorDate ?? null,
		autopay: input.autopay ?? false, matchPattern: input.matchPattern ?? null, linkedDebtAccountId: input.linkedDebtAccountId ?? null
	}).returning({ id: bills.id }).get().id;
}
export function updateBill(db: DbOrTx, id: number, patch: Partial<NewBill>): void {
	db.update(bills).set({ ...patch, ...touch() }).where(eq(bills.id, id)).run();
}
export function setBillActive(db: DbOrTx, id: number, active: boolean): void {
	db.update(bills).set({ active, ...touch() }).where(eq(bills.id, id)).run();
}
export function listBills(db: DbOrTx) {
	return db.select().from(bills).orderBy(asc(bills.name)).all();
}

export function createIncomeSource(db: DbOrTx, input: NewIncome): number {
	return db.insert(incomeSources).values({
		name: input.name, categoryId: input.categoryId, depositAccountId: input.depositAccountId, expectedAmount: input.expectedAmount,
		toleranceAbs: input.toleranceAbs ?? 0, tolerancePct: input.tolerancePct ?? 0, cadence: input.cadence,
		dueDay: input.dueDay ?? null, dueDay2: input.dueDay2 ?? null, interval: input.interval ?? null, anchorDate: input.anchorDate ?? null,
		matchPattern: input.matchPattern ?? null
	}).returning({ id: incomeSources.id }).get().id;
}
export function updateIncomeSource(db: DbOrTx, id: number, patch: Partial<NewIncome>): void {
	db.update(incomeSources).set({ ...patch, ...touch() }).where(eq(incomeSources.id, id)).run();
}
export function setIncomeActive(db: DbOrTx, id: number, active: boolean): void {
	db.update(incomeSources).set({ active, ...touch() }).where(eq(incomeSources.id, id)).run();
}
export function listIncomeSources(db: DbOrTx) {
	return db.select().from(incomeSources).orderBy(asc(incomeSources.name)).all();
}
```

- [ ] **Step 4: Implement `schedule.ts`**

```ts
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { bills, billOccurrences, incomeSources, incomeOccurrences, type BillCadence } from '../db/schema';
import { ensurePeriods, periodIdForDate, periodBoundsFor, nextPeriodStart, type Cadence } from '../budget/periods';
import { latestTerms } from '../sync/connections';
import { addDays, compareIso, endOfMonth, isoDate, parseIso } from '$lib/dates';

export const DEBT_WINDOW_BEFORE = 25;
export const BILL_WINDOW_BEFORE = 10;
export const INCOME_WINDOW_BEFORE = 5;
const LOOKBACK_DAYS = 31;

export type Schedule = { cadence: BillCadence; dueDay?: number | null; dueDay2?: number | null; interval?: number | null; anchorDate?: string | null };

function clampDay(year: number, month0: number, day: number): string {
	const first = isoDate(new Date(Date.UTC(year, month0, 1)));
	const eom = endOfMonth(first);
	const d = Math.min(day, +eom.slice(8, 10));
	return `${first.slice(0, 8)}${String(d).padStart(2, '0')}`;
}

/** Due dates inside [fromIso, throughIso], ascending. Pure. */
export function dueDatesBetween(s: Schedule, fromIso: string, throughIso: string): string[] {
	const out: string[] = [];
	const inRange = (d: string) => compareIso(d, fromIso) >= 0 && compareIso(d, throughIso) <= 0;
	if (s.cadence === 'monthly' || s.cadence === 'semi_monthly') {
		const days = s.cadence === 'monthly' ? [s.dueDay ?? 1] : [s.dueDay ?? 1, s.dueDay2 ?? 15];
		const start = parseIso(fromIso), end = parseIso(throughIso);
		for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) {
			const m0 = y === start.getUTCFullYear() ? start.getUTCMonth() : 0;
			const m1 = y === end.getUTCFullYear() ? end.getUTCMonth() : 11;
			for (let m = m0; m <= m1; m++) for (const day of days) { const d = clampDay(y, m, day); if (inRange(d)) out.push(d); }
		}
	} else if (s.cadence === 'every_n_weeks') {
		const step = (s.interval ?? 1) * 7;
		let d = s.anchorDate ?? fromIso;
		while (compareIso(d, fromIso) < 0) d = addDays(d, step);
		while (compareIso(d, throughIso) <= 0) { out.push(d); d = addDays(d, step); }
	} else if (s.cadence === 'yearly') {
		const anchor = s.anchorDate ?? fromIso;
		const y0 = +fromIso.slice(0, 4), y1 = +throughIso.slice(0, 4);
		for (let y = y0; y <= y1; y++) { const d = clampDay(y, +anchor.slice(5, 7) - 1, +anchor.slice(8, 10)); if (inRange(d)) out.push(d); }
	}
	return [...new Set(out)].sort();
}

export function generateOccurrences(db: DbOrTx, opts: { todayIso: string; cadence: Cadence; graceDays: number }): { billsCreated: number; incomeCreated: number } {
	const current = periodBoundsFor(opts.cadence, opts.todayIso);
	const horizonEnd = periodBoundsFor(opts.cadence, nextPeriodStart(opts.cadence, current.endDate)).endDate;
	const lookback = addDays(opts.todayIso, -LOOKBACK_DAYS);
	ensurePeriods(db, opts.cadence, lookback, horizonEnd);
	let billsCreated = 0, incomeCreated = 0;

	for (const b of db.select().from(bills).where(eq(bills.active, true)).all()) {
		const floor = lookback;
		const existing = new Set(db.select({ d: billOccurrences.dueDate }).from(billOccurrences).where(eq(billOccurrences.billId, b.id)).all().map((r) => r.d));
		const terms = b.linkedDebtAccountId != null ? latestTerms(db, b.linkedDebtAccountId) : null;
		const isDebt = b.linkedDebtAccountId != null;
		let plan: { due: string; expected: number; statement: number | null; windowStart: string }[];
		if (isDebt && terms?.nextDueDate) {
			const due = terms.nextDueDate;
			plan = compareIso(due, floor) >= 0 && compareIso(due, horizonEnd) <= 0
				? [{ due, expected: terms.minPayment ?? b.expectedAmount, statement: terms.lastStatementBalance ?? null,
					windowStart: terms.lastStatementDate ?? addDays(due, -DEBT_WINDOW_BEFORE) }]
				: [];
		} else {
			plan = dueDatesBetween(b, floor, horizonEnd).map((due) => ({
				due, expected: b.expectedAmount, statement: null, windowStart: addDays(due, -(isDebt ? DEBT_WINDOW_BEFORE : BILL_WINDOW_BEFORE))
			}));
		}
		for (const p of plan) {
			if (existing.has(p.due)) continue;
			db.insert(billOccurrences).values({
				billId: b.id, dueDate: p.due, periodId: periodIdForDate(db, p.due), expectedAmount: p.expected, statementBalance: p.statement,
				windowStart: p.windowStart, windowEnd: addDays(p.due, opts.graceDays)
			}).run();
			billsCreated++;
		}
	}

	for (const s of db.select().from(incomeSources).where(eq(incomeSources.active, true)).all()) {
		const floor = lookback;
		const existing = new Set(db.select({ d: incomeOccurrences.dueDate }).from(incomeOccurrences).where(eq(incomeOccurrences.incomeSourceId, s.id)).all().map((r) => r.d));
		for (const due of dueDatesBetween(s, floor, horizonEnd)) {
			if (existing.has(due)) continue;
			db.insert(incomeOccurrences).values({
				incomeSourceId: s.id, dueDate: due, periodId: periodIdForDate(db, due), expectedAmount: s.expectedAmount,
				windowStart: addDays(due, -INCOME_WINDOW_BEFORE), windowEnd: addDays(due, opts.graceDays)
			}).run();
			incomeCreated++;
		}
	}
	return { billsCreated, incomeCreated };
}
```

- [ ] **Step 5: Run to verify pass** — `npx vitest run src/lib/server/bills/` → PASS (4 + 5). Then `npm test`, `npm run check`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/bills/
git commit -m "feat: bill and income definitions with occurrence generation"
```

---

### Task 7: Matching, overdue, manual actions, and unwinding removals

**Files:**
- Create: `src/lib/server/bills/matching.ts`
- Test: `src/lib/server/bills/matching.test.ts`

**Interfaces:**
- Consumes: bills/income tables; `billOccurrenceTransactions`; `transactions` (with `transferPeerId` self-join via `alias`); `addDays`, `compareIso`, `parseIso`; `nowIso`.
- Produces:
  - `matchBillOccurrences(db, todayIso): { matched: number; tied: number }` — occurrences in due-date order (§6.2 claim order), status pending or overdue, `marked_by` not manual. Debt bills link every transfer whose peer is on the linked account inside the window; other bills pick the best candidate by amount distance then date distance, a tie flags the occurrence `needs_review` (`bill_match_tied`) and links nothing. Paid when `paid ≥ expected − tolerance`, where tolerance = `toleranceAbs + expected × tolerancePct / 100`.
  - `matchIncomeOccurrences(db, todayIso): { matched: number }`
  - `markOverdue(db, todayIso, graceDays): number` — pending, not manual, `dueDate < today − grace` → overdue.
  - `markOccurrencePaid(db, occurrenceId, opts?: { transactionId?: number | null; amount?: number | null })`, `unmarkOccurrence(db, occurrenceId)`, `skipOccurrence(db, occurrenceId)` — all set `marked_by = 'manual'`.
  - `unwindRemovedTransactions(db, transactionIds: number[]): { reopened: number }` — spec §5.7: auto-marked occurrences lose the link and are recomputed; manual marks stay.
  - `matchAll(db, opts: { todayIso: string; graceDays: number })` — overdue, then bills, then income; returns the three results.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, billOccurrences, billOccurrenceTransactions, connections, incomeOccurrences } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, systemCategoryId } from '../ledger/categories';
import { ensurePeriods } from '../budget/periods';
import { createTransaction, linkTransfer, softDelete, getTransaction } from '../ledger/transactions';
import { createBill, createIncomeSource } from './bills';
import { generateOccurrences } from './schedule';
import { matchBillOccurrences, matchIncomeOccurrences, markOverdue, markOccurrencePaid, unmarkOccurrence, skipOccurrence, unwindRemovedTransactions } from './matching';

let db: Db; let chk: number; let card: number; let rentCat: number; let cardEnv: number;
const TODAY = '2026-09-08';
const mk = (accountId: number, ext: string, amount: number, postedDate: string, payeeRaw: string) =>
	createTransaction(db, { accountId, externalId: ext, postedDate, amount, payeeRaw, source: 'sync' });
const occ = () => db.select().from(billOccurrences).all().sort((a, b) => a.dueDate.localeCompare(b.dueDate));

beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-12-31');
	const c = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get().id;
	chk = db.insert(accounts).values({ connectionId: c, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
	card = db.insert(accounts).values({ connectionId: c, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
	rentCat = createCategory(db, { groupId: createGroup(db, 'Bills'), name: 'Rent', kind: 'bill' });
	cardEnv = createCategory(db, { groupId: createGroup(db, 'Debt'), name: 'Card', kind: 'debt_payment', accountId: card });
});

describe('bill matching', () => {
	it('matches a bill by payee and amount within tolerance and marks it paid', () => {
		createBill(db, { name: 'Rent', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 225000, toleranceAbs: 100, cadence: 'monthly', dueDay: 1, matchPattern: 'landlord' });
		generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });
		const t = mk(chk, 'r', -225000, '2026-08-30', 'LANDLORD LLC');
		expect(matchBillOccurrences(db, TODAY)).toEqual({ matched: 1, tied: 0 });
		const o = occ()[0];
		expect(o.status).toBe('paid');
		expect(o.paidAmount).toBe(225000);
		expect(o.markedBy).toBe('auto');
		expect(db.select().from(billOccurrenceTransactions).all()).toEqual([{ billOccurrenceId: o.id, transactionId: t }]);
		expect(getTransaction(db, t).splits[0].categoryId).toBe(rentCat);
	});
	it('a debt bill sums every transfer to the linked card in the window and records the extra', () => {
		createBill(db, { name: 'Card', categoryId: cardEnv, payFromAccountId: chk, expectedAmount: 3500, cadence: 'monthly', dueDay: 15, linkedDebtAccountId: card });
		generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });
		const min = mk(chk, 'm', -3500, '2026-09-02', 'CHASE PAYMENT'); const minPeer = mk(card, 'mp', 3500, '2026-09-02', 'PAYMENT');
		const extra = mk(chk, 'e', -66700, '2026-09-05', 'CHASE PAYMENT'); const extraPeer = mk(card, 'ep', 66700, '2026-09-05', 'PAYMENT');
		linkTransfer(db, min, minPeer); linkTransfer(db, extra, extraPeer);
		matchBillOccurrences(db, TODAY);
		const o = occ().find((x) => x.dueDate === '2026-09-15')!;
		expect(o.status).toBe('paid');
		expect(o.paidAmount).toBe(70200);
		expect(o.extraAmount).toBe(66700);
	});
	it('the earlier occurrence claims a payment inside two overlapping windows', () => {
		createBill(db, { name: 'Card', categoryId: cardEnv, payFromAccountId: chk, expectedAmount: 3500, cadence: 'monthly', dueDay: 15, linkedDebtAccountId: card });
		generateOccurrences(db, { todayIso: '2026-09-20', cadence: 'semi_monthly', graceDays: 3 }); // Sep 15 and Oct 15; windows Aug 21-Sep 18 and Sep 20-Oct 18
		db.update(billOccurrences).set({ windowEnd: '2026-09-25' }).where(eq(billOccurrences.dueDate, '2026-09-15')).run(); // force overlap
		const p = mk(chk, 'p', -3500, '2026-09-22', 'PAYMENT'); const pp = mk(card, 'pp', 3500, '2026-09-22', 'PAYMENT');
		linkTransfer(db, p, pp);
		matchBillOccurrences(db, '2026-09-20');
		const [sep, oct] = occ();
		expect(sep.status).toBe('paid');
		expect(oct.status).toBe('pending');
	});
	it('a tie flags the occurrence and links nothing', () => {
		createBill(db, { name: 'Water', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 9773, toleranceAbs: 500, cadence: 'monthly', dueDay: 12, matchPattern: 'water' });
		generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });
		mk(chk, 'a', -9773, '2026-09-10', 'CITY WATER'); mk(chk, 'b', -9773, '2026-09-10', 'CITY WATER');
		expect(matchBillOccurrences(db, TODAY)).toEqual({ matched: 0, tied: 1 });
		expect(occ().find((o) => o.dueDate === '2026-09-12')!.needsReview).toBe(true);
	});
	it('marks overdue after grace and skips manual marks', () => {
		createBill(db, { name: 'Rent', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 1, cadence: 'monthly', dueDay: 1 });
		createBill(db, { name: 'Gym', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 1, cadence: 'monthly', dueDay: 28 });
		generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });
		// occurrences by due date: Gym Aug 28, Rent Sep 1, Gym Sep 28; the first two are past Sep 5 (today − grace)
		expect(occ().map((o) => o.dueDate)).toEqual(['2026-08-28', '2026-09-01', '2026-09-28']);
		expect(markOverdue(db, TODAY, 3)).toBe(2);
		expect(occ()[1].status).toBe('overdue');
		markOccurrencePaid(db, occ()[1].id, { amount: 1 });
		expect(occ()[1]).toMatchObject({ status: 'paid', markedBy: 'manual', paidAmount: 1 });
		unmarkOccurrence(db, occ()[1].id);
		expect(occ()[1]).toMatchObject({ status: 'pending', markedBy: 'manual', paidAmount: 0 });
		skipOccurrence(db, occ()[2].id);
		expect(occ()[2].status).toBe('skipped');
		mk(chk, 'x', -1, '2026-09-01', 'ANY'); // inside Rent's window only, and Rent is manually marked
		expect(matchBillOccurrences(db, TODAY).matched).toBe(0);
		expect(occ()[1].status).toBe('pending');
	});
	it('unwinds an auto match when its transaction is removed', () => {
		createBill(db, { name: 'Rent', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 225000, cadence: 'monthly', dueDay: 1, matchPattern: 'landlord' });
		generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });
		const t = mk(chk, 'r', -225000, '2026-08-30', 'LANDLORD LLC');
		matchBillOccurrences(db, TODAY);
		softDelete(db, t, 'provider_removed');
		expect(unwindRemovedTransactions(db, [t])).toEqual({ reopened: 1 });
		expect(occ()[0]).toMatchObject({ status: 'pending', paidAmount: 0, markedBy: null });
		expect(db.select().from(billOccurrenceTransactions).all()).toEqual([]);
	});
});

describe('income matching', () => {
	it('matches a deposit and records the received amount', () => {
		createIncomeSource(db, { name: 'Salary', categoryId: systemCategoryId(db, 'income'), depositAccountId: chk, expectedAmount: 319200, tolerancePct: 10, cadence: 'semi_monthly', dueDay: 15, dueDay2: 30, matchPattern: 'employer' });
		generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });
		const t = mk(chk, 'pay', 310000, '2026-08-29', 'EMPLOYER INC PAYROLL');
		expect(matchIncomeOccurrences(db, TODAY)).toEqual({ matched: 1 });
		const o = db.select().from(incomeOccurrences).all().find((x) => x.dueDate === '2026-08-30')!;
		expect(o).toMatchObject({ status: 'paid', receivedAmount: 310000, transactionId: t, markedBy: 'auto' });
		expect(getTransaction(db, t).splits[0].categoryId).toBe(systemCategoryId(db, 'income'));
	});
});
```

- [ ] **Step 2: Run to verify failure** — FAIL, module not found.

- [ ] **Step 3: Implement `matching.ts`**

```ts
import { and, asc, eq, gte, inArray, isNull, lte, lt, gt, ne, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { DbOrTx } from '../db';
import { bills, billOccurrences, billOccurrenceTransactions, incomeSources, incomeOccurrences, transactions } from '../db/schema';
import { getTransaction, setSplits } from '../ledger/transactions';
import { addDays, nowIso, parseIso } from '$lib/dates';

const touch = () => ({ updatedAt: nowIso() });
const dayDiff = (a: string, b: string) => Math.abs((parseIso(a).getTime() - parseIso(b).getTime()) / 86_400_000);

function patternMatches(pattern: string | null, payee: string, payeeRaw: string): boolean {
	if (!pattern) return true;
	try { const re = new RegExp(pattern, 'i'); return re.test(payee) || re.test(payeeRaw); }
	catch { const p = pattern.toLowerCase(); return payee.toLowerCase().includes(p) || payeeRaw.toLowerCase().includes(p); }
}
const tolerance = (expected: number, abs: number, pct: number) => abs + Math.round((expected * pct) / 100);
/** marked_by is NULL on fresh occurrences; `ne(col, 'manual')` alone would exclude them. */
const notManual = (col: typeof billOccurrences.markedBy | typeof incomeOccurrences.markedBy) => or(isNull(col), ne(col, 'manual'));

function linkedTransactionIds(db: DbOrTx): Set<number> {
	return new Set(db.select({ id: billOccurrenceTransactions.transactionId }).from(billOccurrenceTransactions).all().map((r) => r.id));
}

function settle(db: DbOrTx, occId: number, expected: number, tolAbs: number, tolPct: number, paid: number, isDebt: boolean, markedBy: 'auto' | 'manual' | null): 'paid' | 'pending' {
	const status = paid >= expected - tolerance(expected, tolAbs, tolPct) && paid > 0 ? 'paid' : 'pending';
	db.update(billOccurrences).set({
		status, paidAmount: paid, extraAmount: isDebt ? Math.max(0, paid - expected) : 0, markedBy: paid > 0 ? markedBy : null, ...touch()
	}).where(eq(billOccurrences.id, occId)).run();
	return status;
}

/** §6.2. Occurrences are visited in due-date order so an earlier one claims a payment first. */
export function matchBillOccurrences(db: DbOrTx, todayIso: string): { matched: number; tied: number } {
	const peer = alias(transactions, 'peer');
	const used = linkedTransactionIds(db);
	let matched = 0, tied = 0;
	const open = db.select({ o: billOccurrences, b: bills }).from(billOccurrences)
		.innerJoin(bills, eq(billOccurrences.billId, bills.id))
		.where(and(inArray(billOccurrences.status, ['pending', 'overdue']), notManual(billOccurrences.markedBy)))
		.orderBy(asc(billOccurrences.dueDate), asc(billOccurrences.id))
		.all();
	for (const { o, b } of open) {
		const rows = db.select({ t: transactions, peerAccountId: peer.accountId }).from(transactions)
			.leftJoin(peer, eq(transactions.transferPeerId, peer.id))
			.where(and(
				eq(transactions.accountId, b.payFromAccountId), isNull(transactions.deletedAt), lt(transactions.amount, 0),
				gte(transactions.postedDate, o.windowStart), lte(transactions.postedDate, o.windowEnd)
			))
			.all()
			.filter((r) => !used.has(r.t.id));

		if (b.linkedDebtAccountId != null) {
			const hits = rows.filter((r) => r.peerAccountId === b.linkedDebtAccountId);
			if (hits.length === 0) continue;
			for (const h of hits) { db.insert(billOccurrenceTransactions).values({ billOccurrenceId: o.id, transactionId: h.t.id }).run(); used.add(h.t.id); }
			const paid = hits.reduce((s, h) => s - h.t.amount, 0) + o.paidAmount;
			if (settle(db, o.id, o.expectedAmount, b.toleranceAbs, b.tolerancePct, paid, true, 'auto') === 'paid') matched++;
			continue;
		}

		const tol = tolerance(o.expectedAmount, b.toleranceAbs, b.tolerancePct);
		const cands = rows
			.filter((r) => Math.abs(-r.t.amount - o.expectedAmount) <= tol && patternMatches(b.matchPattern, r.t.payee, r.t.payeeRaw))
			.map((r) => ({ id: r.t.id, amount: -r.t.amount, dAmt: Math.abs(-r.t.amount - o.expectedAmount), dDate: dayDiff(r.t.postedDate, o.dueDate) }))
			.sort((x, y) => x.dAmt - y.dAmt || x.dDate - y.dDate || x.id - y.id);
		if (cands.length === 0) continue;
		if (cands.length > 1 && cands[0].dAmt === cands[1].dAmt && cands[0].dDate === cands[1].dDate) {
			db.update(billOccurrences).set({ needsReview: true, ...touch() }).where(eq(billOccurrences.id, o.id)).run();
			tied++;
			continue;
		}
		const best = cands[0];
		db.insert(billOccurrenceTransactions).values({ billOccurrenceId: o.id, transactionId: best.id }).run();
		used.add(best.id);
		const t = getTransaction(db, best.id);
		if (t.splits.length === 1 && t.splits[0].categoryId !== b.categoryId) setSplits(db, best.id, [{ categoryId: b.categoryId, amount: t.amount }]);
		if (settle(db, o.id, o.expectedAmount, b.toleranceAbs, b.tolerancePct, best.amount, false, 'auto') === 'paid') matched++;
	}
	return { matched, tied };
}

export function matchIncomeOccurrences(db: DbOrTx, todayIso: string): { matched: number } {
	const used = new Set(db.select({ id: incomeOccurrences.transactionId }).from(incomeOccurrences).all().map((r) => r.id).filter((x): x is number => x != null));
	let matched = 0;
	const open = db.select({ o: incomeOccurrences, s: incomeSources }).from(incomeOccurrences)
		.innerJoin(incomeSources, eq(incomeOccurrences.incomeSourceId, incomeSources.id))
		.where(and(inArray(incomeOccurrences.status, ['pending', 'overdue']), notManual(incomeOccurrences.markedBy)))
		.orderBy(asc(incomeOccurrences.dueDate), asc(incomeOccurrences.id))
		.all();
	for (const { o, s } of open) {
		const tol = tolerance(o.expectedAmount, s.toleranceAbs, s.tolerancePct);
		const cands = db.select().from(transactions)
			.where(and(eq(transactions.accountId, s.depositAccountId), isNull(transactions.deletedAt), gt(transactions.amount, 0),
				gte(transactions.postedDate, o.windowStart), lte(transactions.postedDate, o.windowEnd)))
			.all()
			.filter((t) => !used.has(t.id) && Math.abs(t.amount - o.expectedAmount) <= tol && patternMatches(s.matchPattern, t.payee, t.payeeRaw))
			.sort((x, y) => Math.abs(x.amount - o.expectedAmount) - Math.abs(y.amount - o.expectedAmount) || dayDiff(x.postedDate, o.dueDate) - dayDiff(y.postedDate, o.dueDate) || x.id - y.id);
		if (cands.length === 0) continue;
		const best = cands[0];
		used.add(best.id);
		const full = getTransaction(db, best.id);
		if (full.splits.length === 1 && full.splits[0].categoryId !== s.categoryId) setSplits(db, best.id, [{ categoryId: s.categoryId, amount: full.amount }]);
		db.update(incomeOccurrences).set({ status: 'paid', receivedAmount: best.amount, transactionId: best.id, markedBy: 'auto', ...touch() })
			.where(eq(incomeOccurrences.id, o.id)).run();
		matched++;
	}
	return { matched };
}

export function markOverdue(db: DbOrTx, todayIso: string, graceDays: number): number {
	const cutoff = addDays(todayIso, -graceDays);
	const r1 = db.update(billOccurrences).set({ status: 'overdue', ...touch() })
		.where(and(eq(billOccurrences.status, 'pending'), notManual(billOccurrences.markedBy), lt(billOccurrences.dueDate, cutoff))).run();
	const r2 = db.update(incomeOccurrences).set({ status: 'overdue', ...touch() })
		.where(and(eq(incomeOccurrences.status, 'pending'), notManual(incomeOccurrences.markedBy), lt(incomeOccurrences.dueDate, cutoff))).run();
	return r1.changes + r2.changes;
}

export function markOccurrencePaid(db: DbOrTx, occurrenceId: number, opts: { transactionId?: number | null; amount?: number | null } = {}): void {
	const o = db.select().from(billOccurrences).where(eq(billOccurrences.id, occurrenceId)).get();
	if (!o) throw new Error(`occurrence ${occurrenceId} not found`);
	db.transaction((tx) => {
		let paid = opts.amount ?? o.expectedAmount;
		if (opts.transactionId != null) {
			tx.insert(billOccurrenceTransactions).values({ billOccurrenceId: occurrenceId, transactionId: opts.transactionId }).onConflictDoNothing().run();
			if (opts.amount == null) paid = -getTransaction(tx, opts.transactionId).amount;
		}
		const b = tx.select().from(bills).where(eq(bills.id, o.billId)).get()!;
		tx.update(billOccurrences).set({
			status: 'paid', paidAmount: paid, extraAmount: b.linkedDebtAccountId != null ? Math.max(0, paid - o.expectedAmount) : 0,
			markedBy: 'manual', needsReview: false, ...touch()
		}).where(eq(billOccurrences.id, occurrenceId)).run();
	});
}

export function unmarkOccurrence(db: DbOrTx, occurrenceId: number): void {
	db.transaction((tx) => {
		tx.delete(billOccurrenceTransactions).where(eq(billOccurrenceTransactions.billOccurrenceId, occurrenceId)).run();
		tx.update(billOccurrences).set({ status: 'pending', paidAmount: 0, extraAmount: 0, markedBy: 'manual', needsReview: false, ...touch() })
			.where(eq(billOccurrences.id, occurrenceId)).run();
	});
}

export function skipOccurrence(db: DbOrTx, occurrenceId: number): void {
	db.update(billOccurrences).set({ status: 'skipped', markedBy: 'manual', needsReview: false, ...touch() }).where(eq(billOccurrences.id, occurrenceId)).run();
}

/** §5.7: a removed transaction releases auto-matched occurrences; manual marks stay. */
export function unwindRemovedTransactions(db: DbOrTx, transactionIds: number[]): { reopened: number } {
	if (transactionIds.length === 0) return { reopened: 0 };
	let reopened = 0;
	db.transaction((tx) => {
		const links = tx.select().from(billOccurrenceTransactions).where(inArray(billOccurrenceTransactions.transactionId, transactionIds)).all();
		for (const link of links) {
			const o = tx.select().from(billOccurrences).where(eq(billOccurrences.id, link.billOccurrenceId)).get()!;
			if (o.markedBy === 'manual') continue;
			tx.delete(billOccurrenceTransactions)
				.where(and(eq(billOccurrenceTransactions.billOccurrenceId, o.id), eq(billOccurrenceTransactions.transactionId, link.transactionId))).run();
			const remaining = tx.select({ id: billOccurrenceTransactions.transactionId }).from(billOccurrenceTransactions).where(eq(billOccurrenceTransactions.billOccurrenceId, o.id)).all();
			const paid = remaining.reduce((s, r) => s - getTransaction(tx, r.id).amount, 0);
			const b = tx.select().from(bills).where(eq(bills.id, o.billId)).get()!;
			if (settle(tx, o.id, o.expectedAmount, b.toleranceAbs, b.tolerancePct, paid, b.linkedDebtAccountId != null, 'auto') === 'pending') reopened++;
		}
		const inc = tx.select().from(incomeOccurrences).where(and(inArray(incomeOccurrences.transactionId, transactionIds), notManual(incomeOccurrences.markedBy))).all();
		for (const o of inc) {
			tx.update(incomeOccurrences).set({ status: 'pending', receivedAmount: 0, transactionId: null, markedBy: null, ...touch() }).where(eq(incomeOccurrences.id, o.id)).run();
			reopened++;
		}
	});
	return { reopened };
}

export function matchAll(db: DbOrTx, opts: { todayIso: string; graceDays: number }) {
	const overdue = markOverdue(db, opts.todayIso, opts.graceDays);
	const billsResult = matchBillOccurrences(db, opts.todayIso);
	const income = matchIncomeOccurrences(db, opts.todayIso);
	return { overdue, bills: billsResult, income };
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/server/bills/matching.test.ts` → PASS (7). Then `npm test`, `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/bills/matching.ts src/lib/server/bills/matching.test.ts
git commit -m "feat: bill and income matching, overdue, manual actions, unwind"
```

---

### Task 8: Post-processing orchestrator and provider category map

**Files:**
- Create: `src/lib/server/sync/postprocess.ts`
- Test: `src/lib/server/sync/postprocess.test.ts`

**Interfaces:**
- Consumes: `unprocessedWhere`, `markProcessed`, `getTransaction`, `setSplits`; `applyPayeeRules`; `detectTransfers`; `matchAll`; `getSetting`/`setSetting`; `uncategorizedId`.
- Produces:
  - `PROVIDER_CATEGORY_MAP_KEY = 'provider_category_map'`; `setProviderCategoryMap(db, map: Record<string, number>)`, `getProviderCategoryMap(db): Record<string, number>`
  - `processUnprocessed(db, opts: { todayIso: string; graceDays: number; transferWindowDays: number }): { processed: number; renamed: number; categorized: number; linked: number; flagged: number; billsMatched: number; incomeMatched: number }` — spec §5.6 order: payee rules → transfer detection → bill and income matching → default category from the provider map (only when the single split is still Uncategorized) → `processed_at`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, connections } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, uncategorizedId, systemCategoryId } from '../ledger/categories';
import { ensurePeriods } from '../budget/periods';
import { createTransaction, getTransaction } from '../ledger/transactions';
import { createPayeeRule } from './payees';
import { createBill } from '../bills/bills';
import { generateOccurrences } from '../bills/schedule';
import { processUnprocessed, setProviderCategoryMap } from './postprocess';

let db: Db; let chk: number; let card: number; let groceries: number; let dining: number; let rentCat: number;
const TODAY = '2026-09-08';
const mk = (accountId: number, ext: string, amount: number, postedDate: string, payeeRaw: string, providerCategory: string | null = null) =>
	createTransaction(db, { accountId, externalId: ext, postedDate, amount, payeeRaw, providerCategory, source: 'sync' });

beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-12-31');
	const c = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get().id;
	chk = db.insert(accounts).values({ connectionId: c, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
	card = db.insert(accounts).values({ connectionId: c, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
	const g = createGroup(db, 'Spending');
	groceries = createCategory(db, { groupId: g, name: 'Groceries', kind: 'spending' });
	dining = createCategory(db, { groupId: g, name: 'Dining', kind: 'spending' });
	rentCat = createCategory(db, { groupId: createGroup(db, 'Bills'), name: 'Rent', kind: 'bill' });
});

describe('processUnprocessed', () => {
	it('runs rules, transfers, matching, and the provider map in order and stamps processed_at', () => {
		createPayeeRule(db, { pattern: 'grocer', payee: 'Grocer', categoryId: groceries });
		setProviderCategoryMap(db, { FOOD_AND_DRINK: dining });
		createBill(db, { name: 'Rent', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 225000, cadence: 'monthly', dueDay: 1, matchPattern: 'landlord' });
		generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });

		const a = mk(card, 'a', -4200, '2026-09-03', 'THE GROCER', 'FOOD_AND_DRINK');       // rule wins over provider map
		const b = mk(card, 'b', -1800, '2026-09-03', 'TACO SPOT', 'FOOD_AND_DRINK');        // provider map
		const c = mk(chk, 'c', -25000, '2026-09-04', 'CHASE PAYMENT');                      // transfer pair
		const d = mk(card, 'd', 25000, '2026-09-04', 'PAYMENT THANK YOU');
		const e = mk(chk, 'e', -225000, '2026-09-01', 'LANDLORD LLC');                      // bill
		const f = mk(chk, 'f', -999, '2026-09-05', 'MYSTERY', 'UNKNOWN_CAT');                // stays uncategorized

		const r = processUnprocessed(db, { todayIso: TODAY, graceDays: 3, transferWindowDays: 4 });
		expect(r.processed).toBe(6);
		expect(getTransaction(db, a).payee).toBe('Grocer');
		expect(getTransaction(db, a).splits[0].categoryId).toBe(groceries);
		expect(getTransaction(db, b).splits[0].categoryId).toBe(dining);
		expect(getTransaction(db, c).transferPeerId).toBe(d);
		expect(getTransaction(db, c).splits[0].categoryId).toBe(systemCategoryId(db, 'transfer'));
		expect(getTransaction(db, e).splits[0].categoryId).toBe(rentCat);
		expect(getTransaction(db, f).splits[0].categoryId).toBe(uncategorizedId(db));
		for (const id of [a, b, c, d, e, f]) expect(getTransaction(db, id).processedAt).not.toBeNull();
		expect(processUnprocessed(db, { todayIso: TODAY, graceDays: 3, transferWindowDays: 4 }).processed).toBe(0);
	});
});
```

- [ ] **Step 2: Run to verify failure** — FAIL, module not found.

- [ ] **Step 3: Implement `postprocess.ts`**

```ts
import type { DbOrTx } from '../db';
import { transactions } from '../db/schema';
import { getTransaction, markProcessed, setSplits, unprocessedWhere } from '../ledger/transactions';
import { uncategorizedId } from '../ledger/categories';
import { getSetting, setSetting } from '../settings';
import { applyPayeeRules } from './payees';
import { detectTransfers } from './transfers';
import { matchAll } from '../bills/matching';

export const PROVIDER_CATEGORY_MAP_KEY = 'provider_category_map';

export function getProviderCategoryMap(db: DbOrTx): Record<string, number> {
	return getSetting<Record<string, number>>(db, PROVIDER_CATEGORY_MAP_KEY, {});
}
export function setProviderCategoryMap(db: DbOrTx, map: Record<string, number>): void {
	setSetting(db, PROVIDER_CATEGORY_MAP_KEY, map);
}

/** Spec §5.6, over every row with processed_at IS NULL regardless of which run inserted it (§5.1). */
export function processUnprocessed(db: DbOrTx, opts: { todayIso: string; graceDays: number; transferWindowDays: number }) {
	const ids = db.select({ id: transactions.id }).from(transactions).where(unprocessedWhere).all().map((r) => r.id);
	if (ids.length === 0) return { processed: 0, renamed: 0, categorized: 0, linked: 0, flagged: 0, billsMatched: 0, incomeMatched: 0 };

	const rules = applyPayeeRules(db, ids);
	const transfers = detectTransfers(db, ids, { windowDays: opts.transferWindowDays });
	const matches = matchAll(db, { todayIso: opts.todayIso, graceDays: opts.graceDays });

	const map = getProviderCategoryMap(db);
	const uncategorized = uncategorizedId(db);
	let mapped = 0;
	for (const id of ids) {
		const t = getTransaction(db, id);
		if (t.deletedAt || t.transferPeerId != null || t.splits.length !== 1 || t.splits[0].categoryId !== uncategorized) continue;
		const target = t.providerCategory ? map[t.providerCategory] : undefined;
		if (target == null) continue;
		setSplits(db, id, [{ categoryId: target, amount: t.amount }]);
		mapped++;
	}
	markProcessed(db, ids);
	return {
		processed: ids.length, renamed: rules.renamed, categorized: rules.categorized + transfers.categorized + mapped,
		linked: transfers.linked, flagged: transfers.flagged, billsMatched: matches.bills.matched, incomeMatched: matches.income.matched
	};
}
```

`markProcessed` binds one variable per id; chunk it at 500 ids per call inside `processUnprocessed` (a `for` loop over `ids.slice(i, i + 500)`), per the Plan 1A handoff.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/server/sync/postprocess.test.ts` → PASS. Then `npm test`, `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/sync/postprocess.ts src/lib/server/sync/postprocess.test.ts
git commit -m "feat: post-processing orchestrator with provider category map"
```

---

### Task 9: Reconciliation drift and adjustments

**Files:**
- Create: `src/lib/server/reconcile.ts`
- Test: `src/lib/server/reconcile.test.ts`

**Interfaces:**
- Consumes: `accounts`, `transactions`; `latestBalance`; `getSetting`; `createTransaction`, `markProcessed`; `systemCategoryId(db,'reconciliation')`; `CASH_TYPES`.
- Produces:
  - `type PendingConvention = 'exclude_pending' | 'include_pending'`; `PENDING_CONVENTION_KEY = 'pending_convention'` (settings value: `Record<accountId, PendingConvention>`).
  - `conventionFor(db, account): PendingConvention` — override from settings, else cash-type accounts exclude pending, others include (§5.8).
  - `type Drift = { accountId: number; providerBalance: number | null; ledgerBalance: number; drift: number | null; convention: PendingConvention }`
  - `driftForAccount(db, accountId): Drift`, `driftReport(db): Drift[]` (open accounts only)
  - `createAdjustment(db, accountId, amount: number, dateIso: string): number` — `source = 'adjustment'`, reconciliation category, `external_id = adjustment:<dateIso>:<nowIso>`, processed.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from './db';
import { accounts, connections } from './db/schema';
import { seedDefaultCategories } from './ledger/categories';
import { ensurePeriods } from './budget/periods';
import { createTransaction, getTransaction } from './ledger/transactions';
import { appendBalance } from './sync/connections';
import { setSetting } from './settings';
import { driftForAccount, driftReport, createAdjustment, PENDING_CONVENTION_KEY } from './reconcile';

let db: Db; let chk: number; let card: number;
beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-12-31');
	const c = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get().id;
	chk = db.insert(accounts).values({ connectionId: c, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
	card = db.insert(accounts).values({ connectionId: c, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
});

describe('drift', () => {
	it('excludes pending on cash accounts and includes it on cards by default', () => {
		createTransaction(db, { accountId: chk, externalId: 'a', postedDate: '2026-09-01', amount: -1000, payeeRaw: 'A', source: 'sync' });
		createTransaction(db, { accountId: chk, externalId: 'p', postedDate: '2026-09-02', amount: -500, payeeRaw: 'P', pending: true, source: 'sync' });
		appendBalance(db, chk, { asOf: '2026-09-02', current: -1000, source: 'sync' });
		expect(driftForAccount(db, chk)).toEqual({ accountId: chk, providerBalance: -1000, ledgerBalance: -1000, drift: 0, convention: 'exclude_pending' });
		createTransaction(db, { accountId: card, externalId: 'cp', postedDate: '2026-09-02', amount: -700, payeeRaw: 'P', pending: true, source: 'sync' });
		appendBalance(db, card, { asOf: '2026-09-02', current: -700, source: 'sync' });
		expect(driftForAccount(db, card).drift).toBe(0);
	});
	it('honours a per-account override and reports null with no balance row', () => {
		createTransaction(db, { accountId: chk, externalId: 'p', postedDate: '2026-09-02', amount: -500, payeeRaw: 'P', pending: true, source: 'sync' });
		expect(driftForAccount(db, chk).drift).toBeNull();
		appendBalance(db, chk, { asOf: '2026-09-02', current: -500, source: 'sync' });
		expect(driftForAccount(db, chk).drift).toBe(-500);
		setSetting(db, PENDING_CONVENTION_KEY, { [chk]: 'include_pending' });
		expect(driftForAccount(db, chk)).toMatchObject({ drift: 0, convention: 'include_pending' });
		expect(driftReport(db).length).toBe(2);
	});
	it('creates a processed adjustment that closes the drift', () => {
		appendBalance(db, chk, { asOf: '2026-09-02', current: 12345, source: 'sync' });
		const d = driftForAccount(db, chk);
		const id = createAdjustment(db, chk, d.drift!, '2026-09-02');
		const t = getTransaction(db, id);
		expect(t.source).toBe('adjustment');
		expect(t.processedAt).not.toBeNull();
		expect(driftForAccount(db, chk).drift).toBe(0);
	});
});
```

- [ ] **Step 2: Run to verify failure** — FAIL, module not found.

- [ ] **Step 3: Implement `reconcile.ts`**

```ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from './db';
import { accounts, transactions, CASH_TYPES } from './db/schema';
import { latestBalance } from './sync/connections';
import { getSetting } from './settings';
import { createTransaction, markProcessed } from './ledger/transactions';
import { systemCategoryId } from './ledger/categories';
import { nowIso } from '$lib/dates';

export type PendingConvention = 'exclude_pending' | 'include_pending';
export const PENDING_CONVENTION_KEY = 'pending_convention';
export type Drift = { accountId: number; providerBalance: number | null; ledgerBalance: number; drift: number | null; convention: PendingConvention };

export function conventionFor(db: DbOrTx, account: { id: number; type: string }): PendingConvention {
	const overrides = getSetting<Record<string, PendingConvention>>(db, PENDING_CONVENTION_KEY, {});
	return overrides[String(account.id)] ?? ((CASH_TYPES as readonly string[]).includes(account.type) ? 'exclude_pending' : 'include_pending');
}

export function driftForAccount(db: DbOrTx, accountId: number): Drift {
	const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
	if (!account) throw new Error(`account ${accountId} not found`);
	const convention = conventionFor(db, account);
	const where = convention === 'exclude_pending'
		? and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt), eq(transactions.pending, false))
		: and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt));
	const ledgerBalance = db.select({ s: sql<number>`coalesce(sum(${transactions.amount}), 0)` }).from(transactions).where(where).get()?.s ?? 0;
	const bal = latestBalance(db, accountId);
	const providerBalance = bal?.current ?? null;
	return { accountId, providerBalance, ledgerBalance, drift: providerBalance == null ? null : providerBalance - ledgerBalance, convention };
}

export function driftReport(db: DbOrTx): Drift[] {
	return db.select({ id: accounts.id }).from(accounts).where(isNull(accounts.closedAt)).all().map((a) => driftForAccount(db, a.id));
}

export function createAdjustment(db: DbOrTx, accountId: number, amount: number, dateIso: string): number {
	const recon = systemCategoryId(db, 'reconciliation');
	const id = createTransaction(db, {
		accountId, externalId: `adjustment:${dateIso}:${nowIso()}`, postedDate: dateIso, amount,
		payeeRaw: 'Reconciliation adjustment', payee: 'Reconciliation adjustment', source: 'adjustment',
		splits: [{ categoryId: recon, amount }]
	});
	markProcessed(db, [id]);
	return id;
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/server/reconcile.test.ts` → PASS (3). Then `npm test`, `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/reconcile.ts src/lib/server/reconcile.test.ts
git commit -m "feat: reconciliation drift and adjustment transactions"
```

---

### Task 10: The sync runner

**Files:**
- Create: `src/lib/server/sync/runner.ts`
- Test: `src/lib/server/sync/runner.test.ts`

**Interfaces:**
- Consumes: `syncRuns`, `connections` schema; `getConnection`, `getCredential`, `setConnectionStatus`; `applyBatch`; `unwindRemovedTransactions`; `generateOccurrences`; `processUnprocessed`; `getSetting`; `SyncProvider`, `ProviderError`, `FetchMode`; `todayIso`, `nowIso`.
- Produces:
  - `type SyncDeps = { providers: Partial<Record<Provider, SyncProvider>>; appKey: string; cadence: Cadence; timeZone: string; now?: () => string; today?: () => string }`
  - `type RunOutcome = { runId: number | null; connectionId: number; status: 'ok' | 'error' | 'skipped'; error?: string; needsRelink?: boolean; apply?: ApplyResult; processed?: number }`
  - `runSync(db: Db, connectionId: number, trigger: 'cron' | 'manual' | 'startup', mode: FetchMode, deps: SyncDeps): Promise<RunOutcome>` — serialized per connection by an in-process mutex; opens a `sync_runs` row first and closes it last; the fetch is awaited with no database transaction open; a `ProviderError` with `needsRelink` sets the connection to `needs_relink`, any other fetch/apply error sets `error`; after apply: unwind removals, generate occurrences, post-process (and `matchAll` when nothing was unprocessed), then close the run `ok` with counts. A failure after apply has committed closes the run as `error` with the apply counts and the message prefixed `post-processing:` and leaves the connection status and cursor untouched (Task 10 review ruling); `deps.afterApply` is a test-only hook invoked between apply and post-processing.
  - `runAllSyncs(db, trigger, mode, deps): Promise<RunOutcome[]>` — every active connection in id order; one failure never stops the next.
  - `runMaintenance(db, deps): { occurrences: ...; processed: number }` — the startup trigger (§5.1): occurrences and post-processing without any fetch.
  - `lastSuccessfulRun(db): { connectionId: number; finishedAt: string } | null`
  - Settings keys read here: `grace_days` (default 3), `transfer_window_days` (default 4).

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { openMemoryDatabase, type Db } from '../db';
import { connections, syncRuns, transactions } from '../db/schema';
import { seedDefaultCategories } from '../ledger/categories';
import { createConnection } from './connections';
import { emptyBatch, ProviderError, type FetchInput, type SyncBatch, type SyncProvider } from './types';
import { runSync, runAllSyncs, runMaintenance, lastSuccessfulRun, type SyncDeps } from './runner';

const KEY = 'k'.repeat(44);
let db: Db;
const fixedBatch = (): SyncBatch => ({
	...emptyBatch('cur-1'), sendsRemovals: true,
	accounts: [{ externalId: 'chk', name: 'Checking', type: 'checking' }],
	balances: [{ accountExternalId: 'chk', asOf: '2026-09-08', current: 50000 }],
	added: [{ accountExternalId: 'chk', externalId: 't1', postedDate: '2026-09-02', amount: -1200, payeeRaw: 'COFFEE', pending: false }]
});
class FakeProvider implements SyncProvider {
	readonly kind = 'plaid' as const;
	calls: FetchInput[] = [];
	constructor(private impl: (input: FetchInput) => Promise<SyncBatch>) {}
	fetch(input: FetchInput) { this.calls.push(input); return this.impl(input); }
}
const deps = (provider: SyncProvider): SyncDeps => ({
	providers: { plaid: provider }, appKey: KEY, cadence: 'semi_monthly', timeZone: 'UTC',
	now: () => '2026-09-08T03:00:00.000Z', today: () => '2026-09-08'
});

beforeEach(() => { db = openMemoryDatabase().db; seedDefaultCategories(db); });

describe('runSync', () => {
	it('records a run, applies the batch, post-processes, and stores the cursor', async () => {
		const conn = createConnection(db, { provider: 'plaid', institutionName: 'T', credential: 'access-1', appKey: KEY });
		const p = new FakeProvider(async () => fixedBatch());
		const out = await runSync(db, conn, 'manual', 'full', deps(p));
		expect(out.status).toBe('ok');
		expect(out.apply?.added).toBe(1);
		expect(out.processed).toBe(1);
		expect(p.calls[0]).toMatchObject({ credential: 'access-1', cursor: null, mode: 'full', todayIso: '2026-09-08' });
		const run = db.select().from(syncRuns).where(eq(syncRuns.id, out.runId!)).get()!;
		expect(run).toMatchObject({ status: 'ok', trigger: 'manual', startCursor: null, endCursor: 'cur-1', added: 1, balancesWritten: 1 });
		expect(run.finishedAt).toBe('2026-09-08T03:00:00.000Z');
		expect(db.select().from(connections).where(eq(connections.id, conn)).get()!.cursor).toBe('cur-1');
		expect(db.select().from(transactions).all().every((t) => t.processedAt != null)).toBe(true);
		expect(lastSuccessfulRun(db)).toEqual({ connectionId: conn, finishedAt: '2026-09-08T03:00:00.000Z' });
	});
	it('marks the connection needs_relink on an auth error and records the failure', async () => {
		const conn = createConnection(db, { provider: 'plaid', institutionName: 'T', credential: 'x', appKey: KEY });
		const out = await runSync(db, conn, 'cron', 'full', deps(new FakeProvider(async () => { throw new ProviderError('ITEM_LOGIN_REQUIRED', 'relink', true); })));
		expect(out).toMatchObject({ status: 'error', needsRelink: true, error: 'relink' });
		expect(db.select().from(connections).where(eq(connections.id, conn)).get()!.status).toBe('needs_relink');
		expect(db.select().from(syncRuns).get()!).toMatchObject({ status: 'error', error: 'relink' });
	});
	it('records a generic failure without changing the cursor', async () => {
		const conn = createConnection(db, { provider: 'plaid', institutionName: 'T', credential: 'x', appKey: KEY });
		const out = await runSync(db, conn, 'cron', 'full', deps(new FakeProvider(async () => { throw new Error('boom'); })));
		expect(out).toMatchObject({ status: 'error', error: 'boom' });
		expect(db.select().from(connections).where(eq(connections.id, conn)).get()!).toMatchObject({ status: 'error', cursor: null, lastError: 'boom' });
	});
	it('skips a disabled connection', async () => {
		const conn = createConnection(db, { provider: 'plaid', institutionName: 'T', credential: 'x', appKey: KEY });
		db.update(connections).set({ status: 'disabled' }).where(eq(connections.id, conn)).run();
		expect((await runSync(db, conn, 'manual', 'full', deps(new FakeProvider(async () => fixedBatch())))).status).toBe('skipped');
		expect(db.select().from(syncRuns).all().length).toBe(0);
	});
	it('serializes concurrent runs for the same connection', async () => {
		const conn = createConnection(db, { provider: 'plaid', institutionName: 'T', credential: 'x', appKey: KEY });
		const order: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const p = new FakeProvider(async () => { order.push('start'); await gate; order.push('end'); return fixedBatch(); });
		const first = runSync(db, conn, 'cron', 'full', deps(p));
		const second = runSync(db, conn, 'manual', 'full', deps(p));
		await new Promise((r) => setTimeout(r, 5));
		expect(order).toEqual(['start']);
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(['start', 'end', 'start', 'end']);
		expect(db.select().from(syncRuns).all().length).toBe(2);
	});
});

describe('runAllSyncs and maintenance', () => {
	it('continues past a failing connection', async () => {
		const a = createConnection(db, { provider: 'plaid', institutionName: 'A', credential: 'x', appKey: KEY });
		const b = createConnection(db, { provider: 'plaid', institutionName: 'B', credential: 'y', appKey: KEY });
		let n = 0;
		const p = new FakeProvider(async () => { if (n++ === 0) throw new Error('first fails'); return fixedBatch(); });
		const outs = await runAllSyncs(db, 'cron', 'full', deps(p));
		expect(outs.map((o) => [o.connectionId, o.status])).toEqual([[a, 'error'], [b, 'ok']]);
	});
	it('runMaintenance matches occurrences even when nothing is unprocessed', async () => {
		const conn = createConnection(db, { provider: 'plaid', institutionName: 'T', credential: 'x', appKey: KEY });
		await runSync(db, conn, 'manual', 'full', deps(new FakeProvider(async () => fixedBatch())));
		// A bill defined after the sync: its occurrence is generated and must be matched with no new transactions.
		const { createBill } = await import('../bills/bills');
		const { createGroup, createCategory } = await import('../ledger/categories');
		const { accounts, billOccurrences } = await import('../db/schema');
		const chk = db.select().from(accounts).get()!.id;
		const cat = createCategory(db, { groupId: createGroup(db, 'Bills'), name: 'Coffee', kind: 'bill' });
		createBill(db, { name: 'Coffee', categoryId: cat, payFromAccountId: chk, expectedAmount: 1200, cadence: 'monthly', dueDay: 2, matchPattern: 'coffee' });
		const m = runMaintenance(db, deps(new FakeProvider(async () => fixedBatch())));
		expect(m.processed).toBe(0);
		expect(db.select().from(billOccurrences).all().some((o) => o.status === 'paid')).toBe(true);
	});
	it('runMaintenance post-processes rows left unprocessed by a crash', async () => {
		const conn = createConnection(db, { provider: 'plaid', institutionName: 'T', credential: 'x', appKey: KEY });
		await runSync(db, conn, 'manual', 'full', deps(new FakeProvider(async () => fixedBatch())));
		db.update(transactions).set({ processedAt: null }).where(eq(transactions.source, 'sync')).run(); // leave the opening-balance row alone
		expect(runMaintenance(db, deps(new FakeProvider(async () => fixedBatch()))).processed).toBe(1);
	});
});
```

- [ ] **Step 2: Run to verify failure** — FAIL, module not found.

- [ ] **Step 3: Implement `runner.ts`**

```ts
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { syncRuns, type Provider } from '../db/schema';
import type { Cadence } from '../budget/periods';
import { getSetting } from '../settings';
import { getConnection, getCredential, listActiveConnections, setConnectionStatus } from './connections';
import { applyBatch, type ApplyResult } from './apply';
import { processUnprocessed } from './postprocess';
import { generateOccurrences } from '../bills/schedule';
import { matchAll, unwindRemovedTransactions } from '../bills/matching';
import { ProviderError, type FetchMode, type SyncBatch, type SyncProvider } from './types';
import { nowIso, todayIso } from '$lib/dates';

export type SyncDeps = {
	providers: Partial<Record<Provider, SyncProvider>>;
	appKey: string;
	cadence: Cadence;
	timeZone: string;
	now?: () => string;
	today?: () => string;
};
export type RunOutcome = {
	runId: number | null; connectionId: number; status: 'ok' | 'error' | 'skipped';
	error?: string; needsRelink?: boolean; apply?: ApplyResult; processed?: number;
};

const locks = new Map<number, Promise<unknown>>();

/** Per-connection mutex: a run waits for the previous run on the same connection to finish (§5.1). */
async function withLock<T>(connectionId: number, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(connectionId) ?? Promise.resolve();
	const next = prev.catch(() => undefined).then(fn);
	locks.set(connectionId, next);
	try { return await next; }
	finally { if (locks.get(connectionId) === next) locks.delete(connectionId); }
}

function knobs(db: Db) {
	return { graceDays: getSetting(db, 'grace_days', 3), transferWindowDays: getSetting(db, 'transfer_window_days', 4) };
}

export async function runSync(db: Db, connectionId: number, trigger: 'cron' | 'manual' | 'startup', mode: FetchMode, deps: SyncDeps): Promise<RunOutcome> {
	return withLock(connectionId, async () => {
		const now = deps.now ?? nowIso;
		const today = deps.today ?? (() => todayIso(deps.timeZone));
		const conn = getConnection(db, connectionId);
		if (conn.status === 'disabled') return { runId: null, connectionId, status: 'skipped' };

		const runId = db.insert(syncRuns).values({ connectionId, trigger, startedAt: now(), startCursor: conn.cursor }).returning({ id: syncRuns.id }).get().id;
		const fail = (error: string, needsRelink = false): RunOutcome => {
			db.update(syncRuns).set({ status: 'error', finishedAt: now(), error }).where(eq(syncRuns.id, runId)).run();
			setConnectionStatus(db, connectionId, needsRelink ? 'needs_relink' : 'error', error);
			return { runId, connectionId, status: 'error', error, needsRelink };
		};

		// Fetch: async, no database transaction open (§5.1).
		const provider = deps.providers[conn.provider];
		if (!provider) return fail(`no provider registered for ${conn.provider}`);
		let batch: SyncBatch;
		try {
			batch = await provider.fetch({ credential: getCredential(db, connectionId, deps.appKey), cursor: conn.cursor, mode, todayIso: today() });
		} catch (err) {
			const e = err as Error;
			return fail(e.message, err instanceof ProviderError && err.needsRelink);
		}

		// Apply and post-process: synchronous.
		try {
			const apply = applyBatch(db, connectionId, batch, { cadence: deps.cadence, todayIso: today(), mode, now: now() });
			unwindRemovedTransactions(db, apply.removedTransactionIds);
			const k = knobs(db);
			generateOccurrences(db, { todayIso: today(), cadence: deps.cadence, graceDays: k.graceDays });
			const post = processUnprocessed(db, { todayIso: today(), ...k });
			// processUnprocessed returns early with no new rows; newly generated occurrences still need matching (§6.2).
			if (post.processed === 0) matchAll(db, { todayIso: today(), graceDays: k.graceDays });
			db.update(syncRuns).set({
				status: 'ok', finishedAt: now(), endCursor: batch.nextCursor,
				added: apply.added, modified: apply.modified, removed: apply.removed,
				balancesWritten: apply.balancesWritten, termsWritten: apply.termsWritten
			}).where(eq(syncRuns.id, runId)).run();
			return { runId, connectionId, status: 'ok', apply, processed: post.processed };
		} catch (err) {
			return fail((err as Error).message);
		}
	});
}

export async function runAllSyncs(db: Db, trigger: 'cron' | 'manual' | 'startup', mode: FetchMode, deps: SyncDeps): Promise<RunOutcome[]> {
	const out: RunOutcome[] = [];
	for (const c of listActiveConnections(db)) out.push(await runSync(db, c.id, trigger, mode, deps));
	return out;
}

/** Startup trigger (§5.1): occurrences and post-processing with no fetch. */
export function runMaintenance(db: Db, deps: SyncDeps) {
	const today = (deps.today ?? (() => todayIso(deps.timeZone)))();
	const k = knobs(db);
	const occurrences = generateOccurrences(db, { todayIso: today, cadence: deps.cadence, graceDays: k.graceDays });
	const post = processUnprocessed(db, { todayIso: today, ...k });
	if (post.processed === 0) matchAll(db, { todayIso: today, graceDays: k.graceDays });
	return { occurrences, processed: post.processed };
}

export function lastSuccessfulRun(db: Db): { connectionId: number; finishedAt: string } | null {
	const row = db.select({ connectionId: syncRuns.connectionId, finishedAt: syncRuns.finishedAt }).from(syncRuns)
		.where(eq(syncRuns.status, 'ok')).orderBy(desc(syncRuns.finishedAt), desc(syncRuns.id)).get();
	return row && row.finishedAt ? { connectionId: row.connectionId, finishedAt: row.finishedAt } : null;
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/server/sync/runner.test.ts` → PASS (7). Then `npm test`, `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/sync/runner.ts src/lib/server/sync/runner.test.ts
git commit -m "feat: sync runner with per-connection mutex and run records"
```

---

### Task 11: Plaid provider and Link helpers

**Files:**
- Create: `src/lib/server/sync/providers/plaid.ts`
- Test: `src/lib/server/sync/providers/plaid.test.ts`

**Interfaces:**
- Consumes: `SyncProvider`, `SyncBatch`, `ProviderError`, `FetchInput`; `decimalToCents`; `AccountType`; the `plaid` package (`Configuration`, `PlaidApi`, `PlaidEnvironments`).
- Produces:
  - `type PlaidClientLike` — the five methods used, each returning `Promise<{ data: ... }>` (structurally satisfied by `PlaidApi`).
  - `class PlaidProvider implements SyncProvider` — `constructor(client: PlaidClientLike, opts?: { pageSize?: number; maxRestarts?: number })`; `kind = 'plaid'`.
  - `createPlaidClient(cfg: { clientId: string; secret: string; env: 'sandbox' | 'production' }): PlaidApi`
  - `createLinkToken(client, opts: { clientName: string; userId: string; accessToken?: string | null }): Promise<string>` — products `['transactions','liabilities']` for a new Item; update mode passes `access_token` and no products.
  - `exchangePublicToken(client, publicToken: string): Promise<{ accessToken: string; itemId: string }>`
  - `mapPlaidAccountType(type: string, subtype: string | null): AccountType`
  - `plaidErrorCode(err: unknown): string | null`
  - `RELINK_CODES = ['ITEM_LOGIN_REQUIRED', 'INVALID_CREDENTIALS', 'ITEM_NOT_FOUND', 'ACCESS_NOT_GRANTED', 'INVALID_ACCESS_TOKEN']`
  - `MUTATION_CODE = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'`

Mapping rules (spec §2 sign convention, §5.2):
- Account type: `depository/checking → checking`; `depository/savings|money market|cd|hsa|prepaid → savings`; `credit/* → credit`; `loan/* → loan`; `investment|brokerage/* → investment`; anything else `cash`.
- Balances: `current` for `credit` and `loan` is amount owed and becomes negative cents; other types positive. `limit → creditLimit`. `asOf = input.todayIso`.
- Transactions: `amount = −decimalToCents(t.amount)`; `postedDate = t.date`; `transactedAt = t.authorized_datetime ?? (t.authorized_date ? t.authorized_date + 'T00:00:00Z' : null)`; `payeeRaw = t.merchant_name ?? t.name`; `providerCategory = t.personal_finance_category?.primary ?? null`; `pendingExternalId = t.pending_transaction_id`.
- Pagination: `transactionsSync` with `count = pageSize (500)`, loop on `has_more`; buffer pages in memory; on `MUTATION_CODE` clear the buffer and restart from the run-start cursor, at most `maxRestarts` (3) times, then `ProviderError`.
- Liabilities (full mode only): `liabilitiesGet`; credit cards → `aprBps` from `apr_type === 'purchase_apr'`, `promoAprBps` from `'special'`, `minPayment`, `nextDueDate`, `lastStatementBalance`, `lastStatementDate = last_statement_issue_date`; student loans → `aprBps = interest_rate_percentage × 100`, `minPayment`, `nextDueDate`, `lastStatementBalance`; mortgages → `aprBps = interest_rate.percentage × 100`, `minPayment = next_monthly_payment`, `nextDueDate`. Errors `PRODUCT_NOT_READY`, `NO_LIABILITY_ACCOUNTS`, `PRODUCTS_NOT_SUPPORTED` skip terms without failing the run.
- Balances mode: `accountsBalanceGet` → accounts and balances only; `nextCursor = input.cursor`.
- `sendsRemovals = true`, `coversFrom = null`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { PlaidProvider, mapPlaidAccountType, plaidErrorCode, createLinkToken, exchangePublicToken, type PlaidClientLike } from './plaid';
import { ProviderError } from '../types';

type Page = { added?: unknown[]; modified?: unknown[]; removed?: unknown[]; next_cursor: string; has_more: boolean; accounts?: unknown[] };
const account = (id: string, type: string, subtype: string, current: number, limit: number | null = null) =>
	({ account_id: id, name: `${id} name`, official_name: null, mask: '1234', type, subtype, balances: { current, available: null, limit, iso_currency_code: 'USD' } });
const txn = (id: string, acct: string, amount: number, date: string, extra: Record<string, unknown> = {}) =>
	({ transaction_id: id, account_id: acct, amount, date, authorized_date: null, authorized_datetime: null, name: `TX ${id}`, merchant_name: null, pending: false, pending_transaction_id: null, personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'x' }, ...extra });
const plaidErr = (code: string) => Object.assign(new Error(code), { response: { data: { error_code: code, error_type: 'X', error_message: code } } });

function fakeClient(pages: (Page | Error)[], liabilities: unknown = { credit_cards: [], student_loans: [], mortgages: [] }): PlaidClientLike & { syncCalls: unknown[] } {
	const syncCalls: unknown[] = [];
	return {
		syncCalls,
		async transactionsSync(req) {
			syncCalls.push(req);
			const p = pages.shift();
			if (!p) throw new Error('no more pages');
			if (p instanceof Error) throw p;
			return { data: { added: [], modified: [], removed: [], accounts: [], ...p } as never };
		},
		async liabilitiesGet() { return { data: { liabilities: liabilities as never, accounts: [] } as never }; },
		async accountsBalanceGet() { return { data: { accounts: [account('a1', 'depository', 'checking', 123.45)] } as never }; },
		async linkTokenCreate(req) { syncCalls.push({ link: req }); return { data: { link_token: 'link-1' } as never }; },
		async itemPublicTokenExchange(req) { syncCalls.push({ exchange: req }); return { data: { access_token: 'access-9', item_id: 'item-9' } as never }; }
	};
}

describe('PlaidProvider.fetch', () => {
	it('pages through transactionsSync, maps signs and types, and returns the last cursor', async () => {
		const client = fakeClient([
			{ accounts: [account('a1', 'depository', 'checking', 1000.5), account('c1', 'credit', 'credit card', 250.25, 5000)],
			  added: [txn('t1', 'a1', 12.34, '2026-09-02'), txn('t2', 'c1', -20, '2026-09-03', { merchant_name: 'Refund Co', pending: true })],
			  next_cursor: 'c1', has_more: true },
			{ modified: [txn('t1', 'a1', 12.5, '2026-09-02')], removed: [{ transaction_id: 't0', account_id: 'a1' }], next_cursor: 'c2', has_more: false }
		]);
		const b = await new PlaidProvider(client).fetch({ credential: 'access', cursor: null, mode: 'full', todayIso: '2026-09-08' });
		expect(b.accounts).toEqual([
			{ externalId: 'a1', name: 'a1 name', officialName: null, mask: '1234', type: 'checking' },
			{ externalId: 'c1', name: 'c1 name', officialName: null, mask: '1234', type: 'credit' }
		]);
		expect(b.balances).toEqual([
			{ accountExternalId: 'a1', asOf: '2026-09-08', current: 100050, available: null, creditLimit: null },
			{ accountExternalId: 'c1', asOf: '2026-09-08', current: -25025, available: null, creditLimit: 500000 }
		]);
		expect(b.added[0]).toMatchObject({ accountExternalId: 'a1', externalId: 't1', amount: -1234, postedDate: '2026-09-02', payeeRaw: 'TX t1', providerCategory: 'GENERAL_MERCHANDISE', pending: false });
		expect(b.added[1]).toMatchObject({ externalId: 't2', amount: 2000, payeeRaw: 'Refund Co', pending: true });
		expect(b.modified[0]).toMatchObject({ externalId: 't1', amount: -1250 });
		expect(b.removed).toEqual([{ accountExternalId: 'a1', externalId: 't0' }]);
		expect(b.nextCursor).toBe('c2');
		expect(b.sendsRemovals).toBe(true);
		expect((client.syncCalls[1] as { cursor: string }).cursor).toBe('c1');
	});
	it('restarts from the run-start cursor on a mutation error and discards the partial buffer', async () => {
		const client = fakeClient([
			{ added: [txn('x', 'a1', 1, '2026-09-01')], accounts: [account('a1', 'depository', 'checking', 1)], next_cursor: 'p1', has_more: true },
			plaidErr('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'),
			{ added: [txn('y', 'a1', 2, '2026-09-01')], accounts: [account('a1', 'depository', 'checking', 1)], next_cursor: 'q1', has_more: false }
		]);
		const b = await new PlaidProvider(client).fetch({ credential: 'access', cursor: 'start', mode: 'full', todayIso: '2026-09-08' });
		expect(b.added.map((t) => t.externalId)).toEqual(['y']);
		expect((client.syncCalls[2] as { cursor: string }).cursor).toBe('start');
	});
	it('maps a login error to a relink ProviderError', async () => {
		const client = fakeClient([plaidErr('ITEM_LOGIN_REQUIRED')]);
		await expect(new PlaidProvider(client).fetch({ credential: 'access', cursor: null, mode: 'full', todayIso: '2026-09-08' }))
			.rejects.toMatchObject({ code: 'ITEM_LOGIN_REQUIRED', needsRelink: true });
		await expect(new PlaidProvider(fakeClient([plaidErr('RATE_LIMIT_EXCEEDED')])).fetch({ credential: 'access', cursor: null, mode: 'full', todayIso: '2026-09-08' }))
			.rejects.toBeInstanceOf(ProviderError);
	});
	it('maps liabilities into terms', async () => {
		const client = fakeClient(
			[{ accounts: [account('c1', 'credit', 'credit card', 100)], next_cursor: 'c', has_more: false }],
			{ credit_cards: [{ account_id: 'c1', aprs: [{ apr_type: 'purchase_apr', apr_percentage: 27.49 }, { apr_type: 'special', apr_percentage: 0 }],
				minimum_payment_amount: 35.6, next_payment_due_date: '2026-09-26', last_statement_balance: 11770.95, last_statement_issue_date: '2026-09-01', is_overdue: false }],
			  student_loans: [{ account_id: 'l1', interest_rate_percentage: 15.25, minimum_payment_amount: 878.29, next_payment_due_date: '2026-09-21', last_statement_balance: 12989.71 }],
			  mortgages: [] }
		);
		const b = await new PlaidProvider(client).fetch({ credential: 'access', cursor: null, mode: 'full', todayIso: '2026-09-08' });
		expect(b.terms).toEqual([
			{ accountExternalId: 'c1', asOf: '2026-09-08', aprBps: 2749, promoAprBps: 0, minPayment: 3560, nextDueDate: '2026-09-26', lastStatementBalance: 1177095, lastStatementDate: '2026-09-01', annualFee: null },
			{ accountExternalId: 'l1', asOf: '2026-09-08', aprBps: 1525, promoAprBps: null, minPayment: 87829, nextDueDate: '2026-09-21', lastStatementBalance: 1298971, lastStatementDate: null, annualFee: null }
		]);
	});
	it('balances mode only fetches balances and keeps the cursor', async () => {
		const client = fakeClient([]);
		const b = await new PlaidProvider(client).fetch({ credential: 'access', cursor: 'keep', mode: 'balances', todayIso: '2026-09-08' });
		expect(b.balances).toEqual([{ accountExternalId: 'a1', asOf: '2026-09-08', current: 12345, available: null, creditLimit: null }]);
		expect(b.added).toEqual([]);
		expect(b.nextCursor).toBe('keep');
	});
});

describe('helpers', () => {
	it('maps account types', () => {
		expect(mapPlaidAccountType('depository', 'checking')).toBe('checking');
		expect(mapPlaidAccountType('depository', 'money market')).toBe('savings');
		expect(mapPlaidAccountType('credit', 'credit card')).toBe('credit');
		expect(mapPlaidAccountType('loan', 'student')).toBe('loan');
		expect(mapPlaidAccountType('investment', 'brokerage')).toBe('investment');
		expect(mapPlaidAccountType('other', null)).toBe('cash');
	});
	it('reads error codes and drives Link', async () => {
		expect(plaidErrorCode(plaidErr('X'))).toBe('X');
		expect(plaidErrorCode(new Error('plain'))).toBeNull();
		const client = fakeClient([]);
		expect(await createLinkToken(client, { clientName: 'shiso', userId: 'u1' })).toBe('link-1');
		expect(await createLinkToken(client, { clientName: 'shiso', userId: 'u1', accessToken: 'access-1' })).toBe('link-1');
		expect(await exchangePublicToken(client, 'public-1')).toEqual({ accessToken: 'access-9', itemId: 'item-9' });
		expect(client.syncCalls[0]).toMatchObject({ link: { products: ['transactions', 'liabilities'], user: { client_user_id: 'u1' } } });
		expect(client.syncCalls[1]).toMatchObject({ link: { access_token: 'access-1' } });
		expect((client.syncCalls[1] as { link: Record<string, unknown> }).link.products).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run to verify failure** — FAIL, module not found.

- [ ] **Step 3: Implement `plaid.ts`**

```ts
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import type { AccountType } from '../../db/schema';
import { decimalToCents } from '$lib/money';
import { ProviderError, type BatchAccount, type BatchBalance, type BatchTerms, type BatchTransaction, type FetchInput, type SyncBatch, type SyncProvider } from '../types';

// ---- the slice of the Plaid API this provider uses (structurally satisfied by PlaidApi) ----
type PlaidBalances = { current: number | null; available: number | null; limit: number | null };
type PlaidAccount = { account_id: string; name: string; official_name: string | null; mask: string | null; type: string; subtype: string | null; balances: PlaidBalances };
type PlaidTransaction = {
	transaction_id: string; account_id: string; amount: number; date: string; authorized_date: string | null; authorized_datetime?: string | null;
	name: string; merchant_name: string | null; pending: boolean; pending_transaction_id: string | null;
	personal_finance_category?: { primary: string; detailed: string } | null;
};
type SyncData = { added: PlaidTransaction[]; modified: PlaidTransaction[]; removed: { transaction_id: string; account_id: string }[]; next_cursor: string; has_more: boolean; accounts: PlaidAccount[] };
type Apr = { apr_type: string; apr_percentage: number };
type CreditLiability = { account_id: string; aprs: Apr[]; minimum_payment_amount: number | null; next_payment_due_date: string | null; last_statement_balance: number | null; last_statement_issue_date: string | null };
type StudentLiability = { account_id: string; interest_rate_percentage: number | null; minimum_payment_amount: number | null; next_payment_due_date: string | null; last_statement_balance: number | null };
type MortgageLiability = { account_id: string; interest_rate: { percentage: number | null } | null; next_monthly_payment: number | null; next_payment_due_date: string | null };
type LiabilitiesData = { liabilities: { credit_cards?: CreditLiability[] | null; student_loans?: StudentLiability[] | null; mortgages?: MortgageLiability[] | null } };

export type PlaidClientLike = {
	transactionsSync(req: { access_token: string; cursor?: string | null; count?: number; options?: { include_personal_finance_category?: boolean } }): Promise<{ data: SyncData }>;
	liabilitiesGet(req: { access_token: string }): Promise<{ data: LiabilitiesData }>;
	accountsBalanceGet(req: { access_token: string }): Promise<{ data: { accounts: PlaidAccount[] } }>;
	linkTokenCreate(req: Record<string, unknown>): Promise<{ data: { link_token: string } }>;
	itemPublicTokenExchange(req: { public_token: string }): Promise<{ data: { access_token: string; item_id: string } }>;
};

export const RELINK_CODES = ['ITEM_LOGIN_REQUIRED', 'INVALID_CREDENTIALS', 'ITEM_NOT_FOUND', 'ACCESS_NOT_GRANTED', 'INVALID_ACCESS_TOKEN'];
export const MUTATION_CODE = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';
const SKIP_LIABILITY_CODES = ['PRODUCT_NOT_READY', 'NO_LIABILITY_ACCOUNTS', 'PRODUCTS_NOT_SUPPORTED', 'ADDITIONAL_CONSENT_REQUIRED'];

export function plaidErrorCode(err: unknown): string | null {
	const code = (err as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code;
	return typeof code === 'string' ? code : null;
}

function toProviderError(err: unknown): ProviderError {
	const code = plaidErrorCode(err);
	if (code) return new ProviderError(code, (err as { response: { data: { error_message?: string } } }).response.data.error_message ?? code, RELINK_CODES.includes(code));
	return new ProviderError('PLAID_REQUEST_FAILED', (err as Error).message ?? String(err));
}

export function mapPlaidAccountType(type: string, subtype: string | null): AccountType {
	if (type === 'depository') return subtype === 'checking' ? 'checking' : 'savings';
	if (type === 'credit') return 'credit';
	if (type === 'loan') return 'loan';
	if (type === 'investment' || type === 'brokerage') return 'investment';
	return 'cash';
}

const cents = (n: number | null | undefined): number | null => (n == null ? null : decimalToCents(n));
const bps = (pct: number | null | undefined): number | null => (pct == null ? null : Math.round(pct * 100));

function mapAccount(a: PlaidAccount): BatchAccount {
	return { externalId: a.account_id, name: a.name, officialName: a.official_name ?? null, mask: a.mask ?? null, type: mapPlaidAccountType(a.type, a.subtype) };
}
function mapBalance(a: PlaidAccount, asOf: string): BatchBalance {
	const owed = a.type === 'credit' || a.type === 'loan';
	const current = cents(a.balances.current) ?? 0;
	return { accountExternalId: a.account_id, asOf, current: owed ? -current : current, available: cents(a.balances.available), creditLimit: cents(a.balances.limit) };
}
function mapTransaction(t: PlaidTransaction): BatchTransaction {
	return {
		accountExternalId: t.account_id, externalId: t.transaction_id, pendingExternalId: t.pending_transaction_id ?? null,
		postedDate: t.date, transactedAt: t.authorized_datetime ?? (t.authorized_date ? `${t.authorized_date}T00:00:00Z` : null),
		amount: -decimalToCents(t.amount), payeeRaw: t.merchant_name ?? t.name, pending: t.pending,
		providerCategory: t.personal_finance_category?.primary ?? null
	};
}
function mapTerms(l: LiabilitiesData['liabilities'], asOf: string): BatchTerms[] {
	const out: BatchTerms[] = [];
	for (const c of l.credit_cards ?? []) out.push({
		accountExternalId: c.account_id, asOf,
		aprBps: bps(c.aprs.find((a) => a.apr_type === 'purchase_apr')?.apr_percentage), promoAprBps: bps(c.aprs.find((a) => a.apr_type === 'special')?.apr_percentage),
		minPayment: cents(c.minimum_payment_amount), nextDueDate: c.next_payment_due_date ?? null,
		lastStatementBalance: cents(c.last_statement_balance), lastStatementDate: c.last_statement_issue_date ?? null, annualFee: null
	});
	for (const s of l.student_loans ?? []) out.push({
		accountExternalId: s.account_id, asOf, aprBps: bps(s.interest_rate_percentage), promoAprBps: null,
		minPayment: cents(s.minimum_payment_amount), nextDueDate: s.next_payment_due_date ?? null,
		lastStatementBalance: cents(s.last_statement_balance), lastStatementDate: null, annualFee: null
	});
	for (const m of l.mortgages ?? []) out.push({
		accountExternalId: m.account_id, asOf, aprBps: bps(m.interest_rate?.percentage), promoAprBps: null,
		minPayment: cents(m.next_monthly_payment), nextDueDate: m.next_payment_due_date ?? null,
		lastStatementBalance: null, lastStatementDate: null, annualFee: null
	});
	return out;
}

export class PlaidProvider implements SyncProvider {
	readonly kind = 'plaid' as const;
	private readonly pageSize: number;
	private readonly maxRestarts: number;
	constructor(private readonly client: PlaidClientLike, opts: { pageSize?: number; maxRestarts?: number } = {}) {
		this.pageSize = opts.pageSize ?? 500;
		this.maxRestarts = opts.maxRestarts ?? 3;
	}

	async fetch(input: FetchInput): Promise<SyncBatch> {
		if (!input.credential) throw new ProviderError('NO_CREDENTIAL', 'connection has no access token', true);
		const access_token = input.credential;
		if (input.mode === 'balances') {
			let accounts: PlaidAccount[];
			try { accounts = (await this.client.accountsBalanceGet({ access_token })).data.accounts; } catch (err) { throw toProviderError(err); }
			return { accounts: accounts.map(mapAccount), balances: accounts.map((a) => mapBalance(a, input.todayIso)), terms: [], added: [], modified: [], removed: [], nextCursor: input.cursor, sendsRemovals: true, coversFrom: null };
		}

		// Fetch every page before applying anything (§5.2); restart from the run-start cursor on mutation.
		let restarts = 0;
		let pages: SyncData[] = [];
		let cursor = input.cursor;
		for (;;) {
			try {
				const { data } = await this.client.transactionsSync({ access_token, cursor, count: this.pageSize, options: { include_personal_finance_category: true } });
				pages.push(data);
				cursor = data.next_cursor;
				if (!data.has_more) break;
			} catch (err) {
				if (plaidErrorCode(err) === MUTATION_CODE && restarts++ < this.maxRestarts) { pages = []; cursor = input.cursor; continue; }
				throw toProviderError(err);
			}
		}

		let terms: BatchTerms[] = [];
		try { terms = mapTerms((await this.client.liabilitiesGet({ access_token })).data.liabilities, input.todayIso); }
		catch (err) { if (!SKIP_LIABILITY_CODES.includes(plaidErrorCode(err) ?? '')) throw toProviderError(err); }

		const accountsById = new Map<string, PlaidAccount>();
		for (const p of pages) for (const a of p.accounts ?? []) accountsById.set(a.account_id, a);
		const accounts = [...accountsById.values()];
		return {
			accounts: accounts.map(mapAccount),
			balances: accounts.map((a) => mapBalance(a, input.todayIso)),
			terms,
			added: pages.flatMap((p) => p.added.map(mapTransaction)),
			modified: pages.flatMap((p) => p.modified.map(mapTransaction)),
			removed: pages.flatMap((p) => p.removed.map((r) => ({ accountExternalId: r.account_id, externalId: r.transaction_id }))),
			nextCursor: cursor,
			sendsRemovals: true,
			coversFrom: null
		};
	}
}

export function createPlaidClient(cfg: { clientId: string; secret: string; env: 'sandbox' | 'production' }): PlaidApi {
	return new PlaidApi(new Configuration({
		basePath: PlaidEnvironments[cfg.env],
		baseOptions: { headers: { 'PLAID-CLIENT-ID': cfg.clientId, 'PLAID-SECRET': cfg.secret } }
	}));
}

export async function createLinkToken(client: PlaidClientLike, opts: { clientName: string; userId: string; accessToken?: string | null }): Promise<string> {
	const req: Record<string, unknown> = { client_name: opts.clientName, user: { client_user_id: opts.userId }, country_codes: ['US'], language: 'en' };
	if (opts.accessToken) req.access_token = opts.accessToken; else req.products = ['transactions', 'liabilities'];
	try { return (await client.linkTokenCreate(req)).data.link_token; } catch (err) { throw toProviderError(err); }
}

export async function exchangePublicToken(client: PlaidClientLike, publicToken: string): Promise<{ accessToken: string; itemId: string }> {
	try {
		const { data } = await client.itemPublicTokenExchange({ public_token: publicToken });
		return { accessToken: data.access_token, itemId: data.item_id };
	} catch (err) { throw toProviderError(err); }
}
```

Install the dependency first: `npm install plaid@47`. If `PlaidApi` does not structurally satisfy `PlaidClientLike` (Axios response typing), cast at the one construction site in Task 14 (`new PlaidProvider(client as unknown as PlaidClientLike)`) and say so in the report; the fetch logic itself only reads `.data`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/server/sync/providers/plaid.test.ts` → PASS (7). Then `npm test`, `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/lib/server/sync/providers/plaid.ts src/lib/server/sync/providers/plaid.test.ts
git commit -m "feat: plaid provider with cursor pagination, liabilities, and link helpers"
```

---

### Task 12: SimpleFIN provider

**Files:**
- Create: `src/lib/server/sync/providers/simplefin.ts`
- Test: `src/lib/server/sync/providers/simplefin.test.ts`

**Interfaces:**
- Consumes: `SyncProvider`, `SyncBatch`, `ProviderError`; `contentHash`; `decimalToCents`; `addDays`; global `fetch` (injectable).
- Produces:
  - `class SimpleFinProvider implements SyncProvider` — `constructor(fetchImpl?: typeof fetch, opts?: { lookbackDays?: number; initialDays?: number })`; `kind = 'simplefin'`.
  - `claimSetupToken(setupToken: string, fetchImpl?: typeof fetch): Promise<string>` — base64-decode the token to the claim URL, POST it, return the access URL body.
  - `splitAccessUrl(accessUrl: string): { base: string; authorization: string }` — moves URL credentials into a Basic header (undici rejects credentials in URLs).

Protocol facts used (simplefin.org/protocol): `GET {access}/accounts?start-date=<unix>&pending=1`; `balances-only=1` for balance mode. Account: `id, name, currency, balance (decimal string), available-balance, balance-date (unix), org: { name }, transactions: [{ id, posted (unix, 0 while pending), amount (decimal string, account's point of view), description, transacted_at (unix)?, pending? }]`. Signs already match shiso's convention. Mapping: account type defaults to `checking` when the balance is ≥ 0 and `credit` otherwise; the user adjusts type on the Accounts page and `upsertAccount` never overwrites it. `postedDate` from `posted`, or `transacted_at` when `posted` is 0, as a UTC calendar date; `pending = t.pending ?? posted === 0`; `externalId = t.id || contentHash(...)` with the ordinal counting identical id-less rows in the same response. Cursor: the ISO date of the fetch (`todayIso`); `start-date` is `cursor − lookbackDays` (7) or `today − initialDays` (90) when there is no cursor. `sendsRemovals = false`, `coversFrom = start date`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { SimpleFinProvider, claimSetupToken, splitAccessUrl } from './simplefin';

const body = {
	errors: [],
	accounts: [
		{ id: 'A1', name: 'Everyday', currency: 'USD', balance: '1234.56', 'available-balance': '1200.00', 'balance-date': 1757289600, org: { name: 'Bank' },
		  transactions: [
			{ id: 'T1', posted: 1757203200, amount: '-45.10', description: 'GROCER' },
			{ id: '', posted: 0, amount: '-9.99', description: 'Coffee', transacted_at: 1757289600, pending: true },
			{ id: '', posted: 0, amount: '-9.99', description: 'Coffee', transacted_at: 1757289600, pending: true }
		  ] },
		{ id: 'C1', name: 'Store Card', currency: 'USD', balance: '-857.25', 'balance-date': 1757289600, org: { name: 'Synchrony' }, transactions: [] }
	]
};
function fakeFetch(json: unknown, status = 200) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const f = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		return new Response(typeof json === 'string' ? json : JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof fetch;
	return { f, calls };
}

describe('SimpleFinProvider', () => {
	it('sends basic auth, a start date, maps accounts and transactions, hashes id-less rows', async () => {
		const { f, calls } = fakeFetch(body);
		const b = await new SimpleFinProvider(f).fetch({ credential: 'https://user:pw@bridge.simplefin.org/simplefin', cursor: '2026-09-07', mode: 'full', todayIso: '2026-09-08' });
		expect(calls[0].url).toBe('https://bridge.simplefin.org/simplefin/accounts?start-date=1756598400&pending=1'); // 2026-08-31T00:00:00Z
		expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe('Basic ' + Buffer.from('user:pw').toString('base64'));
		expect(b.accounts).toEqual([
			{ externalId: 'A1', name: 'Everyday', officialName: 'Bank', mask: null, type: 'checking' },
			{ externalId: 'C1', name: 'Store Card', officialName: 'Synchrony', mask: null, type: 'credit' }
		]);
		expect(b.balances[0]).toEqual({ accountExternalId: 'A1', asOf: '2026-09-08', current: 123456, available: 120000, creditLimit: null });
		expect(b.added[0]).toMatchObject({ accountExternalId: 'A1', externalId: 'T1', amount: -4510, postedDate: '2026-09-07', pending: false });
		expect(b.added[1].externalId).toMatch(/^h1:/);
		expect(b.added[1]).toMatchObject({ amount: -999, postedDate: '2026-09-08', pending: true });
		expect(b.added[2].externalId).not.toBe(b.added[1].externalId);
		expect(b).toMatchObject({ nextCursor: '2026-09-08', sendsRemovals: false, coversFrom: '2026-08-31' });
	});
	it('uses the initial window without a cursor and balances-only in balances mode', async () => {
		const { f, calls } = fakeFetch(body);
		const p = new SimpleFinProvider(f, { initialDays: 90 });
		await p.fetch({ credential: 'https://u:p@h/simplefin', cursor: null, mode: 'full', todayIso: '2026-09-08' });
		expect(calls[0].url).toContain('start-date=1749600000'); // 2026-06-10
		const b = await p.fetch({ credential: 'https://u:p@h/simplefin', cursor: '2026-09-07', mode: 'balances', todayIso: '2026-09-08' });
		expect(calls[1].url).toContain('balances-only=1');
		expect(b.added).toEqual([]);
		expect(b.nextCursor).toBe('2026-09-07');
	});
	it('maps HTTP 403 to a relink error and other failures to ProviderError', async () => {
		await expect(new SimpleFinProvider(fakeFetch('denied', 403).f).fetch({ credential: 'https://u:p@h/simplefin', cursor: null, mode: 'full', todayIso: '2026-09-08' }))
			.rejects.toMatchObject({ needsRelink: true });
		await expect(new SimpleFinProvider(fakeFetch('oops', 500).f).fetch({ credential: 'https://u:p@h/simplefin', cursor: null, mode: 'full', todayIso: '2026-09-08' }))
			.rejects.toMatchObject({ code: 'SIMPLEFIN_HTTP_500' });
	});
	it('claims a setup token and splits credentials out of the access URL', async () => {
		const claimUrl = 'https://bridge.simplefin.org/simplefin/claim/abc';
		const { f, calls } = fakeFetch('https://user:pw@bridge.simplefin.org/simplefin');
		const access = await claimSetupToken(Buffer.from(claimUrl).toString('base64'), f);
		expect(calls[0]).toMatchObject({ url: claimUrl, init: { method: 'POST' } });
		expect(access).toBe('https://user:pw@bridge.simplefin.org/simplefin');
		expect(splitAccessUrl(access)).toEqual({ base: 'https://bridge.simplefin.org/simplefin', authorization: 'Basic ' + Buffer.from('user:pw').toString('base64') });
	});
});
```

- [ ] **Step 2: Run to verify failure** — FAIL, module not found.

- [ ] **Step 3: Implement `simplefin.ts`**

```ts
import { contentHash } from '../hash';
import { ProviderError, type BatchAccount, type BatchBalance, type BatchTransaction, type FetchInput, type SyncBatch, type SyncProvider } from '../types';
import { decimalToCents } from '$lib/money';
import { addDays, parseIso } from '$lib/dates';

type SfTransaction = { id?: string; posted: number; amount: string; description: string; transacted_at?: number; pending?: boolean };
type SfAccount = { id: string; name: string; currency?: string; balance: string; 'available-balance'?: string; 'balance-date': number; org?: { name?: string }; transactions?: SfTransaction[] };
type SfResponse = { errors?: string[]; accounts: SfAccount[] };

const unixDate = (secs: number) => new Date(secs * 1000).toISOString().slice(0, 10);

export function splitAccessUrl(accessUrl: string): { base: string; authorization: string } {
	const u = new URL(accessUrl);
	const authorization = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
	u.username = ''; u.password = '';
	return { base: u.toString().replace(/\/$/, ''), authorization };
}

export async function claimSetupToken(setupToken: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<string> {
	const claimUrl = Buffer.from(setupToken.trim(), 'base64').toString('utf8');
	if (!/^https?:\/\//.test(claimUrl)) throw new ProviderError('SIMPLEFIN_BAD_SETUP_TOKEN', 'setup token did not decode to a URL');
	const res = await fetchImpl(claimUrl, { method: 'POST' });
	if (!res.ok) throw new ProviderError(`SIMPLEFIN_HTTP_${res.status}`, `claim failed with HTTP ${res.status}`);
	return (await res.text()).trim();
}

export class SimpleFinProvider implements SyncProvider {
	readonly kind = 'simplefin' as const;
	private readonly lookbackDays: number;
	private readonly initialDays: number;
	constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch, opts: { lookbackDays?: number; initialDays?: number } = {}) {
		this.lookbackDays = opts.lookbackDays ?? 7;
		this.initialDays = opts.initialDays ?? 90;
	}

	async fetch(input: FetchInput): Promise<SyncBatch> {
		if (!input.credential) throw new ProviderError('NO_CREDENTIAL', 'connection has no access URL', true);
		const { base, authorization } = splitAccessUrl(input.credential);
		const startIso = input.cursor ? addDays(input.cursor, -this.lookbackDays) : addDays(input.todayIso, -this.initialDays);
		const startUnix = Math.floor(parseIso(startIso).getTime() / 1000);
		const url = input.mode === 'balances'
			? `${base}/accounts?balances-only=1`
			: `${base}/accounts?start-date=${startUnix}&pending=1`;
		const res = await this.fetchImpl(url, { headers: { Authorization: authorization, Accept: 'application/json' } });
		if (res.status === 401 || res.status === 403) throw new ProviderError(`SIMPLEFIN_HTTP_${res.status}`, 'access URL rejected; claim a new setup token', true);
		if (!res.ok) throw new ProviderError(`SIMPLEFIN_HTTP_${res.status}`, `SimpleFIN returned HTTP ${res.status}`);
		const data = (await res.json()) as SfResponse;
		if (data.errors && data.errors.length) throw new ProviderError('SIMPLEFIN_ERRORS', data.errors.join('; '));

		const accounts: BatchAccount[] = [];
		const balances: BatchBalance[] = [];
		const added: BatchTransaction[] = [];
		for (const a of data.accounts) {
			const current = decimalToCents(a.balance);
			accounts.push({ externalId: a.id, name: a.name, officialName: a.org?.name ?? null, mask: null, type: current < 0 ? 'credit' : 'checking' });
			balances.push({ accountExternalId: a.id, asOf: input.todayIso, current, available: a['available-balance'] != null ? decimalToCents(a['available-balance']) : null, creditLimit: null });
			const seen = new Map<string, number>();
			for (const t of a.transactions ?? []) {
				const amount = decimalToCents(t.amount);
				const pending = t.pending ?? t.posted === 0;
				const postedDate = t.posted ? unixDate(t.posted) : unixDate(t.transacted_at ?? Math.floor(Date.now() / 1000));
				let externalId = t.id?.trim() || '';
				if (!externalId) {
					const key = `${postedDate}|${amount}|${t.description}`;
					const ordinal = seen.get(key) ?? 0;
					seen.set(key, ordinal + 1);
					externalId = contentHash({ accountKey: a.id, date: postedDate, amount, description: t.description, ordinal });
				}
				added.push({
					accountExternalId: a.id, externalId, postedDate, transactedAt: t.transacted_at ? new Date(t.transacted_at * 1000).toISOString() : null,
					amount, payeeRaw: t.description, pending, providerCategory: null
				});
			}
		}
		return {
			accounts, balances, terms: [], added, modified: [], removed: [],
			nextCursor: input.mode === 'balances' ? input.cursor : input.todayIso,
			sendsRemovals: false,
			coversFrom: input.mode === 'balances' ? null : startIso
		};
	}
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/server/sync/providers/simplefin.test.ts` → PASS (4). Then `npm test`, `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/sync/providers/simplefin.ts src/lib/server/sync/providers/simplefin.test.ts
git commit -m "feat: simplefin provider with claim flow and content-hash ids"
```

---

### Task 13: CSV import (Apple Card)

**Files:**
- Create: `src/lib/server/sync/import/csv.ts`
- Test: `src/lib/server/sync/import/csv.test.ts`

**Interfaces:**
- Consumes: `csv-parse/sync` `parse`; `contentHash`; `decimalToCents`; `createTransaction`, `InvariantError`; `ensurePeriods`; `Cadence`.
- Produces:
  - `type ParsedRow = { postedDate: string; transactedAt: string | null; amount: number; payeeRaw: string; memo: string | null; providerCategory: string | null }`
  - `parseAppleCardCsv(text: string): ParsedRow[]` — columns `Transaction Date, Clearing Date, Description, Merchant, Category, Type, Amount (USD), Purchased By`; dates `MM/DD/YYYY`; `amount = −decimalToCents(Amount)` (purchases positive in the file, payments negative); `payeeRaw = Merchant || Description`; `memo = Description` when it differs from the merchant; `providerCategory = Category`; throws `Error('unrecognised CSV header')` when the required columns are missing.
  - `importCsv(db: Db, accountId: number, text: string, opts: { cadence: Cadence; todayIso: string }): { created: number; duplicates: number; ids: number[] }` — external ids are `contentHash({ accountKey: 'csv:' + accountId, date, amount, description, ordinal })` so re-importing an overlapping file is idempotent; duplicates are counted, not errors; rows are created with `source: 'import'` and left unprocessed for post-processing.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../../db';
import { accounts, connections, transactions } from '../../db/schema';
import { seedDefaultCategories } from '../../ledger/categories';
import { parseAppleCardCsv, importCsv } from './csv';

const CSV = `Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By
09/01/2026,09/02/2026,APPLE.COM/BILL 866-712-7753 CA,Apple,Other,Purchase,10.59,Justin Robinson
09/03/2026,09/04/2026,"WHOLE FOODS, MKT 10245",Whole Foods,Grocery,Purchase,84.12,Justin Robinson
09/03/2026,09/04/2026,"WHOLE FOODS, MKT 10245",Whole Foods,Grocery,Purchase,84.12,Justin Robinson
09/05/2026,09/05/2026,ACH DEPOSIT INTERNET TRANSFER,ACH DEPOSIT INTERNET TRANSFER,Payment,Payment,-61.00,Justin Robinson
`;

describe('parseAppleCardCsv', () => {
	it('maps rows with the sign convention and ISO dates', () => {
		const rows = parseAppleCardCsv(CSV);
		expect(rows.length).toBe(4);
		expect(rows[0]).toEqual({ postedDate: '2026-09-02', transactedAt: '2026-09-01T00:00:00Z', amount: -1059, payeeRaw: 'Apple', memo: 'APPLE.COM/BILL 866-712-7753 CA', providerCategory: 'Other' });
		expect(rows[3]).toMatchObject({ amount: 6100, payeeRaw: 'ACH DEPOSIT INTERNET TRANSFER', memo: null, providerCategory: 'Payment' });
	});
	it('rejects an unknown header', () => {
		expect(() => parseAppleCardCsv('Date,Amount\n1,2')).toThrowError(/header/);
	});
});

describe('importCsv', () => {
	let db: Db; let card: number;
	beforeEach(() => {
		db = openMemoryDatabase().db;
		seedDefaultCategories(db);
		const c = db.insert(connections).values({ provider: 'manual', institutionName: 'Apple' }).returning({ id: connections.id }).get().id;
		card = db.insert(accounts).values({ connectionId: c, externalId: 'apple', name: 'Apple Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
	});
	it('creates rows once, distinguishes identical lines by ordinal, and is idempotent', () => {
		const r1 = importCsv(db, card, CSV, { cadence: 'semi_monthly', todayIso: '2026-09-08' });
		expect(r1).toMatchObject({ created: 4, duplicates: 0 });
		expect(r1.ids.length).toBe(4);
		const r2 = importCsv(db, card, CSV, { cadence: 'semi_monthly', todayIso: '2026-09-08' });
		expect(r2).toMatchObject({ created: 0, duplicates: 4 });
		const rows = db.select().from(transactions).all();
		expect(rows.length).toBe(4);
		expect(rows.every((t) => t.source === 'import' && t.processedAt === null)).toBe(true);
	});
});
```

- [ ] **Step 2: Run to verify failure** — FAIL, module not found (and `csv-parse` missing: run `npm install csv-parse@7`).

- [ ] **Step 3: Implement `csv.ts`**

```ts
import { parse } from 'csv-parse/sync';
import type { Db } from '../../db';
import { ensurePeriods, periodBoundsFor, nextPeriodStart, type Cadence } from '../../budget/periods';
import { createTransaction } from '../../ledger/transactions';
import { InvariantError } from '../../ledger/errors';
import { contentHash } from '../hash';
import { decimalToCents } from '$lib/money';
import { compareIso } from '$lib/dates';

export type ParsedRow = { postedDate: string; transactedAt: string | null; amount: number; payeeRaw: string; memo: string | null; providerCategory: string | null };

const REQUIRED = ['Transaction Date', 'Clearing Date', 'Description', 'Merchant', 'Category', 'Type', 'Amount (USD)'];

function usDateToIso(s: string): string {
	const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
	if (!m) throw new Error(`bad date: ${s}`);
	return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

export function parseAppleCardCsv(text: string): ParsedRow[] {
	const records = parse(text, { columns: true, skip_empty_lines: true, bom: true, trim: true }) as Record<string, string>[];
	const header = records.length ? Object.keys(records[0]) : text.split(/\r?\n/)[0]?.split(',') ?? [];
	if (!REQUIRED.every((c) => header.includes(c))) throw new Error('unrecognised CSV header: expected Apple Card export columns');
	return records.map((r) => {
		const description = r['Description'].trim();
		const merchant = r['Merchant'].trim();
		return {
			postedDate: usDateToIso(r['Clearing Date']),
			transactedAt: r['Transaction Date'] ? `${usDateToIso(r['Transaction Date'])}T00:00:00Z` : null,
			amount: -decimalToCents(r['Amount (USD)']),
			payeeRaw: merchant || description,
			memo: merchant && description !== merchant ? description : null,
			providerCategory: r['Category']?.trim() || null
		};
	});
}

export function importCsv(db: Db, accountId: number, text: string, opts: { cadence: Cadence; todayIso: string }): { created: number; duplicates: number; ids: number[] } {
	const rows = parseAppleCardCsv(text);
	if (rows.length === 0) return { created: 0, duplicates: 0, ids: [] };
	const earliest = rows.map((r) => r.postedDate).reduce((m, d) => (compareIso(d, m) < 0 ? d : m));
	const next = periodBoundsFor(opts.cadence, nextPeriodStart(opts.cadence, periodBoundsFor(opts.cadence, opts.todayIso).endDate));
	ensurePeriods(db, opts.cadence, earliest, next.endDate);

	const seen = new Map<string, number>();
	let created = 0, duplicates = 0;
	const ids: number[] = [];
	db.transaction((tx) => {
		for (const r of rows) {
			const key = `${r.postedDate}|${r.amount}|${r.memo ?? r.payeeRaw}`;
			const ordinal = seen.get(key) ?? 0;
			seen.set(key, ordinal + 1);
			const externalId = contentHash({ accountKey: `csv:${accountId}`, date: r.postedDate, amount: r.amount, description: r.memo ?? r.payeeRaw, ordinal });
			try {
				ids.push(createTransaction(tx, { accountId, externalId, postedDate: r.postedDate, transactedAt: r.transactedAt, amount: r.amount, payeeRaw: r.payeeRaw, memo: r.memo, providerCategory: r.providerCategory, source: 'import' }));
				created++;
			} catch (err) {
				if (err instanceof InvariantError && err.code === 'DUPLICATE_EXTERNAL_ID') duplicates++;
				else throw err;
			}
		}
	});
	return { created, duplicates, ids };
}
```

A rejected insert inside a savepoint: `createTransaction` opens its own nested transaction, which drizzle rolls back to its savepoint on throw, so the outer transaction continues cleanly for the next row.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/server/sync/import/csv.test.ts` → PASS (3). Then `npm test`, `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/lib/server/sync/import/
git commit -m "feat: apple card csv import with content-hash ids"
```

---

### Task 14: Provider registry, scheduler, API routes, health, startup wiring

**Files:**
- Create: `src/lib/server/sync/providers/index.ts`, `src/lib/server/sync/scheduler.ts`, `src/routes/api/sync/+server.ts`, `src/routes/api/sync/[connectionId]/+server.ts`, `src/routes/api/plaid/link-token/+server.ts`, `src/routes/api/plaid/exchange/+server.ts`, `src/routes/api/simplefin/claim/+server.ts`
- Modify: `src/routes/api/health/+server.ts`, `src/hooks.server.ts`, `src/lib/server/config.ts`, `.env.example`
- Test: `src/lib/server/sync/scheduler.test.ts`, `src/lib/server/sync/providers/index.test.ts`, `src/routes/api/sync/sync.test.ts`, `src/routes/api/health/health.test.ts` (modify)

**Interfaces:**
- Consumes: everything above; `getDb`, `getConfig`, `startup`; `node-cron`.
- Produces:
  - `buildProviders(config: Config): Partial<Record<Provider, SyncProvider>>` — `manual` always; `simplefin` always (global fetch); `plaid` only when both Plaid credentials are set.
  - `buildSyncDeps(config: Config): SyncDeps`; `setSyncDepsForTests(deps: SyncDeps | null)`; `syncDeps(): SyncDeps` (override or built from `getConfig()`).
  - `cronExpressions(config): { full: string; balances: string }` — `0 ${syncHour} * * *` and `0 ${balanceHour} * * *`.
  - `startScheduler(opts: { db: Db; config: Config; deps: SyncDeps; log?: (msg: string) => void }): { stop(): void }` — two `node-cron` tasks with `timezone: config.timeZone`, `noOverlap: true`.
  - `Config.schedulerEnabled: boolean` from `SHISO_SCHEDULER` (default on; `off` disables), `Config.plaidClientName` from `SHISO_PLAID_CLIENT_NAME` (default `shiso`).
  - Routes (JSON in, JSON out):
    - `POST /api/sync` body `{ mode?: 'full' | 'balances' }` → `{ runs: RunOutcome[] }`
    - `POST /api/sync/[connectionId]` body `{ mode? }` → `RunOutcome`; 404 unknown id
    - `POST /api/plaid/link-token` body `{ connectionId?: number }` → `{ linkToken }`; 400 `{ error: 'plaid not configured' }` when no Plaid provider
    - `POST /api/plaid/exchange` body `{ publicToken: string; institutionName: string }` → `{ connectionId, run: RunOutcome }`
    - `POST /api/simplefin/claim` body `{ setupToken: string; institutionName: string }` → `{ connectionId, run: RunOutcome }`
    - `GET /api/health` gains `lastSync: { connectionId, finishedAt } | null`
  - `hooks.server.ts`: after `startup`, call `runMaintenance` (the §5.1 startup trigger), then `startScheduler` when `config.schedulerEnabled`.

- [ ] **Step 1: Config additions**

In `src/lib/server/config.ts` add to `Config`: `schedulerEnabled: boolean; plaidClientName: string;` and in `loadConfig`: `schedulerEnabled: (env.SHISO_SCHEDULER ?? 'on') !== 'off', plaidClientName: env.SHISO_PLAID_CLIENT_NAME || 'shiso'`. Extend `config.test.ts` "applies defaults" with `expect(c.schedulerEnabled).toBe(true); expect(c.plaidClientName).toBe('shiso');` and add a case `SHISO_SCHEDULER: 'off'` → `false`. Update every test `cfg()` literal in `startup.test.ts` and `health.test.ts` with the two new fields. Append to `.env.example`:

```
# Scheduler: set to off to disable the nightly and morning sync jobs (tests, one-off runs).
SHISO_SCHEDULER=on
# Shown by Plaid Link as the app name.
SHISO_PLAID_CLIENT_NAME=shiso
```

- [ ] **Step 2: Failing tests**

`providers/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildProviders, cronExpressions } from './index';
import type { Config } from '../../config';

const base: Config = {
	dbPath: 'x', backupDir: 'y', appKey: 'k'.repeat(40), timeZone: 'America/New_York', migrationsDir: 'drizzle', cadence: 'semi_monthly',
	syncHour: 3, balanceHour: 7, plaid: { clientId: null, secret: null, env: 'sandbox' }, schedulerEnabled: true, plaidClientName: 'shiso'
};
describe('buildProviders', () => {
	it('registers plaid only when configured', () => {
		expect(Object.keys(buildProviders(base)).sort()).toEqual(['manual', 'simplefin']);
		expect(Object.keys(buildProviders({ ...base, plaid: { clientId: 'id', secret: 's', env: 'sandbox' } })).sort()).toEqual(['manual', 'plaid', 'simplefin']);
	});
	it('builds cron expressions from the configured hours', () => {
		expect(cronExpressions(base)).toEqual({ full: '0 3 * * *', balances: '0 7 * * *' });
	});
});
```

`scheduler.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { startScheduler } from './scheduler';

vi.mock('node-cron', () => {
	const tasks: { expr: string; opts: unknown; destroy: () => void }[] = [];
	return {
		default: { schedule: (expr: string, _fn: unknown, opts: unknown) => { const t = { expr, opts, destroy: vi.fn() }; tasks.push(t); return t; } },
		__tasks: tasks
	};
});

describe('startScheduler', () => {
	it('schedules the two jobs in the configured zone and stops them', async () => {
		const cron = (await import('node-cron')) as unknown as { __tasks: { expr: string; opts: { timezone: string; noOverlap: boolean }; destroy: () => void }[] };
		const handle = startScheduler({
			db: {} as never,
			config: { syncHour: 3, balanceHour: 7, timeZone: 'America/New_York' } as never,
			deps: {} as never
		});
		expect(cron.__tasks.map((t) => t.expr)).toEqual(['0 3 * * *', '0 7 * * *']);
		expect(cron.__tasks[0].opts).toMatchObject({ timezone: 'America/New_York', noOverlap: true });
		handle.stop();
		expect(cron.__tasks.every((t) => (t.destroy as unknown as { mock: { calls: unknown[] } }).mock.calls.length === 1)).toBe(true);
	});
});
```

`src/routes/api/sync/sync.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startup, resetForTests } from '$lib/server/startup';
import { setConfig } from '$lib/server/config';
import { setSyncDepsForTests } from '$lib/server/sync/providers';
import { createConnection } from '$lib/server/sync/connections';
import { getDb } from '$lib/server/db/instance';
import { emptyBatch, type SyncProvider } from '$lib/server/sync/types';
import { POST as syncAll } from './+server';
import { POST as syncOne } from './[connectionId]/+server';
import { POST as linkToken } from '../plaid/link-token/+server';

let dir: string;
const cfg = (d: string) => ({
	dbPath: join(d, 'shiso.db'), backupDir: join(d, 'backups'), appKey: 'k'.repeat(40), timeZone: 'America/New_York', migrationsDir: 'drizzle',
	cadence: 'semi_monthly' as const, syncHour: 3, balanceHour: 7, plaid: { clientId: null, secret: null, env: 'sandbox' as const },
	schedulerEnabled: false, plaidClientName: 'shiso'
});
const fake: SyncProvider = { kind: 'plaid', fetch: async (i) => ({ ...emptyBatch('c'), accounts: [{ externalId: 'a', name: 'A', type: 'checking' }], balances: [{ accountExternalId: 'a', asOf: i.todayIso, current: 100 }], sendsRemovals: true }) };
const req = (body: unknown) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'shiso-routes-'));
	const c = cfg(dir); setConfig(c); startup(c, '2026-09-08');
	setSyncDepsForTests({ providers: { plaid: fake }, appKey: c.appKey, cadence: 'semi_monthly', timeZone: 'UTC', today: () => '2026-09-08' });
});
afterEach(() => { setSyncDepsForTests(null); resetForTests(); rmSync(dir, { recursive: true, force: true }); });

describe('sync routes', () => {
	it('runs every active connection and one by id', async () => {
		const id = createConnection(getDb(), { provider: 'plaid', institutionName: 'T', credential: 'x', appKey: 'k'.repeat(40) });
		const all = await (await syncAll({ request: req({}) } as never)).json();
		expect(all.runs.map((r: { status: string }) => r.status)).toEqual(['ok']);
		const one = await (await syncOne({ request: req({ mode: 'balances' }), params: { connectionId: String(id) } } as never)).json();
		expect(one.status).toBe('ok');
		const missing = await syncOne({ request: req({}), params: { connectionId: '999' } } as never);
		expect(missing.status).toBe(404);
	});
	it('rejects link token requests when plaid is not configured', async () => {
		setSyncDepsForTests({ providers: {}, appKey: 'k'.repeat(40), cadence: 'semi_monthly', timeZone: 'UTC' });
		const res = await linkToken({ request: req({}) } as never);
		expect(res.status).toBe(400);
	});
});
```

Modify `health.test.ts`: after startup, `GET` returns `lastSync: null`; the 503 case keeps its assertions.

- [ ] **Step 3: Run to verify failure** — the three new files FAIL on missing modules.

- [ ] **Step 4: Implement `providers/index.ts`**

```ts
import type { Config } from '../../config';
import { getConfig } from '../../config';
import type { Provider } from '../../db/schema';
import type { SyncProvider } from '../types';
import type { SyncDeps } from '../runner';
import { ManualProvider } from './manual';
import { SimpleFinProvider } from './simplefin';
import { PlaidProvider, createPlaidClient, type PlaidClientLike } from './plaid';

export function buildProviders(config: Config): Partial<Record<Provider, SyncProvider>> {
	const providers: Partial<Record<Provider, SyncProvider>> = { manual: new ManualProvider(), simplefin: new SimpleFinProvider() };
	if (config.plaid.clientId && config.plaid.secret) {
		providers.plaid = new PlaidProvider(createPlaidClient({ clientId: config.plaid.clientId, secret: config.plaid.secret, env: config.plaid.env }) as unknown as PlaidClientLike);
	}
	return providers;
}

export function plaidClient(config: Config): PlaidClientLike | null {
	if (!config.plaid.clientId || !config.plaid.secret) return null;
	return createPlaidClient({ clientId: config.plaid.clientId, secret: config.plaid.secret, env: config.plaid.env }) as unknown as PlaidClientLike;
}

export function cronExpressions(config: Pick<Config, 'syncHour' | 'balanceHour'>): { full: string; balances: string } {
	return { full: `0 ${config.syncHour} * * *`, balances: `0 ${config.balanceHour} * * *` };
}

export function buildSyncDeps(config: Config): SyncDeps {
	return { providers: buildProviders(config), appKey: config.appKey, cadence: config.cadence, timeZone: config.timeZone };
}

let override: SyncDeps | null = null;
let cached: SyncDeps | null = null;
export function setSyncDepsForTests(deps: SyncDeps | null): void { override = deps; cached = null; }
export function syncDeps(): SyncDeps {
	if (override) return override;
	if (!cached) cached = buildSyncDeps(getConfig());
	return cached;
}
```

- [ ] **Step 5: Implement `scheduler.ts`**

```ts
import cron from 'node-cron';
import type { Db } from '../db';
import type { Config } from '../config';
import { runAllSyncs, type SyncDeps } from './runner';
import { cronExpressions } from './providers';

export function startScheduler(opts: { db: Db; config: Pick<Config, 'syncHour' | 'balanceHour' | 'timeZone'>; deps: SyncDeps; log?: (msg: string) => void }): { stop(): void } {
	const log = opts.log ?? ((m: string) => console.log(`[shiso sync] ${m}`));
	const exprs = cronExpressions(opts.config);
	const common = { timezone: opts.config.timeZone, noOverlap: true };
	const full = cron.schedule(exprs.full, async () => {
		const runs = await runAllSyncs(opts.db, 'cron', 'full', opts.deps);
		log(`nightly sync: ${runs.map((r) => `${r.connectionId}:${r.status}`).join(' ') || 'no connections'}`);
	}, { ...common, name: 'shiso-full-sync' });
	const balances = cron.schedule(exprs.balances, async () => {
		const runs = await runAllSyncs(opts.db, 'cron', 'balances', opts.deps);
		log(`balance refresh: ${runs.map((r) => `${r.connectionId}:${r.status}`).join(' ') || 'no connections'}`);
	}, { ...common, name: 'shiso-balance-refresh' });
	return { stop() { full.destroy(); balances.destroy(); } };
}
```

- [ ] **Step 6: Implement the routes**

`src/routes/api/sync/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { runAllSyncs } from '$lib/server/sync/runner';
import { syncDeps } from '$lib/server/sync/providers';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const mode = body?.mode === 'balances' ? 'balances' : 'full';
	const runs = await runAllSyncs(getDb(), 'manual', mode, syncDeps());
	return json({ runs });
};
```

`src/routes/api/sync/[connectionId]/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { runSync } from '$lib/server/sync/runner';
import { syncDeps } from '$lib/server/sync/providers';

export const POST: RequestHandler = async ({ request, params }) => {
	const id = Number(params.connectionId);
	if (!Number.isInteger(id)) return json({ error: 'bad connection id' }, { status: 400 });
	const body = await request.json().catch(() => ({}));
	const mode = body?.mode === 'balances' ? 'balances' : 'full';
	try {
		return json(await runSync(getDb(), id, 'manual', mode, syncDeps()));
	} catch (err) {
		if ((err as Error).message?.includes('not found')) return json({ error: 'connection not found' }, { status: 404 });
		throw err;
	}
};
```

`src/routes/api/plaid/link-token/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { plaidClient, syncDeps } from '$lib/server/sync/providers';
import { createLinkToken } from '$lib/server/sync/providers/plaid';
import { getCredential } from '$lib/server/sync/connections';

export const POST: RequestHandler = async ({ request }) => {
	const config = getConfig();
	const client = syncDeps().providers.plaid ? plaidClient(config) : null;
	if (!client) return json({ error: 'plaid not configured' }, { status: 400 });
	const body = await request.json().catch(() => ({}));
	const accessToken = body?.connectionId ? getCredential(getDb(), Number(body.connectionId), config.appKey) : null;
	const linkToken = await createLinkToken(client, { clientName: config.plaidClientName, userId: 'shiso-owner', accessToken });
	return json({ linkToken });
};
```

`src/routes/api/plaid/exchange/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { plaidClient, syncDeps } from '$lib/server/sync/providers';
import { exchangePublicToken } from '$lib/server/sync/providers/plaid';
import { createConnection } from '$lib/server/sync/connections';
import { runSync } from '$lib/server/sync/runner';

export const POST: RequestHandler = async ({ request }) => {
	const config = getConfig();
	const client = plaidClient(config);
	if (!client) return json({ error: 'plaid not configured' }, { status: 400 });
	const body = await request.json().catch(() => null);
	if (!body?.publicToken || !body?.institutionName) return json({ error: 'publicToken and institutionName are required' }, { status: 400 });
	const { accessToken, itemId } = await exchangePublicToken(client, body.publicToken);
	const connectionId = createConnection(getDb(), { provider: 'plaid', institutionName: body.institutionName, externalItemId: itemId, credential: accessToken, appKey: config.appKey });
	const run = await runSync(getDb(), connectionId, 'manual', 'full', syncDeps());
	return json({ connectionId, run });
};
```

`src/routes/api/simplefin/claim/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { claimSetupToken } from '$lib/server/sync/providers/simplefin';
import { createConnection } from '$lib/server/sync/connections';
import { runSync } from '$lib/server/sync/runner';
import { syncDeps } from '$lib/server/sync/providers';

export const POST: RequestHandler = async ({ request }) => {
	const config = getConfig();
	const body = await request.json().catch(() => null);
	if (!body?.setupToken || !body?.institutionName) return json({ error: 'setupToken and institutionName are required' }, { status: 400 });
	const accessUrl = await claimSetupToken(body.setupToken);
	const connectionId = createConnection(getDb(), { provider: 'simplefin', institutionName: body.institutionName, credential: accessUrl, appKey: config.appKey });
	const run = await runSync(getDb(), connectionId, 'manual', 'full', syncDeps());
	return json({ connectionId, run });
};
```

Health route: import `lastSuccessfulRun` from `$lib/server/sync/runner` and return `lastSync: lastSuccessfulRun(db)` in place of `null`.

`src/hooks.server.ts` becomes:

```ts
import type { ServerInit } from '@sveltejs/kit';
import { building } from '$app/environment';
import { env } from '$env/dynamic/private';
import { loadConfig, setConfig } from '$lib/server/config';
import { startup } from '$lib/server/startup';
import { getDb } from '$lib/server/db/instance';
import { runMaintenance } from '$lib/server/sync/runner';
import { buildSyncDeps } from '$lib/server/sync/providers';
import { startScheduler } from '$lib/server/sync/scheduler';
import { todayIso } from '$lib/dates';

export const init: ServerInit = async () => {
	if (building) return;
	const config = loadConfig(env);
	setConfig(config);
	const report = startup(config, todayIso(config.timeZone));
	console.log(`[shiso] database ready; periods created: ${report.periodsCreated}; snapshot: ${report.snapshot ?? 'none'}`);
	const deps = buildSyncDeps(config);
	const m = runMaintenance(getDb(), deps);
	console.log(`[shiso] startup maintenance: ${m.processed} rows post-processed, ${m.occurrences.billsCreated + m.occurrences.incomeCreated} occurrences created`);
	if (config.schedulerEnabled) {
		startScheduler({ db: getDb(), config, deps });
		console.log(`[shiso] scheduler on: full sync at ${config.syncHour}:00, balances at ${config.balanceHour}:00 ${config.timeZone}`);
	}
};
```

Install `node-cron` is already a dependency from Plan 1A; confirm `@types/node-cron` is present (node-cron 4 ships its own types; remove `@types/node-cron` if `npm run check` complains about duplicates).

- [ ] **Step 7: Run everything**

Run: `npm test` → all pass (the two route tests, the scheduler test, providers test, config additions). `npm run check` → 0 errors. Then a real smoke: `SHISO_SCHEDULER=off npm run dev` in the background, `curl -s -X POST localhost:5173/api/sync` → `{"runs":[]}`; `curl -s localhost:5173/api/health` shows `lastSync: null`; stop the server. Include both JSON bodies in the report.

- [ ] **Step 8: Commit**

```bash
git add .env.example src/lib/server/config.ts src/lib/server/config.test.ts src/lib/server/startup.test.ts src/lib/server/sync/providers/index.ts src/lib/server/sync/providers/index.test.ts src/lib/server/sync/scheduler.ts src/lib/server/sync/scheduler.test.ts src/routes/api src/hooks.server.ts package.json package-lock.json
git commit -m "feat: provider registry, cron scheduler, sync and link routes, startup maintenance"
```

---

## Handoff to Plan 1C

Plan 1C (screens, deployment, sheet import) builds on:

- **Reading:** `budgetForPeriod`, `loadBudgetInput` (1A); `driftReport`/`driftForAccount`; `listBills`, `listIncomeSources`, `bill_occurrences`/`income_occurrences` by period; `sync_runs` and `connections` for the Accounts page; `lastSuccessfulRun` for the health strip; transactions where `needs_review = 1` plus non-zero drift for the review queue (§8 Ledger page).
- **Writing, always through services:** `createBill`/`updateBill`/`setBillActive` and the income equivalents; `markOccurrencePaid`/`unmarkOccurrence`/`skipOccurrence`; `createAdjustment`; `createPayeeRule` (offered when a payee is edited); `setProviderCategoryMap`; `appendBalance` with `source: 'manual'`; `appendTermsIfChanged` with `source: 'manual'`; `importCsv` followed by `processUnprocessed` (or `runMaintenance`); `setSetting(db, 'pending_convention', …)` for the per-account drift convention; account edits (name, type, on-budget, closed) need a small `updateAccount` in `connections.ts` that 1C adds.
- **Connecting:** the Accounts page runs Plaid Link in the browser with `POST /api/plaid/link-token` and posts the public token to `POST /api/plaid/exchange`; relink passes `connectionId` to get an update-mode token; SimpleFIN pastes a setup token into `POST /api/simplefin/claim`.
- **Deployment (spec §3.1):** ship `drizzle/` beside `build/` and set `SHISO_MIGRATIONS_DIR`; the systemd unit sets `SHISO_TZ`, `SHISO_SCHEDULER=on`, and the Plaid credentials; the nightly `VACUUM INTO` backup job is not yet implemented and belongs to 1C's deployment task alongside the SIGTERM handler that closes the database.
- **Deferred from the 1A final review, still open:** README rewrite; `@types/better-sqlite3` version drift; closing the SQLite handle when `openDatabase` throws mid-way.
