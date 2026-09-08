import { asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { payeeRules } from '../db/schema';
import { getTransaction, setPayee, setSplits } from '../ledger/transactions';
import { uncategorizedId } from '../ledger/categories';

export type PayeeRule = typeof payeeRules.$inferSelect;

export function createPayeeRule(db: DbOrTx, input: { pattern: string; isRegex?: boolean; payee: string; categoryId?: number | null; priority?: number }): number {
	return db.insert(payeeRules).values({
		pattern: input.pattern, isRegex: input.isRegex ?? false, payee: input.payee,
		categoryId: input.categoryId ?? null, priority: input.priority ?? 100
	}).returning({ id: payeeRules.id }).get().id;
}

export function listPayeeRules(db: DbOrTx): PayeeRule[] {
	return db.select().from(payeeRules).orderBy(asc(payeeRules.priority), asc(payeeRules.id)).all();
}

/** First rule (by priority, then id) whose pattern matches. An invalid regex never matches. */
export function matchPayeeRule(rules: PayeeRule[], payeeRaw: string): PayeeRule | null {
	const sorted = [...rules].sort((a, b) => a.priority - b.priority || a.id - b.id);
	const hay = payeeRaw.toLowerCase();
	for (const r of sorted) {
		if (r.isRegex) {
			try { if (new RegExp(r.pattern, 'i').test(payeeRaw)) return r; } catch { /* invalid pattern: skip */ }
		} else if (hay.includes(r.pattern.toLowerCase())) {
			return r;
		}
	}
	return null;
}

export function applyPayeeRules(db: DbOrTx, transactionIds: number[]): { renamed: number; categorized: number } {
	const rules = listPayeeRules(db);
	const uncategorized = uncategorizedId(db);
	let renamed = 0, categorized = 0;
	for (const id of transactionIds) {
		const t = getTransaction(db, id);
		const rule = matchPayeeRule(rules, t.payeeRaw);
		if (!rule) continue;
		if (t.payee !== rule.payee) { setPayee(db, id, rule.payee); renamed++; }
		if (rule.categoryId != null && t.splits.length === 1 && t.splits[0].categoryId === uncategorized) {
			setSplits(db, id, [{ categoryId: rule.categoryId, amount: t.amount }]);
			categorized++;
		}
	}
	return { renamed, categorized };
}
