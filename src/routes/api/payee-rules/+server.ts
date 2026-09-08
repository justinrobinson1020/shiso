import { isNull } from 'drizzle-orm';
import { handle, readJson, cents, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { createPayeeRule, listPayeeRules, matchPayeeRule, applyPayeeRules } from '$lib/server/sync/payees';
import { transactions } from '$lib/server/db/schema';

export const POST = handle(async ({ request }) => {
	const b = await readJson<{ pattern?: string; payee?: string; categoryId?: unknown; isRegex?: boolean; applyToExisting?: boolean }>(request);
	if (!b.pattern?.trim() || !b.payee?.trim()) throw new ValidationError('pattern and payee are required');
	const db = getDb();
	const id = createPayeeRule(db, { pattern: b.pattern.trim(), payee: b.payee.trim(), isRegex: b.isRegex ?? false, categoryId: b.categoryId == null ? null : cents(b.categoryId, 'categoryId') });
	let applied = { renamed: 0, categorized: 0 };
	if (b.applyToExisting) {
		const rule = listPayeeRules(db).find((r) => r.id === id)!;
		const ids = db.select({ id: transactions.id, payeeRaw: transactions.payeeRaw }).from(transactions).where(isNull(transactions.deletedAt)).all()
			.filter((t) => matchPayeeRule([rule], t.payeeRaw) != null).map((t) => t.id);
		applied = applyPayeeRules(db, ids);
	}
	return { id, applied };
});
