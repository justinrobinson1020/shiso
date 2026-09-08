import cron from 'node-cron';
import type Database from 'better-sqlite3';
import type { Db } from '../db';
import type { Config } from '../config';
import { runAllSyncs, type RunOutcome, type SyncDeps } from './runner';
import { cronExpressions } from './providers';
import { backupDatabase, pruneBackups } from '../backup';
import { todayIso } from '$lib/dates';

const summary = (runs: RunOutcome[]) => runs.map((r) => `${r.connectionId}:${r.status}`).join(' ') || 'no connections';

/** Three `node-cron` jobs in the configured zone: the nightly full sync, the morning balance refresh, and the nightly backup (§5.1, §3.1). */
export function startScheduler(opts: {
	db: Db;
	sqlite: Database.Database;
	config: Pick<Config, 'syncHour' | 'balanceHour' | 'backupHour' | 'timeZone' | 'backupDir' | 'backupKeep'>;
	deps: SyncDeps;
	log?: (msg: string) => void;
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
	const backup = cron.schedule(exprs.backup, () => {
		const path = backupDatabase(opts.sqlite, opts.config.backupDir, todayIso(opts.config.timeZone));
		const pruned = pruneBackups(opts.config.backupDir, opts.config.backupKeep);
		log(`backup written: ${path}${pruned.length ? `; pruned ${pruned.length}` : ''}`);
	}, { ...common, name: 'shiso-backup' });
	return { stop() { full.destroy(); balances.destroy(); backup.destroy(); } };
}
