import { handle, readJson, cents, int } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { moveMoney } from '$lib/server/ledger/assignments';
export const POST = handle(async ({ request }) => {
	const b = await readJson<{ periodId: unknown; fromCategoryId: unknown; toCategoryId: unknown; amount: unknown }>(request);
	moveMoney(getDb(), int(b.periodId, 'periodId'), int(b.fromCategoryId, 'fromCategoryId'), int(b.toCategoryId, 'toCategoryId'), cents(b.amount, 'amount'));
	return { ok: true };
});
