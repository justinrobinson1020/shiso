import { handle, readJson, cents, int } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { setPlannedExtra } from '$lib/server/debt/plan';
export const POST = handle(async ({ request }) => {
	const b = await readJson<Record<string, unknown>>(request);
	setPlannedExtra(getDb(), { periodId: int(b.periodId, 'periodId'), accountId: int(b.accountId, 'accountId'), extraAmount: cents(b.extraAmount, 'extraAmount') });
	return { ok: true };
});
