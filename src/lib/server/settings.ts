import { eq } from 'drizzle-orm';
import type { DbOrTx } from './db';
import { settings } from './db/schema';
import type { PendingConvention } from './reconcile';
import { nowIso } from '$lib/dates';

/** Every settings key and the shape of its stored JSON. A key is only readable or writable through this map. */
export type SettingsMap = {
	grace_days: number;
	transfer_window_days: number;
	budget_start: string | null;
	provider_category_map: Record<string, number>;
	pending_convention: Record<string, PendingConvention>;
};
export type SettingKey = keyof SettingsMap;

export function getSetting<K extends SettingKey>(db: DbOrTx, key: K, fallback: SettingsMap[K]): SettingsMap[K] {
	const row = db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
	// The column is untyped JSON; `setSetting` is the only writer and enforces the shape.
	return row ? (row.value as SettingsMap[K]) : fallback;
}

export const BUDGET_START_KEY = 'budget_start' satisfies SettingKey;
/** §P5: the first period the envelope math covers. Null only before the first startup ever created a period. */
export function budgetStart(db: DbOrTx): string | null {
	return getSetting(db, BUDGET_START_KEY, null);
}

export function setSetting<K extends SettingKey>(db: DbOrTx, key: K, value: SettingsMap[K]): void {
	db.insert(settings)
		.values({ key, value, updatedAt: nowIso() })
		.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: nowIso() } })
		.run();
}
