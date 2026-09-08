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
		const target = t.providerCategory ? map[t.providerCategory] : undefined;
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
