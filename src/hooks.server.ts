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
	// The §5.1 startup trigger: occurrences and post-processing with no fetch.
	const m = runMaintenance(getDb(), deps);
	console.log(`[shiso] startup maintenance: ${m.processed} rows post-processed, ${m.occurrences.billsCreated + m.occurrences.incomeCreated} occurrences created`);
	if (config.schedulerEnabled) {
		startScheduler({ db: getDb(), config, deps });
		console.log(`[shiso] scheduler on: full sync at ${config.syncHour}:00, balances at ${config.balanceHour}:00 ${config.timeZone}`);
	}
};
