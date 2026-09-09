import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb, getSqlite } from '$lib/server/db/instance';
import { pendingMigrations } from '$lib/server/db/migrations';
import { periods } from '$lib/server/db/schema';
import { currentPeriodId } from '$lib/server/budget/periods';
import { getConfig } from '$lib/server/config';
import { lastSuccessfulRuns } from '$lib/server/sync/runner';
import { todayIso } from '$lib/dates';
import { eq } from 'drizzle-orm';

export const GET: RequestHandler = () => {
	try {
		const db = getDb();
		const config = getConfig();
		const id = currentPeriodId(db, config.cadence, todayIso(config.timeZone));
		const current = db.select({ label: periods.label }).from(periods).where(eq(periods.id, id)).get();
		return json({
			ok: true,
			db: 'ok',
			pendingMigrations: pendingMigrations(getSqlite(), config.migrationsDir).length,
			currentPeriod: current?.label ?? null,
			lastSync: lastSuccessfulRuns(db)
		});
	} catch (err) {
		// The diagnostic endpoint must report the failure, not become one.
		return json({ ok: false, db: 'error', error: (err as Error).message }, { status: 503 });
	}
};
