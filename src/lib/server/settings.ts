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
