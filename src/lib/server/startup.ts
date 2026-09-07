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
