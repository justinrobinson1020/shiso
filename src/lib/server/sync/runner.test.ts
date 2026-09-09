import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { openMemoryDatabase, type Db } from '../db';
import { connections, syncRuns, transactions } from '../db/schema';
import { seedDefaultCategories } from '../ledger/categories';
import { createConnection } from './connections';
import { emptyBatch, ProviderError, type FetchInput, type SyncBatch, type SyncProvider } from './types';
import { runSync, runAllSyncs, runMaintenance, lastSuccessfulRuns, type SyncDeps } from './runner';

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
		expect(lastSuccessfulRuns(db)).toEqual([{ connectionId: conn, finishedAt: '2026-09-08T03:00:00.000Z' }]);
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
		// A transient failure must not drop the connection from future scheduled runs.
		const outs = await runAllSyncs(db, 'cron', 'full', deps(new FakeProvider(async () => fixedBatch())));
		expect(outs.map((o) => [o.connectionId, o.status])).toEqual([[conn, 'ok']]);
	});
	it('records a post-apply failure without touching the connection status', async () => {
		const conn = createConnection(db, { provider: 'plaid', institutionName: 'T', credential: 'x', appKey: KEY });
		const out = await runSync(db, conn, 'manual', 'full', {
			...deps(new FakeProvider(async () => fixedBatch())),
			afterApply: () => { throw new Error('boom'); }
		});
		expect(out.status).toBe('error');
		expect(out.error).toBe('post-processing: boom');
		expect(out.apply?.added).toBe(1);
		const run = db.select().from(syncRuns).where(eq(syncRuns.id, out.runId!)).get()!;
		expect(run).toMatchObject({ status: 'error', error: 'post-processing: boom', added: 1, endCursor: 'cur-1' });
		expect(db.select().from(connections).where(eq(connections.id, conn)).get()!).toMatchObject({ status: 'active', cursor: 'cur-1' });
		expect(db.select().from(transactions).all().length).toBeGreaterThan(0);
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
		db.update(transactions).set({ processedAt: null }).where(eq(transactions.source, 'sync')).run();
		expect(runMaintenance(db, deps(new FakeProvider(async () => fixedBatch()))).processed).toBe(1);
	});
});

describe('lastSuccessfulRuns', () => {
	it("reports each connection's newest ok run, ignoring a newer error run on the same connection", async () => {
		const a = createConnection(db, { provider: 'plaid', institutionName: 'A', credential: 'x', appKey: KEY });
		const b = createConnection(db, { provider: 'plaid', institutionName: 'B', credential: 'y', appKey: KEY });
		const depsAt = (now: string, impl: () => Promise<SyncBatch>): SyncDeps => ({ providers: { plaid: new FakeProvider(impl) }, appKey: KEY, cadence: 'semi_monthly', timeZone: 'UTC', now: () => now, today: () => '2026-09-08' });
		await runSync(db, a, 'manual', 'full', depsAt('2026-09-06T03:00:00.000Z', async () => fixedBatch()));
		await runSync(db, b, 'manual', 'full', depsAt('2026-09-07T03:00:00.000Z', async () => fixedBatch()));
		await runSync(db, a, 'cron', 'full', depsAt('2026-09-08T03:00:00.000Z', async () => { throw new Error('boom'); }));
		expect(lastSuccessfulRuns(db)).toEqual([
			{ connectionId: a, finishedAt: '2026-09-06T03:00:00.000Z' },
			{ connectionId: b, finishedAt: '2026-09-07T03:00:00.000Z' }
		]);
	});
	it('is empty when no connection has an ok run', () => {
		expect(lastSuccessfulRuns(db)).toEqual([]);
	});
});
