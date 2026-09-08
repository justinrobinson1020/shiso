import { eq } from 'drizzle-orm';
import { handle, readJson, intParam, cents, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { setPayee, setMemo, setPeriod, setSplits } from '$lib/server/ledger/transactions';
import { periods } from '$lib/server/db/schema';

export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id'); const db = getDb();
	const b = await readJson<{ payee?: unknown; memo?: unknown; periodId?: unknown; splits?: unknown }>(request);
	db.transaction((tx) => {
		if (b.payee !== undefined) { if (typeof b.payee !== 'string' || !b.payee.trim()) throw new ValidationError('payee must be non-empty'); setPayee(tx, id, b.payee.trim()); }
		if (b.memo !== undefined) { if (b.memo !== null && typeof b.memo !== 'string') throw new ValidationError('memo must be a string or null'); setMemo(tx, id, b.memo); }
		if (b.periodId !== undefined) {
			const periodId = cents(b.periodId, 'periodId');
			if (!tx.select().from(periods).where(eq(periods.id, periodId)).get()) throw new ValidationError('periodId does not exist');
			setPeriod(tx, id, periodId);
		}
		if (b.splits !== undefined) {
			if (!Array.isArray(b.splits) || b.splits.length === 0) throw new ValidationError('splits must be a non-empty array');
			setSplits(tx, id, b.splits.map((s: { categoryId: unknown; amount: unknown; memo?: string | null }, i: number) => ({ categoryId: cents(s.categoryId, `splits[${i}].categoryId`), amount: cents(s.amount, `splits[${i}].amount`), memo: s.memo ?? null })));
		}
	});
	return { ok: true };
});
