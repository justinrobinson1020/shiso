import { eq } from 'drizzle-orm';
import type { DbOrTx } from './db';
import { settings } from './db/schema';
import { nowIso } from '$lib/dates';

export function getSetting<T>(db: DbOrTx, key: string, fallback: T): T {
	const row = db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
	return row ? (row.value as T) : fallback;
}

export const BUDGET_START_KEY = 'budget_start';
/** §P5: the first period the envelope math covers. Null only before the first startup ever created a period. */
export function budgetStart(db: DbOrTx): string | null {
	return getSetting<string | null>(db, BUDGET_START_KEY, null);
}

export function setSetting(db: DbOrTx, key: string, value: unknown): void {
	db.insert(settings)
		.values({ key, value: value as never, updatedAt: nowIso() })
		.onConflictDoUpdate({ target: settings.key, set: { value: value as never, updatedAt: nowIso() } })
		.run();
}
