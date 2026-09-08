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
	/** Test-only: invoked right after `applyBatch` succeeds, before the post-apply steps. Lets tests inject a post-apply failure. */
	afterApply?: () => void;
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

		// Phase A: apply the batch. On failure, the connection is at fault (fail() as usual).
		let apply: ApplyResult;
		try {
			apply = applyBatch(db, connectionId, batch, { cadence: deps.cadence, todayIso: today(), mode, now: now() });
		} catch (err) {
			return fail((err as Error).message);
		}

		// Phase B: unwind removals, generate occurrences, post-process. applyBatch already committed
		// (recorded success and advanced the cursor), so a failure here is not a connection failure —
		// leave the connection's status alone and record the run as an error with the apply counts.
		try {
			deps.afterApply?.();
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
			const error = `post-processing: ${(err as Error).message}`;
			db.update(syncRuns).set({
				status: 'error', finishedAt: now(), error, endCursor: batch.nextCursor,
				added: apply.added, modified: apply.modified, removed: apply.removed,
				balancesWritten: apply.balancesWritten, termsWritten: apply.termsWritten
			}).where(eq(syncRuns.id, runId)).run();
			return { runId, connectionId, status: 'error', error, apply };
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
