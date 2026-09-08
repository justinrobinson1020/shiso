import { handle, readJson, cents } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { assign } from '$lib/server/ledger/assignments';
export const POST = handle(async ({ request }) => {
	const b = await readJson<{ periodId: unknown; categoryId: unknown; assigned: unknown }>(request);
	assign(getDb(), cents(b.periodId, 'periodId'), cents(b.categoryId, 'categoryId'), cents(b.assigned, 'assigned'));
	return { ok: true };
});
