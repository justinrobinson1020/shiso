import { and, desc, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { transactions } from '../db/schema';
import { getTransaction, markProcessed, setSplits, unprocessedWhere } from '../ledger/transactions';
import { uncategorizedId } from '../ledger/categories';
import { getSetting, setSetting } from '../settings';
import { applyPayeeRules } from './payees';
import { detectTransfers } from './transfers';
import { matchAll } from '../bills/matching';

export const PROVIDER_CATEGORY_MAP_KEY = 'provider_category_map';

export function getProviderCategoryMap(db: DbOrTx): Record<string, number> {
	return getSetting<Record<string, number>>(db, PROVIDER_CATEGORY_MAP_KEY, {});
}
export function setProviderCategoryMap(db: DbOrTx, map: Record<string, number>): void {
	setSetting(db, PROVIDER_CATEGORY_MAP_KEY, map);
}

/**
 * Match a Plaid `provider_category` (e.g. `FOOD_AND_DRINK_GROCERIES`) against the map: an exact
 * key wins; otherwise the longest map key that is a prefix of the value up to a `_` boundary
 * (so a mapping on the primary category, e.g. `FOOD_AND_DRINK`, still catches every detailed
 * category under it once no more specific mapping exists).
 */
export function resolveProviderCategory(map: Record<string, number>, providerCategory: string | null): number | undefined {
	if (providerCategory == null) return undefined;
	if (Object.prototype.hasOwnProperty.call(map, providerCategory)) return map[providerCategory];
	let bestKey: string | null = null;
	for (const key of Object.keys(map)) {
		if (providerCategory.startsWith(`${key}_`) && (bestKey == null || key.length > bestKey.length)) bestKey = key;
	}
	return bestKey == null ? undefined : map[bestKey];
}

/** Distinct `provider_category` values seen on live rows, most common first. */
export function providerCategoryUsage(db: DbOrTx): { key: string; count: number }[] {
	const rows = db
		.select({ key: transactions.providerCategory, n: sql<number>`count(*)` })
		.from(transactions)
		.where(and(isNull(transactions.deletedAt), isNotNull(transactions.providerCategory)))
		.groupBy(transactions.providerCategory)
		.orderBy(desc(sql`count(*)`))
		.all();
	return rows.map((r) => ({ key: r.key as string, count: r.n }));
}

/**
 * Re-run the provider category map over every live, non-transfer row that is still a single
 * Uncategorized split — not just rows awaiting postprocessing — so editing the map after the
 * fact can recategorize transactions synced before the mapping existed.
 */
export function applyProviderCategoryMap(db: DbOrTx): { categorized: number } {
	const map = getProviderCategoryMap(db);
	const uncategorized = uncategorizedId(db);
	const candidates = db
		.select({ id: transactions.id, providerCategory: transactions.providerCategory })
		.from(transactions)
		.where(and(isNull(transactions.deletedAt), isNull(transactions.transferPeerId)))
		.all();
	return db.transaction((tx) => {
		let categorized = 0;
		for (const row of candidates) {
			const target = resolveProviderCategory(map, row.providerCategory);
			if (target == null) continue;
			const t = getTransaction(tx, row.id);
			if (t.splits.length !== 1 || t.splits[0].categoryId !== uncategorized) continue;
			setSplits(tx, row.id, [{ categoryId: target, amount: t.amount }]);
			categorized++;
		}
		return { categorized };
	});
}

/** Spec §5.6, over every row with processed_at IS NULL regardless of which run inserted it (§5.1). */
export function processUnprocessed(db: DbOrTx, opts: { todayIso: string; graceDays: number; transferWindowDays: number }) {
	const ids = db.select({ id: transactions.id }).from(transactions).where(unprocessedWhere).all().map((r) => r.id);
	if (ids.length === 0) return { processed: 0, renamed: 0, categorized: 0, linked: 0, flagged: 0, billsMatched: 0, incomeMatched: 0 };

	const rules = applyPayeeRules(db, ids);
	const transfers = detectTransfers(db, ids, { windowDays: opts.transferWindowDays });
	const matches = matchAll(db, { todayIso: opts.todayIso, graceDays: opts.graceDays });

	const map = getProviderCategoryMap(db);
	const uncategorized = uncategorizedId(db);
	let mapped = 0;
	for (const id of ids) {
		const t = getTransaction(db, id);
		if (t.deletedAt || t.transferPeerId != null || t.splits.length !== 1 || t.splits[0].categoryId !== uncategorized) continue;
		const target = resolveProviderCategory(map, t.providerCategory);
		if (target == null) continue;
		setSplits(db, id, [{ categoryId: target, amount: t.amount }]);
		mapped++;
	}
	for (let i = 0; i < ids.length; i += 500) {
		markProcessed(db, ids.slice(i, i + 500));
	}
	return {
		processed: ids.length, renamed: rules.renamed, categorized: rules.categorized + transfers.categorized + mapped,
		linked: transfers.linked, flagged: transfers.flagged, billsMatched: matches.bills.matched, incomeMatched: matches.income.matched
	};
}
