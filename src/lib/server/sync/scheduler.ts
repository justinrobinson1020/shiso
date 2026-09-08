import cron from 'node-cron';
import type { Db } from '../db';
import type { Config } from '../config';
import { runAllSyncs, type RunOutcome, type SyncDeps } from './runner';
import { cronExpressions } from './providers';

const summary = (runs: RunOutcome[]) => runs.map((r) => `${r.connectionId}:${r.status}`).join(' ') || 'no connections';

/** Two `node-cron` jobs in the configured zone: the nightly full sync and the morning balance refresh (§5.1). */
export function startScheduler(opts: {
	db: Db; config: Pick<Config, 'syncHour' | 'balanceHour' | 'timeZone'>; deps: SyncDeps; log?: (msg: string) => void;
}): { stop(): void } {
	const log = opts.log ?? ((m: string) => console.log(`[shiso sync] ${m}`));
	const exprs = cronExpressions(opts.config);
	const common = { timezone: opts.config.timeZone, noOverlap: true };
	const full = cron.schedule(exprs.full, async () => {
		log(`nightly sync: ${summary(await runAllSyncs(opts.db, 'cron', 'full', opts.deps))}`);
	}, { ...common, name: 'shiso-full-sync' });
	const balances = cron.schedule(exprs.balances, async () => {
		log(`balance refresh: ${summary(await runAllSyncs(opts.db, 'cron', 'balances', opts.deps))}`);
	}, { ...common, name: 'shiso-balance-refresh' });
	return { stop() { full.destroy(); balances.destroy(); } };
}
